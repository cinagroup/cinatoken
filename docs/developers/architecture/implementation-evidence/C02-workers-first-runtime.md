# C01.9 / C02.B2.2 — Workers 首发决定与本机原生启动故障

2026-09-06。用户明确选择：**Cloudflare Workers 优先，Node 作为备选**。本记录确认首发正式验收目标，不授权部署、安装系统组件、云资源或新增第二入口。Node 24 的历史容量样本不能代替 Workers 证据；Node 22 / Node host 的备用验收仍保留，但不再把它们作为当前优先实现路线。

## 1. 决定的范围

> 后续更新：用户已确认使用与生产隔离的独立 staging。[最新准备证据](./C02-staging-preparation.md) 已证明 Windows 能完成离线发布打包；下面第 3 节保留为当时的历史排障顺序，不再作为唯一下一行动。当前按 [staging 运维说明](../../../operators/deployment/cloudflare-staging.md) 推进，本机系统修复仍需单独授权。

C01.9 只完成 runtime 优先级这一子决定。数据库、区域、首发协议 / 模态、Cron / Queue 开启范围、Cloudflare 逃逸方式以及 C01.10 的服务目标 / 余量仍未全部冻结，不勾选 C01.9 / C01.G。Google Cloud KMS / project `cinatoken` 的既有决定不变，没有重复访问云项目。

本轮最初只读检查 Node 停机链；收到用户选择后停止该方向，**没有修改 Node host / Realtime / 数据库关闭代码**。继续保护既有功能、50 MiB 入口 / 20 MiB 文件 / 32 MiB 普通上游和已批准 Images 字段限额，不用降低能力或切换 Node 来替代 Workers 首发目标。

## 2. 新的直接原生诊断

新增 [诊断入口](../../../../packages/proxy/scripts/test-workerd-startup.mjs) 与 [最小模块](../../../../packages/proxy/scripts/fixtures/workerd-startup/smoke.mjs)，运行 `npm run test:workerd:startup -w @octafuse/proxy`。它不加载 Miniflare、Hono、OAuth、模型、业务配置或数据库，不开监听端口，配置的 internet network allow 列表为空。直接启动已安装 workerd，每个子进程最长 15 秒、输出最多 32 KiB；仅继承少量系统路径环境。它不下载二进制，不修改 DLL、环境变量、注册表或安全设置。

两个独立配置沿用实际兼容日期 `2026-08-24`：[plain](../../../../packages/proxy/scripts/fixtures/workerd-startup/plain.capnp) 不带兼容 flags；[compatible](../../../../packages/proxy/scripts/fixtures/workerd-startup/compatible.capnp) 使用 `nodejs_compat` / `enable_request_signal`。成功必须同时满足原生退出 0 和测试通过标记，不能把 CLI 能打印 help / version 或未进入测试当作通过。

| 证据 | 本轮结果 | 能 / 不能说明什么 |
| --- | --- | --- |
| 两个直接原生配置 | 均约 0.2 秒退出 `3221225477`（`0xc0000005`），模块进入 / 测试进入 / 通过标记均未出现 | 应用代码、Miniflare 包装和上述兼容 flags 不是复现所必需；并非应用断言失败 |
| 已安装运行时 | workerd `1.20260828.1`，二进制 SHA-256 见结构化证据；Node `24.14.1` / Windows x64 | 固定复现版本；不代表最新版本、Node 22 或生产 Workers |
| DLL 文件版本只读检查 | `MSVCP140.dll` / `VCRUNTIME140.dll` 为 `14.00.24215.1`；`VCRUNTIME140_1.dll` 为 `14.51.36247.0` | 发现新旧 VC++ 组件并存，不能仅凭文件存在认定依赖正常 |
| 对本轮创建的最小进程读取模块范围 | 栈首地址映射到实际加载的 `MSVCP140.dll`，偏移 101427，版本 `14.00.24215.1` | 将原生崩溃进一步定位到旧 C++ 运行库；是强诊断线索，但尚未经修复后重测确认根因 |

