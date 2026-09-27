# C04 v398 — 无密钥尝试顺序与 quote 绑定的会话 CAS

这是 review-only、默认关闭的 PostgreSQL 组件，正式迁移仍为 PG73 / D1 68 / MySQL64。生产 Chat 未接入。

源码：[尝试准备器](../../../../packages/proxy/src/services/credential-free-route-attempts-v398.ts)、[会话客户端](../../../../packages/proxy/src/services/postgres-complete-text-sticky-routing-v398.ts)、[SQL proposal](../../../../packages/core/migrations-proposals/postgres/complete-text-sticky-routing-v398.sql)、[会话原生 helper](../../../../scripts/db/cutover/exercise-complete-text-sticky-routing-v398.ts)、[真实准备链 oracle](../../../../scripts/db/cutover/exercise-complete-text-route-preparation-v398.ts)。

## 默认平台选路

准备器只读取已确认的 v396 安全投影和最终请求快照。它捕获调用者字段，验证最终 body SHA256、完整 1–8 个 model 候选及每个候选的输出容量，再使用真实默认端点规则的 attestation、默认价格/健康负载均衡、priority/tier strategy 和 Provider 熔断。每次异步 hash／sticky 读取后及返回前都以实时钟复核捕获的有效期；路由健康检查的 `now` 参数不能冻结投影有效期。输出只保留白名单 ID、策略和资格字段；不含 Provider URL、模型私有名称、ciphertext 或密钥。

现有四种策略、负载均衡和 sticky helper 改为接受窄 DTO，原 credential-bearing 调用仍使用同一实现。Weighted round robin 用连续权重区块定位原来的轮转起点，保留浮点权重 floor/min-1、进程 counter 和 Provider ID 去重语义；不再按权重逐项分配数组。测试比较完整轮转周期，并覆盖极大有限权重。

会话规则复用实际 OpenRouter session/messages affinity、10 分钟 session TTL、隐式 cache-hit 资格和旧 legacy pool 选择。读取在 preparation 内完成，写入仍使用原来的 bind/touch/clear 调度接口及 CAS token。Storage lookup 失败保留原来的普通选路回退；后续 grant/send-start 的数据库新鲜度 fence 仍是强制检查。

此入口只实现默认平台 Chat 准备路径。它尚不是完整公开 ingress、Provider preference applicator、fallback/dispatch loop 或 Worker entry。显式 provider.order/only/sort、BYOK、共享 Key、其他协议和价格类别不能由此入口宣称已兼容；需要后续 ingress/profile 扩展。上游完整响应观察也不能独立证明客户端已完整接收流。

## 专用会话权限

`cinatoken_gateway_complete_text_sticky_router` 仅可执行 quote 绑定的 `complete_text_sticky_action_v398`，不能直接读写 sticky 或财务表。上下文固定 quote/request/body digest、routing epoch、candidate、pool 和 affinity hash。Gateway 仍负责可信 session/hash 选择；数据库不把调用者提供的 hash 当作独立用户身份凭据。

`get` 要求当前且未到期的投影。`bind/touch` 要求同 quote/candidate/target 的真实 v392 complete observation 和对应 v366 usage fact；隐式 cache-hit 还要求真实 cache-read tokens > 0 及有利 cache pricing。`clear` 要求同目标已提交的 holder fetch-invoked fact。数据库推导 pool epoch、TTL 和当前时间，不接收调用者的到期时间、金额或审计内容。

响应完成后的写操作可越过 quote 时间到期，但仍必须通过 epoch/source/membership 检查与响应/调用证明；该例外不会授权新的 send。绑定沿用 token CAS：有效行不能被无 token 的后到请求覆盖；旧 token 的 touch/clear 无效果。客户端所有成功结果都等待 COMMIT 和连接 close ACK；未知 ACK 不自动重试。

过期投影仍不能执行 `get`。晚到 mutation 的独立确认需要新的有效 quote 上下文与相同 affinity，而不是重新发送旧请求。Legacy 无 surface 时，价格／健康负载均衡后首个 eligible pool 是 affinity namespace，绑定目标仍可属于同一完整 model 候选中的其他 pool；有 surface 时保持目标与显式 pool 一致。

## 验证状态

尝试准备器 **12/12**、会话客户端 **6/6** 定向测试通过；包含旧策略、sticky 与 Provider preference 回归的本轮联合测试为 **64/64 PASS**（另含 v395 7 项及 v396 5 项），[unit report](C04-credential-free-route-attempts-sticky-v398-unit-report.json) 固定 27 个文件摘要。覆盖延迟 sticky 读取跨过有效期、调用者修改 deadline 无效，以及价格排序后的 mixed-pool namespace。Proxy 类型检查通过。新增定向和原生 fixture 已登记 CI；Linux CI 未运行。

[v396 联合原生报告](C04-complete-text-routing-projection-v396-report.json) 为 **106/106 阶段 PASS、cleanup PASS**，包含 v396→v398 安装、default-off、额外 EXEC／column ACL／trigger／rewrite rule 的四个原子拒绝，以及真正执行 v398 准备器的 28 个 oracle 阶段。实际 PG 仓储与旧完整准备链对照覆盖两个熵值、四种策略、完整模型候选、容量／默认端点过滤、价格排序后的 mixed-pool namespace、熔断 Retry-After 和真实响应证明授权的 sticky hit；财务行不变。原生会话场景还验证旧 token CAS 拒绝、数据库 TTL、物理 COMMIT 回执丢失后独立读回，以及投影实际过期后的 bind／touch／clear 与新 quote 读回。CAS 场景按顺序执行，没有声称并发 CAS。

独立重算匹配 **86 个文件 pins + PG73 corpus + 327 个 core 源文件 corpus**。整套响应场景原有 9 次本机 POST；新增选路、会话和锁冲突场景没有增加发送。v396 的真实双事务冲突以 `55P03` 保守拒绝，writer 随后 COMMIT、零新增 POST。v395、v396/v398、v397 当前各自具有严格安装分支；四者在同一个完整 authority stack 的共装仍缺桥接。没有远端 SQL、部署、生产凭据或付费 Provider 调用。C04.1–8/G 仍不勾选。
