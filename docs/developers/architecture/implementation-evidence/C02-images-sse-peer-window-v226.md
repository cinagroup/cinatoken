# C02.B2.2 — V3 一次性 SSE 读体、恢复与收尾

日期：2026-09-09；Checklist v1.125。状态：STAGING_PARTIAL。新增 V3 协调器、唯一原始 reader 的执行窗口和外层 finalizer；本地联调完成，资源创建执行器 / CLI 尚未切换到 V3，未部署或修改结算算法。

## 已接通的执行顺序

唯一 after-hold 推理 POST → 原响应身份 / 同一时钟回执 → 获取原 body 的唯一 reader → V3 WebSocket 同实例发现 → completed 帧及 held D1 事实 → held 标记 / 样本 → 原 fetch signal 取消 → 真实 reader 终止 → 原 collector 的 native 事件与 D1 快照 → post-native 标记 → 一次恢复 + 一次去重 → 完整六表事实 → post-recovery 标记 → 封存并持久化联合输入 → 纯 oracle → 持久化判定。

推理请求只携带 V3 primary 头，不能从外部指定旧 peer 头。未取得原响应前，watch / held / cancel 转移均拒绝；推理次数先同步预留并写入 PENDING，再允许出站。请求的 90 秒紧急信号在开始处建立，不因日志等待重新起算。V3 客户端保留已有总发现预算、明确完整不匹配才重试 Upgrade、单连接阶段 ACK / 样本及封存限制；不增加 HTTP 阶段标记或推理重试。

held 与 native 观察必须完整一致，而非只核对一个快照字段。恢复调用先消费预算并写 PENDING；丢失 ACK 后保留不确定调用和实际结束时钟，不补发第二次或替代 RPC。恢复后的账务证明不覆盖“容量仍占用”结论。联合输入（原 session / primary / held / native / recovery 和已封存观察报告）持久化成功后，才调用 V3 纯验收；日志失败不能进入 OBSERVED。

## 原始 reader 与失败收尾

观察端不读取、clone 或 tee 推理响应。成功流读取、取消等待和失败后的收尾都由同一个 reader 完成。修复了新窗口继承的一个收尾边界：观察连接失败可能发生在 reader 已获取、首次 read 尚未开始时；原 fetch abort 已令流报错，此时 reader.cancel() 也会拒绝。现在即使 cancel 拒绝，仍等待 / 发起真实 read 以观察 EOF 或拒绝，之后才能记录完成；cancel 拒绝本身不是完成事实，超时也不会补造完成时钟。

V3 finalizer 重新使用 V3 联合 oracle；其余边界保留：固定 staging 入口关闭、双 Access deny-all、仅撤销自有 token / tail、精确 fixture key 撤销、原 monotonic 350 秒安全期、原 native / 快照 / 六表完整财务校验及一次原子清理。失败实验始终失败，安全清理完成不升级实验结论。只有不存在任何原恢复尝试、原始 native 证明和实际 pending 财务事实有效时，失败收尾才可调用一次恢复；不确定 RPC 不重放。

取消快照仍为 armed、缺少 native 或推理 ACK 不明的场景保留隔离数据，不用后来的 held 行替换取消时记录。逻辑仍占用场景即使财务 / 清理均完成，也保持 OCCUPIED_AFTER_NATIVE_MARKER；不声明 isolate 被驱逐或 C02 总门禁通过。

## 实证与测试范围

新增 17 项本地测试：

- 直接匹配 / 先完整明确 409 再匹配 × 空闲 / 仍占用的 4 个完整窗口，执行实际 SQLite 恢复与去重和原子清理。
- 原响应之前禁止 watch / held / cancel；同步预留失败或错误使用异步预留均禁止发送且不能重放，共 3 项。
- 10 项故障：推理写前日志失败、推理 ACK 丢失、held 之前 / 之后观察 403、native 事实改变、native 缺失、post-native ACK 丢失、恢复 ACK 丢失、封存输入日志失败、判定日志失败。核对唯一推理 / reader、禁止 clone / tee、无 RPC 重放、入口资源关闭及允许 / 禁止清理边界。

