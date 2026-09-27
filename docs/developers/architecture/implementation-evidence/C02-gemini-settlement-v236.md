# C02：Gemini 取消事实与清理 ACK 分离（v236）

2026-09-09 · Checklist v1.135 · LOCAL_PASS，未部署；总体仍为 STAGING_PARTIAL。

## 结论

v234 的 Gemini pump 在 `finally` 中先等待 `reader.cancel()`，之后才完成 usage。真实公开 `/v1beta/models/{model}:streamGenerateContent` 路由依赖这个 usage Promise 记录取消和结算预算；不可信上游若不确认取消，会把记账拖到安全兜底超时。此前“usage 等待清理即可证明所有权”的表述不成立，本轮明确纠正，不重写历史证据。

修复后 usage／取消事实先完成；取消清理仍由请求 pump 独立等待，确认终结后释放 reader 锁。正常 EOF 无需取消清理，usage 保持不变。下游使用 `TransformStream.terminate()` 关闭 readable、解除阻塞写入；关闭日志采用固定结构化字段，不输出私有取消原因。

这不是完整资源容量方案：pump 保持 Promise 引用不等于 Workers 在断连后必然继续执行；清理尚未作为独立资源完成任务接入所有容量持有者／`waitUntil`。清理 ACK 拒绝、reader 解锁均不是远端物理释放证明。

## 可复验结果

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| 同源码前后对照 24 项 | 12 PASS / 12 FAIL → 24 PASS | 修复前后测试文件 SHA 相同；v234 的 4 项旧假设在这次对照开始前已校正并归档 |
| 新增公开路由 8 项 | 8/8 PASS | 真实鉴权、模型规划、准入、驱动、usage writer；存储端为合成 SQL 捕获，不证明真实数据库提交 |
| 新增生命周期 8 项 | 8/8 PASS | JSON/SSE 正常 EOF、零 token、迟到取消、无效 UTF-8、半事件取消、驱动 deadline 与 pending ACK |
| 完整 dispatch 回归 | 2,870/2,870 PASS | 包含上述测试、文本重定向／三类文本取消及 Images 既有测试；没有跳过失败用例 |
| dispatch / staging TypeScript | 两项 PASS | 不等于 Workers 原生运行验收 |

公开路由覆盖：客户端 signal / 下游 body cancel × 静默上游 / 阻塞写入 × 清理 resolve / reject。断言在 ACK 仍未完成时后台记账已结束、仅一次发送、一次准入、一次日志批次、unknown 预算转换为 expired 且保留正的预算金额；pump 此时仍持有 reader。ACK 随后终结只释放 reader，不新增记录或重放请求。测试清理钩子最终释放合成 ACK，避免故意挂起影响后续用例。

前后对照可读 `.wrangler/staging/gemini-settlement-v236-{before,after}.{json,log}`；完整结果为 `.wrangler/staging/gemini-settlement-v236-verification.json`。冻结操作器采用独占输出，不应覆盖重跑。普通开发复验可执行：

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-concurrency=1 --test-name-pattern=Gemini packages/proxy/src/services/egress/gemini-cancellation-wire.test.mjs packages/proxy/src/services/egress/gemini-settlement-lifecycle.test.mjs packages/proxy/src/routes/v1/request-dispatch-limit.test.ts
node node_modules/typescript/bin/tsc -p packages/proxy/tsconfig.dispatch-safety.json --noEmit
node node_modules/typescript/bin/tsc -p packages/proxy/scripts/staging/tsconfig.json --noEmit
```

本轮新增 16 个测试、校正 4 个历史测试，不把全部 32 个 Gemini 测试都称作新增。Gemini CI workflow 已接入，但本轮未执行远程 CI；Node 22 未验证。

## Workers 依据与当前限制

按 workers-best-practices 技能复查官方文档及类型。官方 [兼容性标志](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#compliant-transformstream-constructor)注明标准 TransformStream 构造器自 2022-11-30 默认启用；本仓库 staging 日期为 2026-08-24，未禁用该构造器。官方 npm 查询确认最新 `@cloudflare/workers-types` 为 `5.20260908.1`，与已下载类型相同，其 controller 提供 `terminate()`。第一次受限网络查询 EACCES，第二次获准只读查询成功，没有安装或更新依赖。

[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)要求响应后工作使用合适的生命周期管理，并明确 `waitUntil` 的断连后时限；本轮因此不把已观察的 Promise 或本机 Node 测试包装为原生容量证明。

## 后续有序缺口

1. Gemini 公开入口的统一绝对 deadline：`isTextInferenceRequest` 不包含 `/v1beta/models/...`，公开 Gemini 路由也没有传入 `requestDeadlineAtMs`；`proxyGeminiContent` 仍使用 `delegatedDispatchOptions`，不同于带默认 deadline 的文本路径。本轮只验证传入 deadline 信号的驱动行为，没有补此入口合同。
2. Gemini 流错误日志状态：路由把 `stream_error` 传给成本 unknown 判断，却没有传给 `computeRequestLogStatus`。已有部分 usage 后发生流错误可能仍被标为 success（源码推断，公开场景待独立复现），须补端到端用例再修正。
3. 跨驱动独立资源完成合同，包括文本和 TTS：不得再次让账务依赖不可信清理 ACK；需要区分清理成功、失败、未确认及容量状态，验证 Workers 生命周期。
4. 新冻结构建后才能进入新的 Workers 验收；停止碰撞式同实例发现，不重放已消费推理/RPC/上传。不自动新增资源或启用生产容量。

C01、C02.G、原实例容量和下游工作包仍开放。Images 规则不变：网关验证有效 completed 图片与真实上游 `[DONE]` 后，先持久化成功事实再交付成功 DONE，之后客户端取消不撤销费用。

## 证据及费用边界

继承并核验 v235 的 2,069 条摘要；受影响的旧 driver、wire test、公开路由 fixture、policy 和 workflow 按字节归档到 `.wrangler/staging/gemini-settlement-v236-before-source/`，只在新清单中按原路径＋SHA 显式映射，旧清单不改写。新清单和精确映射数量见 [机器结果](./C02-gemini-settlement-v236-results.json)。当前源码不匹配已部署构建，旧 CLI 应拒绝源码漂移。

本轮 staging 管理／公开请求、部署、生产写入、真实模型和 KMS 调用均为 0。首轮累计公开 HTTP 422、真实模型/KMS 0/0、累计 US$2 上限不重置。US$1.20 已用及延迟费用预留、US$0.80 未分配预留是操作预算，不是已核验账单。最新云端观察仍为 v232 的 2026-09-09T06:45:06.937Z，本轮没有重新核验远端入口、隔离或最终增量费用。
