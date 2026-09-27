# C02 v260：BYOK 主机独占日志与入口关闭观察

2026-09-16，Checklist v1.159。**本地实现和回归通过；云端操作器、数据库停写证明及原生验收仍未完成。** 本轮只新增主机侧模块和测试，未修改既有 Worker、产品 SQL、迁移或云配置，没有云端请求。

## 已完成

`scripts/deploy/byok-d1-operator-journal.mjs` 在规范化工作区内使用固定排他目录和 `wx` 日志文件。更换 run ID、重复启动或关闭文件句柄都不能取得第二次执行资格；没有自动续跑、删除或释放占位接口。拒绝中间目录的符号链接/junction，不自动改用另一目录。

每个已知步骤在调用前记录 PENDING 并 `fsync`，之后才执行回调；显式处理短写入和零写入。回执或摘要保存失败将执行结果保留为不确定，阻止后续普通工作和重放。独立的关闭/撤销步骤仍可尝试一次，防止日志磁盘故障阻止入口封闭；若日志无法保存，不报告完整成功。日志只接收固定计数、摘要和状态，不保存密钥、API 正文、SQL 或原始异常。

只读检查器核验行顺序、摘要链和步骤状态；截断/损坏记录不自动修复，检查结果始终 `mayReplay:false`。摘要链用于完整性诊断，不防具备本机写权限者重写全部历史。这里的独占只覆盖**同一真实工作区的协作进程**，不是跨主机/克隆的分布式锁，也不是数据库 CAS；文件刷盘不等于证明所有硬件掉电场景。Windows 的文件 mode 参数不作为凭证 ACL 保证，因此日志不存真实凭证。[Node 文件系统接口](https://nodejs.org/api/fs.html)

`scripts/deploy/byok-d1-ingress-closure.mjs` 将固定 staging 目标的只读检查接入上述日志：核对 D1 UUID/名称，再进行两遍四个 staging Worker 的版本/配置、workers.dev/preview、Custom Domains、cron，三个生产配置、两个 Access deny-all、已知旧令牌和 gateway tail 检查。输入快照冻结；最多 60 秒，同一检查不重试，迟到响应不能改写失败结果。观察完成后另有 5 秒新鲜度检查。

成功时为 55 次**逻辑 API 读取**；服务令牌列表由既有有界传输层读取全部分页，所以不是固定 55 次 HTTP。两页令牌的通过测试实际发出 57 次模拟管理请求；另有旧令牌只出现在第二页的拒绝测试。

## 不可越过的边界

关闭观察明确返回 `knownIngressClosed`，但始终保持 `allInvocationPathsClosed:false`、`databaseQuiescenceProved:false` 和 `cleanupAuthorized:false`。其范围是上述已知入口，不是全部 zone Worker Routes、入站 service binding、排队请求或在途 SQL。两遍读取不是原子的云端锁；**不能把这个观察器直接当作 v259 清理模块的停写证明**。[Cloudflare workers.dev 配置](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

现有恢复控制 Worker 只绑定 `USAGE_RECOVERY`，自身没有 D1；已有 usage-recovery Worker 则有固定 staging `RECOVERY_DB`。本轮没有给控制 Worker 临时传入任意数据库，也没有改为通过管理 REST 代替原生 D1 验收。后续需按 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)明确受保护的 service-binding 清理通路、一次性授权和请求生命周期，并提供能够防止迟到写入的数据库侧边界。

日志元数据中的候选摘要由可信调用者提供，本模块不自行冻结/核验构建，也不证明预算充足。`attempt()` 是执行留证组件，不是完整步骤顺序、远端请求授权或费用策略。正式操作器仍须把新鲜隔离检查、基线、预算、控制记录、原生回执与未知结果隔离连接起来。

## 验证

- 新增 46/46：18 项主机日志、28 项关闭观察/集成测试。六个真实子进程竞争同一工作区仅一个成功；两项真实强制终止保留 PENDING，分别覆盖本地合成副作用发生前/后，之后新进程仍被拒绝。
- 既有传输/单调时钟 63/63、清理 40/40、一次性处理器 29/29、Images SSE 41/41，staging 类型检查及五文件语法检查通过。没有重跑完整 BYOK 204、dispatch、npm hook 链或远程 CI，不扩大此前结论。
- 首轮 44 项中 43 通过，部署分流反例因夹具与预期共用数组提前失败；已改为独立克隆并保留诊断笔记。最终验证在新的排他目录留存日志、模拟调用和本地进程测试文件；故意损坏的日志不解释为成功回执。
- 历史 7,366 条摘要在验证前后保持一致；没有改动旧源码、旧 manifest 或云端候选。测试只在临时本地工作区创建排他占位，实际项目的正式执行占位未创建。

复测：`node .wrangler/staging/verify-byok-operator-v260.mjs local-<新标签>`，目录必须不存在。[机器证据](./C02-byok-d1-operator-boundaries-v260-results.json)。

## 后续有限顺序

1. 完成数据库侧停写边界与独立、受保护的原生清理通路；未知/PENDING/失败样本继续隔离，不用延时或入口关闭替代证明。
2. 连接完整单次操作器：可信基线、构建校验、授权、固定用例、日志、关闭/回收、清理和最终独立复核。主机日志不替代云端控制记录的唯一 INSERT/CAS。
3. 冻结新入口/绑定/类型/构建并重新核验现有套餐和预算，随后一次原生执行；不自动升级套餐、创建新云资源或重放未知操作。

本轮管理/公开 HTTP、部署、模型/KMS 和生产写入均为 0；最后云观察仍为 v257 的 **2026-09-16T04:43:08.731Z**，远端仍 v232、公开 HTTP 累计 422，本轮未重验。首轮累计 **US$2 不重置**，历史/延迟预留 US$1.20、未分配预留 US$0.80 不变，不代表实际余额；最终增量账单未确认。

Images 不可逆成功点保持：有效 completed 图片 + 真实上游 `[DONE]`，先持久化再交付成功 DONE，此后取消不撤销费用。C02.G / C01、真实中途到期、MySQL/PostgreSQL/Hyperdrive 与 Workers 容量仍未通过。
