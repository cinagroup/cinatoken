# C02.B2.2 — Peer 一次性 CLI 与封闭部署衔接

日期：2026-09-09；Checklist v1.116。此文件及配套机器清单是**执行前的本地验证包**，不是云端执行结果。整体 STAGING_PARTIAL，C02 门禁仍未通过。有效 completed 图片与真实上游 DONE 均验证后的不可逆成功结算规则保持不变。

## 已接通的执行入口

新增 `scripts/deploy/staging-sse-capacity-peer-cli.mjs`，仅支持三个显式模式，无自动 import 执行、目标地址、生产环境、预算重置或 resume 参数：

- `--verify-local`：验证发布包、789 个构建输入及实际候选 bundle/config 摘要，不进行云端请求。
- `--deploy-closed`：独占保留本轮目录 → 离线冻结 bundle dry-run → 旧版本的实际只读前检 → 一次封闭部署 → 实际 settings/version/content、schema/counts、Access、账单前检 → 终态隔离复读 → 发布本次部署回执。
- `--run`：只接受本 CLI 的成功部署回执，核对发布包和 bundle 摘要、累计预算与部署状态；创建原始 session，随后同一 session/transport/preflight/resource-run 执行先前实现的读取、取消、原生 tail、恢复和收尾流程。不能用历史旧版本冒充 Peer V2。

执行命令（须从项目根目录；云端模式不属于 CI）：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/deploy/staging-sse-capacity-peer-cli.mjs --verify-local
node node_modules/tsx/dist/cli.mjs scripts/deploy/staging-sse-capacity-peer-cli.mjs --deploy-closed
# 只有部署回执 PASS 且实证已检查后才运行下一条：
node node_modules/tsx/dist/cli.mjs scripts/deploy/staging-sse-capacity-peer-cli.mjs --run
```

部署与验收分别独占 `.wrangler/staging/sse-capacity-peer-v218-deploy` 和 `...-run`。目录存在即拒绝再次执行，包括中途退出或前检失败；不得删除目录以重跑。异常终止需要基于原 journal 和云端实际状态单独分析，不自动恢复推理/RPC。部署阶段没有推理或公开 HTTP；前后只读检查共享同一单调时钟。之后推理阶段建立唯一原始 session，不复用已结束进程的计时样本，也不重置累计预算。

## 日志、进程和隔离边界

- journal 使用独占文件、追加写入和逐次 fsync；最终结果只写一次。密钥/Access credential/tail URL 被拒绝写入；子进程输出仅记录长度和 SHA-256，原 Wrangler 日志限制在本轮工作区目录。
- Wrangler 使用固定 Node executable/参数数组，无 shell；固定冻结 bundle、配置、账户、D1、service binding，禁用自动配置/资源创建。dry-run 不向子进程传入 Cloudflare API credential，日志与 metrics 设置显式固定。没有变更兼容日期或绑定，因此不另行生成类型；联合 staging 类型检查继续运行。
- 子进程最长 180 秒，输出最多 256 KiB；超时、取消或超限均终止并保留不确定标记，不因随后返回 close 而升格成功，最多再等 5 秒确认退出。没有新建订阅或付费模型调用。
- 一旦尝试部署，即使上传回执、日志或 settings 比对失败，也独立复查四个 staging 入口/预览、域名和 cron，以及生产 settings 和双 Access 摘要。发现网关或控制器入口未关闭时，仅对这两个已授权 staging 目标执行关闭并复读；其他漂移保留 ATTENTION_REQUIRED，不回滚生产或猜测配置。
- `--run` 的 SIGINT/SIGTERM 停止新的公开请求并中止现有公开 fetch；管理收尾不受该信号禁止，以便安全撤销 key 和关闭资源。进程强杀/掉电不声称一定清理完成，独占目录和持久化 PENDING 用于阻止误重放。

命令语义核对当前 [Cloudflare Wrangler Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)，实际安装版本为 4.127.1。使用 `--no-bundle` 上传已验证构建产物；独立 staging 的冻结配置优先于技能中的通用自动创建资源建议。

## 验证与未完成项

新增 24 项本地测试：参数拒绝、原时钟/预算、历史 token 去重、配置边界、真实临时目录的独占持久化及秘密拒绝、无 shell 的固定子进程、超时/输出超限/取消、前检和持久化失败阻止上传、上传不确定/版本不变/settings/后检/隔离失败，以及无效部署回执拒绝。管理 API、前检和子进程在这些测试中为模型；不代替实际平台证据。CI 定义 Node 22/24，但远程 CI 未执行。

本地联合回归预期 1,833 项，最终是否通过及源码摘要以[机器证据](./C02-images-sse-capacity-peer-cli-results.json)与[验证结果](../../../../.wrangler/staging/sse-capacity-peer-v218-verification-result.json)为准。发布器只接受全部通过且类型检查成功的结果。另用真实 Wrangler 4.127.1 执行该子进程封装的冻结 bundle dry-run，退出码 0、无超时，源码前后摘要一致；[离线子进程结果](../../../../.wrangler/staging/peer-cli-v218-offline-child/result.json)已保存，没有云端部署。

本发布包生成时：未部署或新增云端 API/公开 HTTP，首轮公开 HTTP 累计 382，真实模型/KMS 为 0/0，累计 US$2 上限不重置，最终增量账单尚未核验。最后已发布实际云端观察仍为 v1.108（2026-09-08T12:59:42.118Z），容量 INCONCLUSIVE_HELD。如随后执行云端模式，必须另行记录本次回执和累计调用，不能把本文的执行前状态当作最新云端状态。

完整 Workers 线上 Peer V2 验收、物理容量/跨消费者、unknown/幂等、C02.G、C01 剩余决策以及 C03–C20 仍开放。
