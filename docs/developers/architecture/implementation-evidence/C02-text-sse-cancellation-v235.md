# C02.2：三类文本 SSE 取消与清理分离

Checklist v1.134；2026-09-09。LOCAL_PASS / STAGING_PARTIAL，未部署。C02.G 与 Workers 原实例容量门禁保持未通过。

## 最终实现

Chat、Responses、Anthropic 的 fetch / 普通 JSON 已有 signal，但 SSE 原先只在后续写入失败时发现读体取消：静默上游没有后续事件会挂起；仅取消上游 reader 也不能解除已阻塞的下游写入。Responses 还会把取消触发的 done 当作正常 EOF，解析没有完整事件分隔符的 remainder。

最终三份驱动通过请求内 controller.terminate 结束可读端、解除阻塞写入，并观察 writer.closed 感知静默时的读体取消。read 返回后和处理事件前检查取消，不再把取消当作 EOF。reader.cancel 幂等，取消后的 reader 由 pump 单独保留到清理成功/拒绝终结。

**usage／取消事实不能等上游 cancel ACK。** 它们及时完成，以保留原有公开路由结算合同；取消的 reader 清理在 pump 中独立等待。正常终态仍及时关闭响应、返回权威 usage，不等待上游 ACK。finished 防止后续关闭回调改写已经结束的结果。财务算法、协议终态、公开字段归一化及 Images 成功结算点均未改动。见 [公开策略](../../reference/text-sse-cancellation-policy.md)。

此 pump 等待尚未以独立资源完成 Promise 接入全部调用者、容量持有者及 Workers waitUntil。因此 reader 锁持有不是平台生命周期保证，不据此开放生产容量。

## 测试、失败与修正

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-concurrency=1 packages/proxy/src/services/egress/text-sse-cancellation-wire.test.mjs
```

最终专项 **39/39 PASS**：

- 18 项真实 Node 回环 HTTP：三个协议 × 客户端取消/deadline 原因/仅下游取消 × 静默上游/阻塞写入；核对上游 socket 关闭、一次 HTTP、一个 dispatch 许可。deadline 通过真实停止错误类型注入，不是实际计时器耗时验证。
- 18 项合成流：三个协议 × signal/下游取消/正常终态主动取消 × cancel Promise resolve/reject。usage 必须及时结束；前两种情形保持 reader 锁到清理终结，正常终态则不阻塞成功交付，保留用量 5。
- 3 项不完整事件：取消不得触发 remainder 解析，usage 保留此前快照。

初版相同测试源码从修复前 11 PASS / 28 FAIL 变为首版修复后 39/39；但初版测试错误地把 usage 完成与清理 ACK 绑定。前三次完整回归均在 300 秒超时，输出止于第 446 项，没有整体计数，不计为通过；仅凭该日志不能定位挂起的测试。

进一步检查既有合同并独立复验发现：正常成功等待 ACK 会阻塞 last-permit success；controller.error 使直接取消后的响应释放抛错（原 lifecycle 套件 8/9）；即使只让客户端取消等待 ACK，也会阻塞公开路由的取消事实落账及后台 drain。最终恢复及时 usage、采用 terminate 保留原有释放语义，把 reader 清理等待留在 pump 内。旧测试未修改。专项中六项正常终态和十二项取消断言按既有合同校正，**最终不是初版同源码前后对照**。

独立检查：last-permit 3/3、原 lifecycle 9/9、公开路由取消落账 1/1，以及 Images/向量生命周期 509/509 PASS。最终完整 dispatch 回归 **2,854/2,854 PASS**；dispatch 与 staging 类型检查 PASS。最终回归保留全部测试，增加单项 30 秒测试限时；未删减测试或使用强制成功退出。历史 staging 2,439 项套件未重跑，远程 CI / Node 22 未验证。独立 CI workflow 已接入新增专项。

回环使用动态 127.0.0.1 端口和合成凭据；合成流没有外网。中间三版驱动、两版旧测试、四套专项成功输出及三次完整回归超时输出均归档。上述运行操作器已终结；没有停止其他进程。

## Workers 与历史证据边界

Workers 最佳实践技能促使本轮核对请求所有权、标准流控制器及当前类型。受限 npm 查询 EACCES 后，经批准的只读官方查询返回 5.20260908.1；未安装依赖。TransformStream 概览仍描述旧 identity 实现，本轮以更具体的 [兼容标志文档](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#compliant-transformstream-constructor) 和 [workerd 兼容定义](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp) 核对：标准构造器从 2022-11-30 默认启用，当前 staging 日期 2026-08-24 没有关闭这些标志。类型含 start / terminate；这不是 Workers 原生执行证据。

2,018 条继承摘要逐条核验；三条旧 path+SHA 显式映射到原字节归档，新源码单独登记，最终共 2,069 条记录。历史清单/日志不重写。工作树不等于旧部署候选，新部署必须重新冻结构建，不能重放已消费 CLI。

本轮 staging 管理调用、公开 HTTP、部署、生产写入、真实模型/KMS 均为 0。首轮累计公开 HTTP 422、模型/KMS 0/0，US$2 不重置；最后关闭观察仍 v232 的 2026-09-09T06:45:06.937Z，本轮未重验远端或最终账单。原容量 FAILED 结论和生产容量禁用保持。

下一项优先复验 Gemini v234 的公开取消落账是否也被清理 ACK 阻塞，再建立跨驱动独立资源完成合同（包括音频），然后准备新冻结的 Workers 候选。不以本地测试替代同实例容量观察，不跳过 C01/C02.G。完整命令与摘要见 [机器证据](./C02-text-sse-cancellation-v235-results.json)。
