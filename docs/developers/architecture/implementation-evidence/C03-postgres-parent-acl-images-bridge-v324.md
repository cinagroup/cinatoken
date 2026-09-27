# C03 v324：parent 授权重跑、默认 ACL 激活与 Images 单次 grant 桥接

2026-09-24；**隔离原生 PostgreSQL 与本地路由候选通过，生产禁用，C03 DOING**。承接 [v323 parent／预算／Images 本地组合](./C03-postgres-parent-budget-images-v323.md)。本轮补上普通 runtime 授权重跑的收权、已有默认权限数据库的 parent 安装事务，并把 Images 的预算票据交到单次 grant 路由回调。未接生产 PostgreSQL recovery factory。

## PostgreSQL 权限边界

[普通 runtime 授权脚本](../../../../scripts/db/cutover/grant-postgres-runtime.ts)在 schema 范围的表／函数宽授权之后，于同一事务检测可选 parent 表和三个函数；完整安装时立即撤销表全部权限和三个函数的 EXECUTE，并检查 runtime 的**有效**权限。部分安装或经角色继承仍可访问会使授权事务回滚。[原生重跑夹具](../../../../scripts/db/cutover/postgres-parent-runtime-grant.native.test.mjs)在 73 条正式迁移和三份 review-only 提案上验证首次与第二次授权仍关闭 parent、普通表 SELECT 可用、runtime 实际访问被 42501 拒绝，以及继承 EXECUTE 漂移导致整次授权拒绝。**1/1 PASS、5 阶段、cleanup PASS**；[报告](./C03-postgres-native-parent-runtime-grant-v324-report.json)。[迁移契约静态检查](../../../../scripts/ci/verify-postgres-migration-contract.mjs)也检查收权位于宽授权之后。

现有 `grantPostgresRuntime` 会设置 migrator 在 gateway schema 新建表的 runtime SELECT、函数的 runtime EXECUTE 默认授权；直接安装 parent 提案会把这两项复制到新对象，parent 自检因此原子拒绝。[默认关闭的激活 bundle 生成器](../../../../scripts/db/cutover/build-request-parent-default-acl-activation.mjs)要求显式 `activation:'reviewed-v1'` 且固定 parent 提案 SHA。它生成唯一 BEGIN/COMMIT：取得已知 advisory 锁，严格预检角色和表／函数默认 ACL，快照 migrator 全部默认 ACL，在事务内临时撤销两项已知默认授权，执行原 parent 提案，恢复默认授权并双向比较快照。错误后调用方必须 ROLLBACK 或断开连接；生成器不连接数据库，也未进入正式迁移或生产入口。

[激活原生夹具](../../../../scripts/db/cutover/build-request-parent-default-acl-activation.native.test.mjs)从真实 runtime 默认 ACL 起步：裸 parent 提案拒绝；未知 schema／global 默认授权拒绝且不变更；现存旧 intent 使 bundle 回滚并保留旧行和 ACL；空库安装后默认 ACL 原样恢复、runtime 对 parent 表／函数实际收到 42501，授权脚本重跑后仍关闭。**2/2 PASS、7 阶段、cleanup PASS**；[报告](./C03-postgres-native-parent-default-acl-v324-report.json)。该生成器只接纳当前已知默认 ACL 形态；旧库迁移窗口、锁持续时间和生产角色仍未验收。

## Images 单次 grant 边界

[路由](../../../../packages/proxy/src/routes/v1/images.ts)现在只对声明 `singleCommittedRequestGrant` 的恢复对象使用显式预算票据：选定 route 预留 Ordinary／Guardrail，回调在确认持久 claim 后必须完成 `markAfterCommittedClaim()` 才能放行 driver 的 fetch。明确无 claim 释放；结果不明保留预留，返回 `outcome_unknown:true,retry_safe:false` 的 503；已授权的首个已知非 2xx 保留原响应而不继续 failover。bridge 自己记录是否曾向 fetch 授权：所有 route 在 claim 前熔断等合成响应不进入 `recovery.persist` 或旧财务 writer；claim 标记后取消也保持不可自动重试。未获支持的 recovery SSE 默认在 fetch 前拒绝，原 D1 工厂显式保留旧 SSE 回退。[恢复接口](../../../../packages/proxy/src/services/image-usage-recovery.ts)仍没有 PostgreSQL factory；单次 grant 的测试对象是合成 owner。

[attempt context helper](../../../../packages/proxy/src/services/image-attempt-context.ts)可把可信入口 SHA-256、选定凭据 route、Guardrail 后逻辑出站内容绑定成 SHA-256。generations 与 [driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)共用出站 JSON 投影；edits 共用标量字段／文件 metadata 投影，并重读已接收文件字节。摘要不含随机 multipart 边界。**它尚未接入路由或 claim**；driver 目前先准备发送载荷，helper 若随后从可变 route／body 重算，可能摘要与实际发送内容不同。生产接线必须让 digest 与 fetch 使用同一不可变的已准备投影，不能把目前 helper 的等价测试写作该门禁已通过。

## 验证与剩余门禁

Images 完整路由 **436/436 PASS**（含 generations／edits 的全熔断无 claim、claim 标记后取消负例），attempt／入口 digest／预算／driver 定向 **52/52 PASS**，Proxy 完整与 dispatch-safety、Core dispatch-intent 窄类型检查、迁移静态契约、语法与 `git diff --check` 通过。[机器摘要](./C03-postgres-parent-acl-images-bridge-v324-results.json)固定本轮报告和源码 SHA-256。

正式迁移仍为 73 条，parent 与相关提案保持 review-only。跨服务预算和 claim 没有同一事务；生产 factory、真实生产者 EXECUTE 身份与权限、已提交 grant 后的结果事实／资金结算及崩溃恢复、代表性旧库回填与保留期、不可变出站快照、真实 origin／Workers／Hyperdrive／Queue 和 DBL-04/05/06/08 仍开放。C03.4／C03.5／C03.7／C03.G 不勾选，恢复角色保持 `NOLOGIN`。没有远端 SQL、部署或云资源调用，首轮 staging US$2 上限不重置。
