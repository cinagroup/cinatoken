# C02.B2.2 — OAuth 辅助认证生命周期（Node 本地子集）

日期：2026-09-05。状态：**已列 Node 子集 LOCAL_PASS；Workers 运行时启动失败，未验收；C02.B2.2 / C02 整包仍为 DOING。** Owner / 本地自检：Codex（当前任务）；独立 Reviewer 待指定。

接续[准备取消证据](./C02-preparation-cancellation.md)，不覆盖其历史快照。[Google Cloud KMS 选型](./C01-google-cloud-kms-selection.md)不变；本文件处理现有 Vertex service-account OAuth，不是 Credential Vault/KMS 接入。本轮仅本地代码、测试、CI 配置和文档，没有云账号操作、真实认证/KMS、数据库迁移、部署、付费模型或资金操作。

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。开始时已有 90 个修改/未跟踪文件并记录摘要；保留无关改动。当前源码及结果见[受测快照](./C02-oauth-lifecycle-snapshot.json)。

## 实际改动

| 边界 | 已实现行为 |
| --- | --- |
| 单次认证时限 | 本地上限 30 秒，可由内部调用收紧、不能提高；从缓存指纹计算到私钥导入、签名、fetch、响应读取共用一个绝对时限，收到 headers 不续期。与文本请求的总 deadline/client signal 联动 |
| 取消与清理 | 密码步骤间检查；fetch 接收局部 signal；忽略取消的 transport 也不能让等待永久挂起。迟到 Response 被取消，不用于缓存或后续发送；body reader 始终释放，取消确认不返回也不阻塞退出 |
| 响应上限 | 成功响应按实际字节累计，最多 64 KiB，不信任缺失/较小的 Content-Length；非成功响应不读取正文，直接取消。禁止自动跟随重定向，每次 exchange 最多一次显式 fetch，无内部重试 |
| 错误材料 | 错误只使用固定分类/消息和可选 HTTP status；不反射原始 OAuth 正文、JWT、私钥、客户端取消理由或 transport 错误文本 |
| 跨请求状态 | 删除全局 in-flight Promise；每次冷认证由本请求独立拥有。只缓存已验证的完成 token；键使用包含账号/私钥/endpoint/scope 的 SHA-256 指纹，不在 Map 键中保留 PEM |
| 有效期与容量 | 校验 token、expires_in 和已提供的 token_type；不为缺失有效期补一小时，不将短有效期提升至 60 秒；从请求发起时间保守计时。缓存最多 256 项、按使用淘汰，清缓存后的旧请求不能回填。**256 是内存缓存容量，不是可登记供应商账号数上限** |
| 出站接入 | Chat、Responses、Messages 和 Gemini driver 将 signal 传入 OAuth。Gemini 补取消前置及 fetch 边界检查，预取消返回 499/零用量/不发送；未重写其既有已接受 SSE drain 协议 |

核心源码：[OAuth 操作生命周期](../../../../packages/core/src/gcp-oauth-lifecycle.ts)、[token 交换与缓存](../../../../packages/core/src/gcp-service-account-token.ts)。可选参数兼容未传 signal 的既有调用者；这些调用仍获得单次 30 秒/64 KiB 限制，但不自动获得整个请求取消合同。

