# C02 — SSE 原生 D1 快照故障矩阵

2026-09-08；Checklist v1.96。状态：STAGING_PARTIAL。六类线上故障与独立恢复矩阵 PASS；C02.G 仍开放。本地 1,018/1,018 通过，固定安全窗口、精确清理及最终隔离复核全部通过。

## 结算规则与本轮修改

用户确认的成功结算点保持为：**网关验证有效 completed 图片和真实上游 DONE 后，成功结算不可逆；之后客户端取消或交付超时不撤销费用。** 只有 completed、尚无上游 DONE 的情况保持原规则；错误生成的 DONE 不代表成功。成功 DONE 交付前等待账务提交，或已启用耐久恢复路径中的快照及恢复任务持久化确认；最多等待 15 秒，未确认则输出结果不明、不可自动重试的流内错误。生产默认入口未启用耐久 SSE，本轮不改变金额算法或生产资源。

本轮修正的是 staging 探针，不是重新改变上述政策。新 [V2 探针](../../../../packages/proxy/scripts/staging/images-sse-snapshot-fault-v2.ts) 不再把 snapshot INSERT 的 changes 固定断言为 1，也没有把原生结果改写成 1。它保存有界的 success、changes、rowsWritten、identityVerified，要求有效正整数变化数，并使用原生单次 SELECT 比较全部 12 个快照字段及触发器任务的不可变身份。查询只返回布尔值，不再次将大 payload 读入 JavaScript；诊断查询不消费后续仓库的 snapshot/job 读回故障。单个自有探针行的 CAS 仍要求恰好更新一行。

真实 D1 四个已插入场景均直接记录 **changes=2、rowsWritten=9、identityVerified=true**。这是本轮原生返回的观测值，不是由本地实验推断；不能推广为所有 D1 INSERT 的固定结果。Cloudflare 的 changes 与 rows_written 口径不同，触发器及索引工作不能混为一谈。[D1 返回对象](https://developers.cloudflare.com/d1/worker-api/return-object/)、[Cloudflare D1 字段说明](https://developers.cloudflare.com/api/typescript/resources/d1/)、[SQLite total_changes](https://www.sqlite.org/c3ref/total_changes.html)。

## 真实 Workers 结果

仅部署独立 gateway，版本 b76ac31d-4ffd-455d-a0cf-4ba028cb94cf；云端入口 SHA-256 与最终冻结候选完全相同：8524d5d241aa1c93f69a592eadb03d6f87e58cfd5edabde964893abc1821ff36。settings 指纹不变，私有上游、恢复消费者和控制 Worker 未重新部署。按 Workers 最佳实践保留私有 service binding、原始请求流、接收者绑定的 waitUntil、生成类型和发布前 dry-run。[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

| 场景 | 持久化事实与客户端结果 | 结论 |
| --- | --- | --- |
| before-fail | 零 snapshot/job/log，保留 dispatched 测试预算；completed → 未确认 error → DONE | PASS；不自动退款或重放 |
| after-ack-loss | 原生 INSERT 已提交，预期 ACK 丢失标记命中；仓库读回后正常 DONE、唯一日志 | PASS；只结算一次 |
| snapshot-read-fail | snapshot/job 已存在，读回失败，客户端收到未确认错误 | PASS；独立消费者随后补账一次 |
| job-read-fail | snapshot/job 已存在，任务确认失败，客户端收到未确认错误 | PASS；独立消费者随后补账一次 |
| before-hold | 真实交付等待 15,173 ms 后报未确认；暂停超时，零 snapshot/job/log | PASS；保留未知测试预算 |
| after-hold | 真实交付等待 15,136 ms 后报未确认；写入已提交，晚到读回仍结算一次 | PASS；交付超时不撤销费用 |

六个请求各只发送一次合成推理。恢复前 intent/snapshot/job/receipt/log/reservation 数量为 6/4/4/2/2/6；独立控制入口以原生 Access 授权调用命名消费者，扫描/认领/提交各 2，变为 6/4/4/4/4/6。再次调用扫描/认领/提交均 0，完整财务行与第一次恢复后逐字段一致。成功合成账务总额 0.4、未知测试预留 0.2；这是 fixture 账务单位，不是云端实际费用。

## 本地证明与局限

新增版本化测试 83 项加既有 935 项，共 1,018/1,018，零失败、取消、跳过。测试使用本项目真实 SQLite 迁移及触发器，测量同步 SQL 执行前后的 total_changes 增量；不伪造触发器计数，不把本地 rows_written 当作 D1 索引计费模拟。覆盖六类故障、成功点后的取消/abort、真实 15 秒门限、零变化重复 INSERT、无效计数、缺失触发器任务、元数据篡改和原子收尾竞态。

首次新测试为 82/83：缺失触发器用例在启动前删除触发器，被完整 schema 预检提前返回 500；修正测试为在 snapshot INSERT 边界移除触发器。此后定向 2/2 和完整 1,018/1,018 通过，未放宽 schema 或财务校验。初始离线候选因测试源修改而被替代；实际部署的是随后独立冻结的 final 候选。

Wrangler 4.127.1、当日 Workers 类型 5.20260908.1、生成绑定一致性、types --check、staging tsc 和最终 dry-run 均通过。Node 24.14.1 实跑；CI 声明 Node 22/24，但 Node 22 与远程 CI 尚未运行。本次线上六类矩阵不等于“持久化期间客户端取消”或原生平台终止的验收，这两项仍为下一步；本地取消通过不能替代真实 Workers 证明。

## 隔离、收尾与费用

双 Access 入口已关闭、deny-all 策略恢复、临时令牌删除。等待原有固定安全窗口后，保存全部观察，使用新版完整行平衡谓词与单个原子 batch 精确删除自有 fixture；未知测试预算连同合成账户删除，不是客户退款。56 张表回到原基线、295 个 schema 对象摘要不变、四个 staging Worker 关闭入口且无 custom domains/crons，三份生产 settings 指纹不变。未改写探针状态、补造日志或重放推理。

本轮新增 14 次公开测试 HTTP（6 次 Access 检查、6 次合成请求、2 次恢复），首轮累计 322；一次 staging gateway 发布。仪表记录管理 REST 221 次，成功返回的管理 D1 元数据为读取 2,759 行、写入 218 行；这些不含 Worker 绑定查询或 Wrangler 内部管理请求，不把未单独计量部分视作零。累计费用上限仍是首轮 US$2，不重置。真实模型/KMS 调用仍为 0；Cloudflare 管理调用、Worker 绑定查询、资源存续和延迟账单并非据此免费。预算预留不是已发生费用，最终项目增量账单未核验。

[最终机器证据](./C02-images-sse-snapshot-native-staging-results.json)保存全部案例、RPC、完整财务观察、关闭状态和预算计数。下一步为真实 Workers 提交中客户端取消与原生平台终止；不自动开启生产。C02.G、完整跨消费者物理容量、客户 intent-only 对账、幂等/unknown 接口、Node 22 及 C03–C20 保持开放。