主 SSE 和观察 WebSocket 均经过真实本地 HTTP / ws 连接，实际共同 Images handler、V3 服务端、SQLite 持久化 / 恢复和 finalizer 被调用。HTTP 测试适配器把实际收到的字节构造成空 URL 的 Response，不修改响应身份 / 帧 / 占用计数；其 abort 真实关闭连接，服务端收到连接关闭后取消原 Request.signal。合成上游真正 enqueue completed / DONE，并在实际 reader cancel 回调写 response_cancel 终态。

WebSocketPair / 101 适配、Cloudflare 管理 API、native host-stop / tail envelope 和经过时间仍是明确的本地模拟；未运行 workerd 或云端 Workers。native 输入使用真实取消行和原 session.receive，但 envelope 的构造不构成真实 Cloudflare 证据。因而机器清单仍 nativeVerified=false / liveOperatorImplemented=false；不能以本地结果宣称线上容量通过。

## 失败记录与复验

开发中的失败均保留独立源码 / 观察记录，原始终端输出未另存，未隐去为首次全过：

| 记录 | 实际结果 | 定位与处理 |
| --- | --- | --- |
| [初次](../../../../.wrangler/staging/peer-v226-initial/observation.json) | 0/4 PASS | 本地时钟误写 ms，改为真实 monoMs 字段；严格时钟校验未变。 |
| [第二次](../../../../.wrangler/staging/peer-v226-second/observation.json) | 0/4 PASS | app.fetch 直接暴露业务 reader 错误，且合成 upstream 终态不符清理合同；改成真实回环 HTTP 和真正 reader cancel 事件。 |
| [第三次](../../../../.wrangler/staging/peer-v226-third/observation.json) | 2/4 PASS | 仍占用夹具提前读取尚未完成的实际取消写入；等待真实 SQL 回调，不重写证据。 |
| [第四次](../../../../.wrangler/staging/peer-v226-fourth/observation.json) | 12/13 PASS | 新窗口在首次 read 前失败的 reader.cancel 拒绝阻断收尾；补真实 read 终止观察。 |
| [第五次](../../../../.wrangler/staging/peer-v226-fifth/observation.json) | 12/13 PASS | 测试错误期待取消于 armed 的情况可清理；拆成确定性的 early / after-held 故障，early 保持隔离。 |

专项最终 17/17 PASS；联合回归 **2,188/2,188 PASS**，失败 / 取消 / 跳过均为 0，staging 类型检查 PASS。见[独立回执](../../../../.wrangler/staging/sse-peer-window-v226-verification-result.json)和[机器清单](./C02-images-sse-peer-window-v226-results.json)。既有 1,859 条摘要和新增 6 个源码 / 测试 / CI 文件在回归前后验证；新清单合计 1,880 条摘要。验证进程移除 Cloudflare 凭据，未重启或覆盖历史回执。本机 Node v24.14.1；Node 22/24 CI 仅定义，未执行远程 CI。

## 接续与费用边界

下一步把 V3 三个模块接入新的固定资源执行器和 CLI，保留有界拒绝捕获、原单一 tail、写前预算消费、原 session、内容 / 版本 / 隔离新鲜前检、资源所有权及累计 US$2 上限。随后才进行封闭候选部署和受控 Workers 验收；旧的已消费执行器 / 历史证据不重放。

本轮云端 API / 公开 HTTP、远端 D1 写入、部署、模型 / KMS 和生产写入均为 0；仅有本地回环通信。最后真实云端观察仍 v220、已部署网关仍 V2；v222 V3 候选与 789 个 bundle 输入未变。公开 HTTP 累计 390、模型 / KMS 0/0、首轮累计 US$2 不重置；最终增量账单仍未核实。物理 / 跨消费者容量、unknown / 幂等、C02.G、C01 和 C03–C20 仍开放。Cloudflare 技能用于核对原请求与平台证据边界，未套用 clone 响应或把后台存活视为账务保证。
