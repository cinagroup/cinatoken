# C02：Gemini 公开入口 deadline 与流错误状态（v237）

2026-09-09 · Checklist v1.136 · LOCAL_PASS，未部署；整体仍为 STAGING_PARTIAL。

## 已完成的本地修复

Gemini 的 `/v1beta/models/:modelAction` POST 原本未进入统一入口生命周期，`proxyGeminiContent` 也没有默认绝对 deadline。现已从统一中间件进入时捕获原始时间和发送预算；Gemini guardrail、模型规划与出站使用同一个原始 300,000 ms 时间窗口，不能在准备完成、切换候选或再次 dispatch 时重新起算。默认时限同现有文本合同；内部调用只能收紧，客户端不能延长。

入口覆盖实际单段 POST 路由，也先约束无效／编码 action 参数，再交给 Gemini 路由校验；GET、catalog、其他前缀和额外子路径不被新增匹配器覆盖。上传复用原有 50 MiB 有界读取器，取消／超时不再被 JSON catch 误报为 400。

请求初始化和旧密钥查询可能创建资源或迁移数据，不能直接竞速后丢弃。它们收尾后检查停止状态，不再进入推理。Gemini guardrail 向共享引擎传递 PreparationControl；只读工作可以结束等待，审计写入由原请求持有到终结，即使拒绝也保留原取消／deadline 分类。已经启动的预算准入同样保持所有权，结束后不发送推理，并按照现有未发送成本规则结算。

公开 Gemini 路由还补上两个错误传播点：

- 只根据可信内部 `gatewayGeneratedError` metadata 保留网关错误，避免 `gateway.request_deadline_exceeded` 被重新规范化为 `upstream.server_error`；上游自己的头部不授予这个信任。
- `stream_error` 同时进入 request log 状态和 unknown 成本判断；部分 usage 之后的失败不再标 success。日志只保留固定流错误／deadline 摘要，不暴露任意传输异常内容。

## 验证范围及结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 初始专项 | 26 FAIL | 包含 8 条错误的“初始化／旧密钥查询可立即放弃”测试假设，不能称作 26 个实现缺陷 |
| 第一版修复 | 16 PASS / 10 FAIL | 8 条所有权假设待纠正；2 条发现可信 deadline 错误被上游错误规范化覆盖 |
| 第二版专项 | 26/26 PASS | 校正所有权假设，保留原测试与中间源码；不是同源码前后全绿对照 |
| 最终专项 | 33/33 PASS | 再加 4 项审计 ACK resolve/reject、2 项预算准入等待、1 项包含 13 个路径/方法断言的匹配器测试 |
| 完整 dispatch 回归 | 2,903/2,903 PASS | 含全部 33 项新增、既有 Gemini 取消、文本/图片及调度安全用例 |
| 类型检查 | dispatch / staging 均 PASS | 不等于 Workers 原生验收 |

最终 33 项覆盖两个 Gemini action 的 storage/auth/guardrail/model × client/deadline、未完成上传取消、准备已耗时后的 pending fetch/JSON/SSE 原始 deadline、无 usage/部分 usage 后流失败，以及所有权和匹配器边界。

验证使用真实 Hono 入口、鉴权、模型规划、驱动与 usage writer；仓储返回合成行，SQL sink 捕获实际生成的写入意图，不执行真实数据库事务。因此“一次记录、未知成本保留上限、未发送准入结算为零”等为本地 SQL 意图证据，不是线上财务提交证明。流错误改为 error 会进入 `recordUsage` 既有的错误计费分支（样本 charged=0）；unknown 的预算保留仍是独立决定，不能因此声称买家预算已无条件退回。没有修改共享计价公式。

另外，v236 的四项客户端 signal 场景更新了最后 `body.cancel()` 的断言：新公开 deadline 响应包装器保留取消错误，测试应验证该错误，不再假定公开 body 始终优雅关闭；直接驱动清理规则不变。

## 可复验入口

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-concurrency=1 --test-name-pattern=Gemini packages/proxy/src/routes/v1/request-dispatch-limit.test.ts packages/proxy/src/services/egress/gemini-cancellation-wire.test.mjs packages/proxy/src/services/egress/gemini-settlement-lifecycle.test.mjs
node node_modules/typescript/bin/tsc -p packages/proxy/tsconfig.dispatch-safety.json --noEmit
node node_modules/typescript/bin/tsc -p packages/proxy/scripts/staging/tsconfig.json --noEmit
```

冻结证据为 `.wrangler/staging/gemini-ingress-v237-{before,after,after-r2,after-r3}.{json,log}` 及 `gemini-ingress-v237-verification.json`。操作器输出采用独占写入，不应覆盖重跑；完整命令和日志摘要保存在 receipt 中。已有 Gemini CI workflow 会执行这些 `Gemini` 命名测试，本轮没有执行远程 CI 或验证 Node 22。

## Workers 边界及下一步

按 workers-best-practices 技能复查 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)与最新 `@cloudflare/workers-types`：官方 npm 只读查询为 `5.20260908.1`，复用相同已下载类型检查 AbortController/AbortSignal；未安装依赖或改动配置。staging 原有 `nodejs_compat` 与 `enable_request_signal` 不变。

入口绝对 deadline 是停止新执行的合同，不意味着所有已启动数据库写入、存储初始化能在同一瞬间被中断。当前这些工作需要原 owner 收尾，可能超出 300 秒；数据库自身时限／初始化资源清理仍需单独补验。后台 reader 清理仍未作为独立资源完成任务接入全部容量持有者和 Workers 生命周期。根据官方生命周期要求，不用 Promise 引用或本机 Node PASS 替代真实 Workers 验收。

下一步先落实跨驱动独立资源完成合同（含文本及 TTS），区分账务事实、清理终结、未确认资源和容量状态；再准备新的冻结构建与受控原生验收。原实例容量、C02.G、C01 及后续依赖继续开放，生产容量保持未启用。不以碰撞请求发现同实例，不重放已消费的推理、RPC 或上传。

Images 已确认的成功结算点不变：有效 completed 图片及真实上游 `[DONE]` 经网关验证后，先持久化成功事实再交付成功 DONE，后续客户端取消不撤销费用。

## 历史与费用

继承 v236 的 2,093 条摘要并核验，受影响旧文件按字节归档到 `.wrangler/staging/gemini-ingress-v237-before-source/`；新清单以原路径＋SHA 显式映射，旧 manifest 不重写。保留首轮测试假设错误和两版中间源码，精确数量见 [机器结果](./C02-gemini-ingress-v237-results.json)。当前源码不匹配旧云端 bundle，下一次部署必须新冻结构建，旧 CLI 应拒绝漂移。

本轮 staging 管理／公开 HTTP、部署、生产写入、真实模型和 KMS 调用均 0。首轮累计公开 HTTP 422，真实模型/KMS 0/0，US$2 累计上限不重置；US$1.20 历史及延迟用量预留、US$0.80 未分配预留仍为操作预算而非已核验费用。最新云端观察仍是 v232 的 2026-09-09T06:45:06.937Z，本轮未重新核验远端状态或最终增量账单。
