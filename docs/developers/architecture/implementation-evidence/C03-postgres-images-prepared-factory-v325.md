# C03 v325：Images 预备载荷摘要、PostgreSQL 恢复候选与 parent producer 授权

2026-09-24；**本地候选通过，生产禁用，C03 DOING**。承接 [v324 parent ACL 与 Images 单次 grant 桥接](./C03-postgres-parent-acl-images-bridge-v324.md)。本轮把 Images 驱动的已准备载荷摘要贯通到路由的单次 grant 回调，增加一个显式构造的 PostgreSQL recovery factory，并在隔离原生 PostgreSQL 中验证 parent producer 的函数级权限。这些部件仍未组成可启用的生产恢复链。

## 驱动载荷与 claim 上下文

[Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)在 fetch 前传递只读 `PreparedImageAttempt`。[generations](../../../../packages/proxy/src/services/egress/json-upload-body.ts) 的 SHA-256 来自上传流使用的同一份冻结 JSON 快照；edits 来自 multipart writer 使用的标量字段和已封存文件页，文件摘要逐页计算，不包含随机 multipart 边界。[上下文模块](../../../../packages/proxy/src/services/image-attempt-context.ts)将可信入口请求摘要、操作、所选 route 全部非密钥事实、上游 URL 的 SHA-256 和已准备载荷摘要绑定成 attempt context；回调不传原始 URL、凭据或正文。驱动回归涵盖回调时修改 route、body、文件 metadata、URL 错配和不安全文件句柄。

[Images 路由](../../../../packages/proxy/src/routes/v1/images.ts)只对声明单次持久 grant 的恢复对象接收此预备对象，先比较当前 route 和驱动捕获的身份、计算摘要，再准备 Ordinary／Guardrail 预算票据；恢复回调收到冻结的 `TrustedImagePreparedAttemptContext`。POST generations／edits 的 HTTP 回归分别改变 prompt／已解码的文件字节，证实 request、context 和 outbound 摘要随实际载荷改变且旧 D1 writer 未运行。明确未授予 claim 且预算释放成功时返回 `outcome_unknown:false,retry_safe:true` 的 503；claim 回执不明或标记后中断仍维持 `outcome_unknown:true,retry_safe:false`。路由 **438/438 PASS**。

## 显式 PostgreSQL factory 候选

[恢复 factory](../../../../packages/proxy/src/services/image-usage-recovery-postgres.ts)要求普通存储、parent claim producer 与事实 producer 使用三个不同的 PostgreSQL client，并拒绝缺少可信入口 SHA、缺少驱动上下文、操作／request／route 身份错配。它先经 parent 函数 prepare，再在 claim **COMMIT 回执确认**后标记预算票据；明确无 claim 释放，不明回执不重试、不读回为发送权。fetch 之后，它只准备脱敏的 V1 Images 结算输入，并要求不可变 fact/outbox 精确读回及 recovery job 登记。返回的后台 fast path 不执行财务提交；需独立、受限且带 fence 的 PostgreSQL recovery consumer。factory 定向 **6/6 PASS**，相关 digest／上传／driver 生命周期组合 **98/98 PASS**，Proxy 与 dispatch-safety 类型检查通过。

factory 仍未接 `createProxyApp`／Workers 生产入口；三个 client 的原始连接不同**不证明 SQL 角色独立**。当前 parent grant 仍授予名为 `cinatoken_gateway_fact_producer` 的同一角色，fact/job 的窄权限 grant 尚未形成；生产 claim 与事实身份分离、真实预算仓储、结果事实与资金事务未做端到端验收。factory 的 TS 冻结对象和 SHA 格式本身不证明调用者来源，当前可信边界依赖内置驱动→路由；不得向不可信插件开放直接调用。

[原生 factory 夹具](../../../../scripts/db/cutover/postgres-image-recovery-factory.native.test.mjs)在隔离 PostgreSQL 18.6 安装 73 条正式迁移和 review-only parent／outbox 提案：先以真实 producer 执行 parent claim，预算标记回调从独立连接核对已提交 claim；无 fact 权限时数据库以 `42501` 拒绝，fact/outbox/job 均为零。随后仅在夹具中授予列级 fact/job INSERT 与读回权限，再以 factory 写入同一 claim 的 fact、outbox 和 pending job；财务日志／审计及预算余额保持原值。**1/1、7 阶段、cleanup PASS**。[原生报告](./C03-postgres-native-image-factory-v325-report.json)明确了合成 `SET ROLE`、假预算票据、由夹具提供的请求摘要与 route，以及未接 HTTP/provider/资金 consumer 的限制；夹具列级 grant 不是生产授权脚本。

## Parent producer 函数权限

[默认关闭的 grant 生成器](../../../../scripts/db/cutover/build-request-parent-producer-grant.mjs)要求显式 `reviewed-v1`，固定 parent SQL 的 SHA 与三个 definer 函数体；只给预先存在的 `NOLOGIN/NOINHERIT` `cinatoken_gateway_fact_producer` schema USAGE 和 prepare／claim／classify EXECUTE。它在事务内拒绝角色继承、函数或表权限漂移，普通 runtime 保持无权；不进入正式迁移。preflight 和 postflight 同时核对 parent 表及**列级**有效权限。[隔离 PG18.6 原生测试](../../../../scripts/db/cutover/build-request-parent-producer-grant.native.test.mjs)通过 **2/2、13 阶段、cleanup PASS**，覆盖授权前拒绝、函数真实执行、parent／intent／Key 直接访问拒绝、runtime 直接／继承／PUBLIC 列级 grant 漂移回滚、重跑与 runtime grant 重跑。[冻结报告](./C03-postgres-native-parent-producer-grant-v325-report.json)只证明合成 `SET ROLE` 身份，不证明生产登录凭据、真实 origin 或 fact/job/资金权限。

## 剩余门禁

73 条正式迁移不变；parent／grant 仍 review-only。C03.4／C03.5／C03.7／C03.G 继续开放：预算和 claim 跨服务未形成可恢复的完整生产协议；claim 与 fact 的 SQL 角色、fact/job 的精确权限、独立 recovery consumer 与资金 COMMIT、代表性旧库回填／保留期、真实 origin／Workers／Hyperdrive／Queue 和 DBL-04/05/06/08 尚未验收。C01.G／C02.G 也未通过。本轮无远端 SQL、部署或云资源调用；首轮 staging US$2 上限不重置。[机器摘要](./C03-postgres-images-prepared-factory-v325-results.json)记录本轮源码与报告摘要。
