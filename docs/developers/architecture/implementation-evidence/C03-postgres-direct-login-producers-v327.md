# C03 v327：Images 生产者直连登录身份与双 origin 容量候选

2026-09-24；**本地子集通过，生产禁用，C03 DOING**。承接 [v326 dispatch／fact 角色分离](./C03-postgres-producer-role-split-v326.md)。本轮把合成 `SET ROLE` 验证推进到回环 PostgreSQL 18.6 的独立密码认证连接，并校验 factory 在实际连接上的角色身份。正式迁移仍为 73 条；没有在测试库外执行 SQL。

## 显式直连权限模式

[parent 授权生成器](../../../../scripts/db/cutover/build-request-parent-producer-grant.mjs)和 [fact/job 授权生成器](../../../../scripts/db/cutover/build-image-fact-job-producer-grant.mjs)新增 `reviewed-direct-login-v1`，保留原 `reviewed-v1` 的 `NOLOGIN` 模式。两种模式均默认关闭，保留固定源码 SHA、结构及有效 ACL 预检；直连模式同时要求 dispatch 与 fact 角色 `LOGIN/NOINHERIT`、无双向成员关系及高权限属性。错误模式、角色属性或任一成员关系漂移使整个授权事务回滚。授权脚本不创建角色、密码或 origin。

隔离原生 [parent 报告](./C03-postgres-native-parent-direct-login-v327-report.json) **1/1、5 阶段**，[fact/job 报告](./C03-postgres-native-fact-job-direct-login-v327-report.json) **1/1、4 阶段**，均 cleanup PASS。SCRAM 密码会话中 `session_user=current_user`；错误密码及跨角色 `SET ROLE` 被拒绝。dispatch 只经三个 parent definer 函数执行，fact 不能 claim；parent 授权也拒绝 dispatch 对其他 gateway 表／序列的有效权限及其他 definer 的执行权。fact 可按 49 项精确列权限写入 fact、由触发器形成 outbox、登记 job，dispatch 不能写 fact/job，财务日志与回执未写。新模式未进入正式迁移。

[Images PostgreSQL factory](../../../../packages/proxy/src/services/image-usage-recovery-postgres.ts)现在分别对 runtime 入口预检和每次生产者 SQL 检查**两个**数据库身份：`session_user` 与 `current_user` 必须同时等于指定角色，从而拒绝 `SET ROLE` 冒充；生产者检查与其 SQL 位于同一事务。其定向测试 **8/8 PASS**，Proxy 类型检查通过。组合 [直连原生报告](./C03-postgres-native-image-factory-direct-login-v327-report.json)为 **1/1、8 阶段、cleanup PASS**：三条分别以随机密码连接的 runtime／dispatch／fact 会话身份一致且无成员关系；fact 未获授权时 `42501`，授权后 parent claim、fact、outbox、pending job 各一条，财务表和余额未动。夹具预算票据、入口摘要与 route 是测试输入，没有真实 HTTP/provider 或资金 consumer。

## 本地预配与容量算术

新增默认关闭的 [登录角色预配模块](../../../../scripts/db/cutover/provision-postgres-producer-logins.ts)，要求显式激活、独立管理 URL、两份不同的环境密码，支持 dry run、幂等重复和显式轮换；它只接受回环地址，角色连接上限 2 是本地验证参数，不是生产 origin 配额。它不读取普通 `DATABASE_URL`，不输出密码或 URL，检查目标 schema、其他数据库的 `PUBLIC CONNECT`、零成员关系以及数据库专属 timeout 默认值。创建或轮换时强制 SCRAM 校验器；已有 `LOGIN` 角色若校验器缺失或为 MD5，未显式轮换则拒绝，不把不可密码登录的角色报告为就绪。[隔离原生报告](./C03-postgres-native-producer-login-provision-v327-report.json) **1/1、9 阶段、cleanup PASS**，验证真实登录、错误/交叉密码、其他数据库拒绝、dry run 回滚、轮换及已有 `NOLOGIN` 转换；单元测试 **3/3 PASS**。

原生负例证实：非超级用户 `CREATEROLE` 创建角色后带有不能由创建者撤销的管理成员关系，预配模块因此在写入前要求超级用户。[PostgreSQL 18 角色属性文档](https://www.postgresql.org/docs/18/role-attributes.html)也明确了该自动授权及撤销限制。这是受控 DBA 操作的前置，不表示生产身份已创建。本机密码认证与 timeout 默认值不证明实际 Hyperdrive 会话的配置及容量。

新增[双生产者 origin 离线校验器](../../../../scripts/db/cutover/postgres-producer-origin-budget.ts)，分别核算 dispatch 和 fact 的角色连接上限、拟议 Hyperdrive origin 上限、峰值需求、完整实例库存、非 Hyperdrive 预留与安全余量；**7/7 测试通过**，过期、缺失、混实例和超额输入均拒绝。结果明确标记为 `snapshot-arithmetic-only`，不访问数据库或云 API，也不认证输入快照。按 2026-09-05 的旧 PS-5 上限，两个新 origin 的配置算术失败；这份旧记录不能代表今日容量。

## 未闭合门禁

当前 [Worker 应用](../../../../packages/proxy/src/app.ts)只声明一个 `HYPERDRIVE`，Node 也只用一个 `DATABASE_URL`；[Images 恢复选项](../../../../packages/proxy/src/services/image-usage-recovery.ts)仍是 D1 路径，真实应用入口没有注入 PostgreSQL factory。因此本轮只证明本地密码登录及 factory 组合，**没有生产 runtime／dispatch／fact 三个 origin 的凭据来源、绑定、生命周期或当前容量验收**。后续需要当前同实例全量 Hyperdrive/直连库存与峰值事实，匹配角色及 origin 限额，再完成 Worker／Node 显式接线和真实身份测试；本地连接上限 2 不能直接当作生产参数。

完整预算／claim 可恢复协议、独立受限资金 consumer、已知非 2xx 事实来源、旧库回填／保留期、代表性流量、Queue ACK/retry、DBL-04/05/06/08 仍开放。C03.5 还包括 metadata 调度、凭据写入、受限解密、KMS 管理和数据库运维身份的完整越权验收；C03.4／C03.5／C03.7／C03.G 与 C01.G／C02.G 均不勾选。无远端 SQL、部署、云管理或模型/KMS 调用；首轮 staging US$2 上限不重置。[机器摘要](./C03-postgres-direct-login-producers-v327-results.json)固定本轮源码与报告 SHA。
