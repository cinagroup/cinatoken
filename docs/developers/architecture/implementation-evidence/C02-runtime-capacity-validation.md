# C02.B2.2 — 消费者清单与完整 Images Node 容量样本

日期：2026-09-06。状态：**本地 Images 完整路径 / 逻辑所有权子集 LOCAL_PASS；运行配置、真实平台与整个实例内存门禁未通过**。生产未启用容量策略，没有改动生产运行时 / 路由 / 计费逻辑。本轮从 [HTTP 基础合同](./C02-http-capacity-ownership.md) 接续，不重复声称其 59 项测试是本轮新增。

## 1. 新增内容和覆盖范围

新增 [隔离测量入口](../../../../packages/proxy/scripts/measure-image-gateway-capacity.mjs)、[子进程](../../../../packages/proxy/src/test-support/image-capacity-process.ts)、[真实路由 fixture](../../../../packages/proxy/src/test-support/image-capacity-fixture.ts) 和 [3 项所有权测试](../../../../packages/proxy/src/test-support/image-capacity-fixture.test.ts)。两套回归与安全类型检查纳入新测试；测量命令独立，普通测试不会自动启动大负载测量。

经过真实 Hono / Node HTTP 适配器、入口鉴权、空 Guardrail 策略、选路、Images generations / edits 驱动、按需 JSON 输出、usage 规范化、`recordImageUsage` 和核心 D1 写入调用链。使用单一合成模型 / 供应商、零价格和无限财务额度；没有真实资金预留或数据库提交。D1 sink 只接受三种指定 INSERT 和有限配置查询，延迟 batch 返回，并在延迟期间保留真实 SQL bindings；这仅模拟提交确认边界，不模拟事务故障 / 恢复、网络驱动内存或真实写入成本。

客户端和合成上游在父进程，网关在独立子进程，避免把大输入生成、上游输出和客户端缓存计入网关 RSS。子进程按 Node 生产打包的 workspace / external 规则打包，但入口和数据库仍是测试 fixture，不是原生产 Node 工厂。所有连接只到随机 `127.0.0.1` 端口；子进程 fetch 限定唯一上游 origin / operation 且禁止重定向。子进程仅继承少量系统路径环境，不读取业务配置。遥测仅保存数字，不通过 MockTracker 留存正文参数 / 日志历史。

每组请求完成后暂不确认 SQL batch；20 个并发容量拒绝均为 503，且未增加存储初始化、鉴权、Guardrail、选路、上游发送或 batch 计数。读完或断开客户端后，额度仍由未完成记账持有；释放合成确认并等待实际受管终态后，池占用与后台任务均为零。三项小测试另覆盖记账先结束但响应仍未读的反向顺序。测试池每请求使用 `reservedBytesPerRequest=1` 占位单位，仅检验所有权；绝不是 1 字节即可执行请求，不能用于生产配置。

## 2. 最终测量（6 个独立子进程，各 1 个样本）

命令 `node packages/proxy/scripts/measure-image-gateway-capacity.mjs`，退出 0；Node 24.14.1 / Windows x64，`--max-old-space-size=768`，仅在全部终态后调用一次强制 GC。每请求入口精确 50 MiB；普通上游精确 32 MiB；multipart 包含两个精确 20 MiB 文件和剩余约 10 MiB 文件，三文件与字段合计 50 MiB。每次 usage 含 60 KiB detail，规范化审计仍低于已批准的 64 KiB。完整分阶段数据、字节数和 SHA-256 见 [原始结构化输出](./C02-image-gateway-capacity-measurement.json)。

| 场景 | 并发 | 基线 RSS MiB | 10 ms 采样峰值 RSS MiB | OS 高水位 RSS MiB |
| --- | --- | --- | --- | --- |
| JSON + ASCII，读完 | 1 | 282.54 | 379.89 | 383.97 |
| JSON + UTF-8 替换膨胀，读完 | 1 | 282.51 | 411.33 | 427.95 |
| multipart + ASCII，读完 | 1 | 282.82 | 411.40 | 420.42 |
| JSON + ASCII，不读后断开 | 1 | 282.89 | 361.68 | 388.64 |
| JSON + ASCII，读完 | 2 | 282.25 | 431.46 | 463.90 |
| JSON + UTF-8 替换膨胀，不读后断开 | 2 | 283.49 | 468.30 | 474.45 |

读完的响应均校验完整长度和独立生成的 SHA-256，非只检查状态码。ASCII 响应为 33,554,490 字节；替换膨胀响应为 100,540,272 字节（约 95.88 MiB），较上游接近三倍；新增的 usage 别名仍按原合同输出。不读的响应没有冒称端到端完整交付校验。每个入站大请求只产生一次上游请求。

**采样峰值小于 OS 高水位，证明定时采样会漏掉同步峰值。** OS maxRSS 同时包含启动过程，不能直接减基线当作单请求准确占用；arrayBuffers 属于 external，不能重复相加。最大采样 RSS 468.30 MiB 不是上界或推荐池大小，更不能与 Workers 的 isolate 限额直接换算。Node 基线包含该合成打包应用、V8 与依赖，未代表 Docker Node 22 或 Workers 基线。

