# C02.2：Gemini 真实取消与读写所有权

版本：Checklist v1.133；日期：2026-09-09。LOCAL_PASS / STAGING_PARTIAL，未部署。C02.G、原实例容量及完整实施目标均保持未完成。

## 修复内容

Gemini 原上游 fetch 未接入请求 signal，普通 JSON 读取器也未接入取消；SSE 原实现断连后继续读取最多 25 秒，并可能卡在下游不读取的写入上。现接入同一个 signal、移除断连 drain，观察下游关闭，并通过请求所有的 TransformStream controller.error 解除阻塞写入。上游 reader.cancel 只调用一次，在其 Promise 终结后才释放 reader 锁并报告 usage 任务完成。

客户端取消与 deadline 分别使用已有分类，保留取消前已解析 usage。出站后未知结果禁止重放；不更改金融算法、Images 成功结算点、重定向拒绝策略或容量池启用开关。规则已公开于 [Gemini 取消策略](../../reference/gemini-cancellation-policy.md)。

## 测试与失败保留

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-concurrency=1 packages/proxy/src/services/egress/gemini-cancellation-wire.test.mjs
```

最终专项 16/16 PASS：10 个真实 Node 回环 HTTP 用例覆盖两种取消原因与头前（两种 action）、JSON 读体中、SSE 静默、SSE 阻塞写入；2 个完整 dispatcher 用例验证 40 候选时仅发送一次、消费一个许可；4 个合成流用例覆盖 signal/下游取消与清理 Promise resolve/reject 的所有权。deadline 原因通过真实错误类型注入，不声称测量了实际时限计时器。回环端点只绑定动态 127.0.0.1 端口，使用合成凭据，无外部推理/KMS。

原始测试在修复前 0 PASS / 16 FAIL；第一版修复 10 PASS / 6 FAIL。六项中，两项阻塞写入为真实实现缺口（writer.abort 未解除背压）；另外两项 JSON 用例过早取消、两项 dispatcher 用例缺少公开调用者使用的 deadline 包装参数，属于夹具条件错误。修正控制器停止机制及这些夹具后得到最终 16/16。因此不是同一测试源码的简单 0→16 对照：原始测试、第一版源码、修复前源码及三份失败/成功回执均独立保留并登记摘要。

更大范围 dispatch 回归 2,815/2,815 PASS（包含重定向 112 项和本轮 16 项），dispatch 与 staging 两项类型检查 PASS。历史 staging 2,439 项套件本轮未重跑。新增独立 CI workflow，但远程 CI 未运行；本机 Node 24 不作为 Node 22 或 Workers 验收。

## 历史证据与未关闭的门禁

1,997 条继承摘要已逐条核验；唯一发生演进的历史 Gemini 源码按原字节映射到归档，新源码另行登记。旧证据文件不重写。旧候选不包含当前修复，新部署须重新冻结、构建、验证，不能重放已消费的一次性 CLI。

按 Workers 最佳实践技能核对当前官方文档、类型和请求所有权，采用请求内控制器及被观察的取消 Promise，不引入跨请求状态。参考 [Request signal](https://developers.cloudflare.com/workers/runtime-apis/request/) 与 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。本轮验证仍是本地实现证据，不把 Promise 终结或 socket 关闭等同于 Workers 原实例容量释放。

本轮 staging 管理调用、公开 HTTP、部署、模型/KMS 及生产写入均为 0。首轮累计公开 HTTP 422，模型/KMS 0/0，US$2 不重置；最后关闭读回仍为 v232 的 2026-09-09T06:45:06.937Z，本轮未重验远端隔离或最终账单。v232 原容量 FAILED 结论保留。

下一步继续 C02 其余驱动的内层出站和取消合同核对，之后以新冻结候选安排获准的 Workers 验证；不以文本修复替代同实例容量证据，不提前启用生产容量或跨过 C01/C02.G。

完整命令、摘要与历史映射见 [机器证据](./C02-gemini-cancellation-v234-results.json)。