完整结构化结果见 [原生诊断 JSON](./C02-workers-startup-diagnostic.json)。模块定位仅读取本轮创建的进程的模块名称、地址范围和文件版本；未抓内存转储、未检查其他用户进程或系统事件中的业务信息。首次模块轮询未刷新缓存，只看到主模块，未给出 DLL 结论；补刷新后观察到 24 个模块并完成定位，不把首次不足的证据当作成功。所有探针进程均已终止。

前轮受限 / 获准解除沙箱的 Miniflare 最小测试均在原生阶段失败，记录保持；本轮不重跑相同 Miniflare 失败来冒充新证据。新增的是去掉包装器 / flags 的直接复现及实际加载模块定位。

## 3. 当前阻碍和有限下一步

**优先建议修复本机 Microsoft Visual C++ x64 运行库，再重跑同一最小诊断。** 这会修改系统组件，超出目前仅本地项目代码 / 测试授权，必须先获得用户明确许可；本轮没有下载、安装、复制或替换任何 DLL。微软官方文档读取曾成功返回 x64 官方下载链接；后续正文读取发生传输错误，没有据此宣称最新安装包版本或已验证安装兼容性。[微软官方下载说明](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)

获准后的顺序：

1. 从微软官方渠道取得 x64 安装包，核对来源、数字签名、安装 / 修复与重启要求，再执行获准的系统变更；不得下载第三方 DLL、禁用防护或用 V8 安全开关掩盖崩溃。
2. 重跑 direct plain / compatible 两个测试；未通过前，不能继续宣称应用运行时验收。如果修复不解决，保留证据并重新定位，不无限重装。
3. 直接运行时通过后，再跑已有 Miniflare 最小 / OAuth 生命周期测试。逐层通过后，接入真实 Workers 执行环境的 Images 全链路、容量 / 跨请求取消与后台持有验证；本地 workerd 通过也不等于线上容量、账务或平台终止恢复已验收。
4. 完成首发能力、数据库、服务目标与消费者范围冻结，补真实运行配置下的剩余工作集 / 恢复证据，最后计算并验收生产容量；不自动部署。

若不允许修复本机系统，需要用户指定现有可用的 Workers 验收环境并提供相应测试授权。Node 备用路线不自动接替首发目标，也不自动安装 WSL / Docker、创建云测试 Worker 或运行远程 CI。

## 4. 验证与状态

本轮仅增加诊断脚本 / fixtures、独立手动入口与文档，没有改生产实现或普通回归测试范围。两项脚本语法检查、差异空白检查通过；两个原生测试均如实记录为失败。未重跑主 suite / 安全 suite，不把前轮 3,051 / 2,678 项或 6 组 Node 样本写成本轮 Workers 通过证据。

Workers 最佳实践技能要求检索平台资料并独立核验运行时，本轮据此保留启动层 / 应用层 / 线上平台的不同门禁。网页工具连续不可用；回退阅读已安装 workerd 的 CLI test 帮助、配置 schema、workers-types `5.20260829.1` 的 ExecutionContext 和 Wrangler schema，不声称已取得最新 types。没有更改生产兼容日期 / flags。

C00 LOCAL_PASS；C01 / C02 DOING；C03–C20 TODO；生产容量未启用，C02.G 未通过。当前具体下一行动为等待系统修复授权；本轮有新诊断证据和首发决定，整个目标未完成，未达到连续三轮无可用进展的 blocked 审计条件。

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`；起点 283 个 dirty/untracked 文件；前轮 239 文件快照修改前全部匹配。本轮 [245 文件快照](./C02-workers-first-runtime-snapshot.json) 单独保存；收尾哈希全部匹配，5 份当前文档的 80 个本地链接目标存在（不是锚点 / 渲染验收）。最终 290 个 dirty/untracked 文件，更新既有 5 份、新增 7 份；起点文件无缺失、其他修改保留。无提交、安装、系统修复、部署、云写入、真实 KMS / OAuth / 模型、业务库、迁移、支付或远程 CI。