释放全部逻辑所有者后，双并发 ASCII 场景 RSS 仍为 431.46 MiB；终态后强制 GC 为 423.00 MiB，仍高于 282.25 MiB 基线。这里没有证明内存泄漏，也没有证明下一次负载一定可安全复用；说明 release、可回收、GC、分配器向 OS 归还及网络确认是不同事件。实际生产预算和持续负载必须留有独立余量。

未覆盖：重复统计 / 长时间稳定性、短键合法累计 / SSE 最大事件、所有慢速与异常组合、并发 multipart、非空 Guardrail / 租户配置、混合消费者、TLS / 真实 DB 缓冲、账务确认丢失 / 恢复、生产关闭流程。合成小规模拒绝批次不是 DDoS / 持续拒绝洪峰验收。

## 3. 运行时和消费者核对

[消费者矩阵及有限接续顺序](../runtime-capacity-consumers.md) 新增 Proxy HTTP / 后台、Realtime host、Cron、Queue、独立 Admin 的范围与关闭条件。重要差异：Batch 公开 API 关闭不等于 queue 消费关闭；Admin 的 2 MiB Hono 请求上限不覆盖外层 Realtime / 整个 Next 工作集；同机独立容器仍共享宿主机物理预算。Node 生产 host 尚未接入后台 drain 的优雅停机流程。

本轮最小 Workers smoke 在受限环境和获准解除沙箱后都退出 1：workerd 原生 `0xc0000005` / `ERR_RUNTIME_FAILURE`，未进入应用断言。工具提示 VC++ runtime 可能相关，但根因未证实，不能把它认定为应用测试失败或已经修复。只读 WSL 列表受限时 E_ACCESSDENIED，解除限制后退出 0、没有发行版；Docker 不在 PATH，不等于未安装。没有安装 / 修复系统或新建替代运行环境。Node 22 未验证，真实 Workers / DB 门禁继续保留。

按 Workers 最佳实践技能区分按需交付、受管后台终态与平台取消。官方证据：同一 isolate 的内存预算由并发请求共享，HTTP waitUntil 在响应结束 / 断开后只有有限延长窗口。[Workers 内存限额](https://developers.cloudflare.com/workers/platform/limits/#memory)、[后台生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。未改兼容日期、配置模板或生产能力。

## 4. 测试、失败记录和收尾

小测试首轮 2/3 通过：记账先结束的用例在 `response.cancel()` 返回后过早断言，忽略已明确约定的异步清理；改为等待受管清理终态，最终 3/3 通过，无放宽生产逻辑。首轮 128 KiB smoke 六组通过。首轮全尺寸运行前三组通过，不读断开组被预期的固定 `Gateway response delivery stopped` 日志触发零错误断言；核对 Node adapter / 容量包装后，只单列这一精确固定 Error 为 expectedDisconnects，其他错误仍使验收失败。随后六组全尺寸通过；将 multipart 分片改为精确 20 / 20 / 剩余 MiB 后，最终重跑六组全部通过，不使用先前数据替代最终样本。

最终完整 pretest 链与主 suite **3,051 tests / 135 suites，退出 0**；安全专项 **2,678 tests / 50 suites，退出 0**；相比前轮各新增 3 项，重叠不相加。Proxy / dispatch-safety 类型检查通过。主 / 专项无失败、取消或跳过；Node 断连 / 后台 rejection 的既有预期日志仍存在。执行 `npm test -w @octafuse/proxy`、`npm run test:dispatch-safety -w @octafuse/proxy`、`npm run typecheck -w @octafuse/proxy` 和 `npm run typecheck:dispatch-safety -w @octafuse/proxy`；终端完整文本有工具截断，测试仅保存结果摘要，测量 JSON 则保留完整结构化输出。

## 5. 状态 / 回退 / 外部动作

C00 LOCAL_PASS；C01 / C02 DOING；C03–C20 TODO。C02.G 未通过。唯一下一项仍为 **C02.B2.2 — 实际运行配置、跨消费者容量与 host 持有期验收**，按矩阵第 3 节先冻结能力 / 运行配置、补同配置证据，再闭环 host 与恢复，最后计算并启用预算。已批准属性名 256 UTF-16 单元、raw_usage 64 KiB 和 50 / 20 / 32 MiB 合同不变。

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`。起点 275 个 dirty/untracked 文件；前一 222 文件快照修改前全部匹配。本轮 [239 文件快照](./C02-runtime-capacity-validation-snapshot.json) 单独保存源码、配置和证据，不覆盖历史快照；最终哈希复核全部匹配。5 份当前文档的 79 个本地链接目标存在（文件存在性，不是锚点 / 渲染验收），`git diff --check` 和测量脚本语法检查通过。最终 283 个 dirty/untracked 文件：更新起点已有 5 份文件，新增 8 份；起点文件无缺失，其他既有修改保留。回退只涉及新增测量 / fixture / 测试注册与本轮文档，不碰生产代码、不覆盖历史证据、不回退其他 dirty 工作。

大请求只在本地合成链运行，所有最终子进程退出 0，端口 / 连接关闭。构建输出留在忽略的 `packages/proxy/dist/capacity-probe-*` 独立目录，没有删除用户文件。无提交、安装、部署、云写入、真实 KMS / OAuth / 模型、业务库、迁移、支付或远程 CI。Google Cloud KMS / cinatoken 沿用历史确认，未重复访问云项目。
