# C02 v268：固定现有 staging Worker 部署适配器

2026-09-21，Checklist v1.167。DEPLOYMENT_LOCAL_PASS / STAGING_PARTIAL。没有实际部署或开启独占阶段；完整操作器和 C02.G / C01 原生准入仍未完成。

## 实现

新增 `scripts/deploy/byok-d1-deployment.mjs`，只依次更新现有 **usage-recovery → recovery-control → gateway** 三个 staging Worker。新增三个 journal 步骤，每步发送请求前先将 PENDING 刷盘；一个上传结果未知、读回不符或日志失败即停止整条部署链，不重发、不自动回滚，不创建替代 Worker，不开放入口，也不查询/写入 D1 数据。

候选指纹覆盖 run、之前的证据清单、三个代码摘要、固定上传元数据、旧 settings 摘要和旧版本 ID；与排他 journal 的身份精确绑定。构造时复制候选信息，调用者后续修改对象不能改动待上传字节。每个代码模块最多 1 MiB；上传只含固定 `metadata` 和单一模块，不接收自选账户、资源名、URL、SQL、资源创建或回滚指令。

固定元数据仅包含现有 staging D1 / 私有 service binding、staging 控制变量、两个已知 Access audience，以及仅含摘要的短期安装 grant。接收端绑定 `RECOVERY_DB`；controller 只绑定现有接收端 `UsageRecovery`，没有 D1；gateway 只绑定 `BYOK_DB`。不继承旧绑定/资产，不带迁移、容器或新基础设施声明；compatibility date 和 nodejs_compat 与现有候选配置一致。专用功能变量在候选中启用，但 workers.dev、preview 和 Access 策略须始终保持关闭；真正开启由上一轮适配器单独执行。

每步先读取现有 D1 身份、旧 Worker settings / 唯一 100% 版本、workers.dev / preview、custom domains / cron 和两个 deny-all Access 应用。拒绝不存在的 Worker、资产/容器/迁移状态、非预期存储绑定、tail consumers / streaming tails / logpush；不存在时不会尝试上传来自动创建。已经完成部署的前置 Worker 也在后续步骤前后重新核对版本和 settings。

采用固定立即部署 PUT，禁用重定向和自动重试。成功响应不直接放行：独立读取新版本和精确期望绑定/兼容设置，完整下载代码核验 SHA-256，再次读取关闭状态、前置 Worker、当前版本和完整 settings 摘要。multipart 内容必须恰好一个预期名称的代码文件，不能以“其中有一个模块摘要相同”忽略多余模块。允许单模块原始 JavaScript 响应和 D1 `id` / `database_id` 输出别名，但不允许新增绑定或冲突 ID。

每步整体最多 60 秒、40 次读取和一次上传；响应最多 2 MiB / 4,096 次读取，校验完整 EOF、Content-Length、JSON envelope 和代码类型。单调时间检查贯穿每次请求和解析，外部取消/超时后不进入后续上传，晚到响应释放。每个上传前再次执行同步可信 `assertReady(role)`，拒绝已过期 grant、未完成预检/关闭观察、已经开始 Access/用例/收尾或异步 Promise 冒充准入。

该守卫仍由完整操作器提供真实的代码、部署身份、隔离、实际套餐和 US$2 预算证明；本模块不生成这些证明。读后写不是云端 CAS，不能排除外部管理员并发删除/修改；关闭检查也不包含全部 zone routes 或跨 Worker incoming bindings，不证明旧调用/D1 写入已经停止。返回字段明确为 workers.dev / preview / 已观察 custom domains 与 cron 的事实，不宣称所有调用路径均关闭。

## 验证

- 最终部署模块源码 **53/53**，Node 打包版 **53/53**。
- 三份真实 Wrangler dry-run 字节接入打包后的部署适配器，专项运行 **54/54**（包含前述 53 项复测及一项真实产物检查）；仍为模拟管理 API，没有真实上传。
- 相关回归 **302/302**：Access 59、journal 18、安装链 52、管理 40、用例调用 42、清理调用 22、关闭观察 28、Images SSE 成功边界 41；staging TypeScript 通过。
- Wrangler 4.127.1；三份既有 Worker 配置实际离线 dry-run 通过。Worker 源码/配置没有改动，故未重新生成绑定类型。Node 24.14.1，不宣称 Node 22、原生 Workers/D1、原生 Access 或远端 CI 通过。

初轮本地测试和 dry-run 均通过，但新增真实产物检查揭示了 **相对 outdir 的路径问题**：Wrangler 在 workspace 根目录写 README，实际 JS / map 写到配置目录下的同名相对路径，因而追加检查出现 53 PASS / 1 FAIL（ENOENT）。改用绝对输出目录后重新执行全部测试和三个 dry-run，真实字节检查通过。失败报告、两个阶段的旧源码以及配置目录下的历史产物全部保留，未覆盖或删除。

上一轮安装测试的未复现异常在本轮常规回归继续通过；原因仍未确认，未将其标记为已修复，也未放宽时钟或取消规则。此次没有改变安装器或 Images 不可逆成功结算点。

修改前已核验 **13,886 条历史普通摘要及十条链接目标**；journal 旧版本归档映射，不改写旧 manifest。最终回执 `.wrangler/staging/byok-deploy-v268-local-absolute/result.json`；[机器证据](./C02-byok-d1-deployment-v268-results.json)。真实项目的 BYOK 执行占位仍未创建。

## 技能、云状态与后续

Cloudflare / Wrangler 技能促使本轮核对固定绑定与官方上传协议、保留默认关闭配置，并实际执行离线打包；不采用技能中的自动创建资源建议。参考[模块上传 API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)、[multipart 元数据](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/)和[原生 Access 上下文](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)，同时核对已安装 Wrangler 的上传构造与版本处理代码。Firecrawl CLI 不可用，直接读取官方文档；没有账户 API 调用。

云管理/公开 Worker 请求、部署、凭证创建、D1 读写、模型/KMS 和生产写入均为 0，无新增云资源。最后完整云观察仍 v257，v264 完整代码读取失败不因本地绿灯而消除。公开 HTTP 累计 422，首轮累计 **US$2 不重置**；US$1.20 历史/延迟预留与 US$0.80 未分配预留保持，不视为实际余额，最终账单和实际套餐资格未确认。

下一步按有限顺序执行：

1. 将现有部署、Access、安装、D1 管理、用例、STOP/封闭、清理和最终独立核对接成一个不可重放的完整操作器；禁止以散调用代替准入。
2. 解决双轮关闭观察时延、维护许可窗口和独占结束后的受控恢复。保留关闭围栏，不自动恢复其他实验或清理未知样本。
3. 冻结完整候选，重新取得全部代码/版本/隔离/实际套餐/费用预检，并跟踪未复现安装异常，再执行已授权的原生独占 staging 验收。