采用 Workers 最佳实践技能后，取消了跨请求共享未完成 I/O，保留完成数据缓存，并显式清理每个请求的 timer、listener 和 reader。依据 [Cloudflare 请求局部状态规则](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#do-not-store-request-scoped-state-in-global-scope)及 [Request signal 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)。token 有效期处理参照 [Google OAuth 服务账号响应合同](https://developers.google.com/identity/protocols/oauth2/service-account)，已提供的 token_type 按 [RFC 6749 §5.1](https://www.rfc-editor.org/rfc/rfc6749#section-5.1)忽略大小写验证，并有混合大小写用例。没有改变厂商选型或宣称缓存取代授权检查。

## 测试与实际结果

环境：Windows，Node **24.14.1**；项目 `.nvmrc` 为 **22**，Node 22 尚未执行。已安装 Workers types **5.20260829.1**；最新 npm 查询被 EACCES 拒绝，按技能回退本地类型。Miniflare **5.20260828.0-alpha** / workerd **1.20260828.1**；未升级依赖或安装系统运行库。

新增 **43 项 Node 测试**：Core OAuth 新增 30 项（文件共 38 项），Proxy Vertex 新增 13 项（文件共 15 项）。覆盖超时/取消、迟到 body、永不确认取消、不同密码步骤间停止、实际字节/声明字节上限、错误正文不读、不缓存无效/过期 token、并发请求隔离、清缓存竞态、容量淘汰及实际三协议 dispatcher 的零准入/零推理/非 unknown 断言。专项 script 和专项类型检查收集两个文件，已有主套件继续收集各自测试。

| 验证 | 实际结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `npm.cmd test -w @octafuse/proxy` | 完整生命周期退出 0；最终主 suite **819 tests / 134 suites，819 通过** |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | **319 tests / 23 suites，319 通过**，退出 0 |
| `npm.cmd run test:unit -w @octafuse/core` | 完整生命周期退出 0；最终主 suite **366 tests / 70 suites，366 通过** |
| `node packages/proxy/scripts/test-oauth-workerd.mjs` | **退出 1，运行时未能启动**；不是用例通过或跳过 |
| `node packages/proxy/scripts/test-oauth-workerd.mjs --runtime-smoke` | **退出 1**；最小空 Worker 同样在启动时发生 `0xc0000005` / `ERR_RUNTIME_FAILURE` |
| workerd 二进制 `--version` | 退出 0，返回 `workerd 2026-08-28`；只证明版本命令可运行 |
| `git diff --check` | 退出 0 |

成功的 Node 套件均为 0 失败/取消/跳过，计数重叠不能相加；不包含失败的 Workers 验证。初次类型检查发现 Workers TextDecoder 需要显式 ignoreBOM，以及历史测试 fixture 缺少必填 route 字段，均已修正。初次完整回归发现 Gemini 旧用例要求预取消后仍发送并读出 5 tokens；本轮修复前置取消，并加强四协议断言为 **0 fetch、499、0 tokens**，不是删除失败用例或恢复错误发送。

[workerd 脚本](../../../../packages/proxy/scripts/test-oauth-workerd.mjs)在内存编译[隔离 fixture](../../../../packages/proxy/src/services/egress/fixtures/oauth-workerd-fixture.ts)，运行时生成测试 RSA Key、拦截 OAuth 并拒绝 Worker 外部网络；已配置 5 个场景，但本机未到断言阶段。原生启动失败根因未确认，不能直接认定是 VC++ 版本问题。新增 `test:oauth:workerd`，并加入已有 Ubuntu / Node 22 [CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)；没有触发远程 CI，不以 YAML 中有步骤替代执行证据。

## 剩余范围与唯一下一步

下一项仍为 **C02.B2.2**，优先补**跨模型/凭据回退共享的辅助认证次数预算及全调用链核验**，再推进数据库边界与 headers/有效 TTFT/idle，不能宣布整个 OAuth/C02 门禁已通过：

1. 当前限制的是单次 exchange 的时间/字节/重定向；OAuth 失败发生在推理 permit 之前，尚没有跨候选共享的辅助认证次数上限。快速失败、多账号冷缓存与其他辅助 IO 仍需统一计数/停止规则，不能用“模型发送最多 3 次”推断 OAuth 最多 3 次。
2. 完成 token 可以复用，冷认证不再跨请求合并，可能增加同一账号并发冷启动时的 OAuth 调用；须量化 QPS、缓存命中和 quota。若需要跨请求协调，应由有明确独立生命周期的 Broker 承载，不恢复共享 request-owned fetch Promise。
3. 自定义 token_uri 仍沿用既有配置能力，本轮只禁止 redirect，没有实现完整 endpoint 允许列表/SSRF/委托凭据校验；生产授权与服务身份仍属未完成门禁。缓存不是吊销检查，实际 token 使用前的权威授权仍需 C06–C09。
4. 音频、图片、Rerank、Embeddings、实时和管理端等调用者尚未逐一接入 signal；Gemini 已接受流的生命周期、原生/转换协议支持也不能由 OAuth 用例推断完成。已运行的 Web Crypto 不可物理中断，只阻止迟到后继续工作。
5. SQL 取消/写入超时恢复、准备阶段全池读取/解密、分阶段流时限、Node 22 和真实 Workers/DB 验证继续保留。Workers 原生启动问题只阻塞该验证，不阻塞安全的本地代码推进。

停止/回退：若认证取消仍触发推理、错误泄密或缓存跨身份复用，暂停受影响入口并修正合同；不恢复无界正文、全局未完成 I/O 或取消后的发送。没有生产部署可回滚，没有删除用户数据或改写历史账务。
