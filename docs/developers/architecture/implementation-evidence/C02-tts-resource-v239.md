# C02：TTS 响应资源完成（v239）

日期：2026-09-10（实现开始于 2026-09-09，中断后继续验证）。结论：**LOCAL_PASS，未部署**。原实例容量、C02.G、C01 及后续依赖不放行。

## 完成内容

继 v238 文本资源通道之后，将 OpenAI Speech 的二进制／SSE，以及 DashScope SpeechSynthesizer、Qwen、MiniMax 的响应清理接入同一请求所有权链：

1. 公开 Speech 路由在 dispatch 前登记资源任务；Failover 汇总各尝试，TTS 再汇总传输等待与流清理。
2. 取消、deadline、正常协议结束仍及时完成 usage。reader lock 及时释放的兼容行为保留，但单独等待取消 ACK 才确认资源完成；ACK 拒绝或同步清理异常标记 `unconfirmed`，不提前释放容量。
3. 取消后迟到的 fetch 响应继续归原请求所有，其 body 的取消 ACK 也进入汇总；迟到 transport 拒绝为未确认，不重放请求。
4. DashScope 首事件解析／应用失败、OpenAI 错误 Content-Type、有界非成功正文的声明超限／实际超限／取消／读取失败，均登记独立清理。共享正文读取器的取消调用变为一次性，并提供可选清理登记接口。

没有变更 TTS 金融算法、unknown 预算规则、公开格式限制或 Images 成功点。Images 仍在验证有效 completed 图片和真实上游 `[DONE]` 后，先持久化成功事实，再交付成功 DONE；后续取消不撤销费用。

详见 [TTS 资源完成合同](../../reference/tts-resource-completion-policy.md)。

## 检查证据

新增 180 项，均通过：

| 范围 | 数量 | 主要证明 |
| --- | ---: | --- |
| 四适配器流取消、两种格式、三种停止来源及 ACK 成败 | 48 | usage 及时完成，资源 ACK 未到时不确认 |
| 正常协议终点及二进制 EOF | 15 | 成功交付／用量不等待 ACK，自然 EOF 不多余取消 |
| 非成功正文超限／取消 | 24 | 错误返回及时，后台清理独立保留 |
| DashScope 首事件失败及 OpenAI 错误 Content-Type | 20 | 失败分支不遗漏资源任务 |
| 迟到响应、迟到 transport 拒绝、清理异常归一化 | 23 | 原请求继续持有，不重放，不泄漏原始清理错误 |
| 公开 OpenAI／SpeechSynthesizer／MiniMax，两种前缀和格式 | 48 | 真实路由及记账代码在 ACK 未到时完成一次记账，逻辑容量仍占用 |
| 公开 Qwen 格式门禁 | 2 | 不绕过现有 MP3／PCM 与 WAV 不兼容限制，准入前拒绝 |

最终完整 dispatch 回归 **3,157/3,157**，dispatch 与 staging 两项类型检查通过。公开测试的预算转换断言保留 unknown 状态及 5,000 微美元预留，只验证合成 SQL sink 中的写入意图，不是实际扣费或数据库持久化证明。原有 183 项音频检查也在中断前通过；最终完整回归包含这些原有文件。

中断前最后一次类型检查的进程句柄在恢复后已不存在，未推断其退出结果，也未把它当作通过。恢复后新执行上述专项、完整回归与两项类型检查；本轮没有运行时“同测试源码修复前失败”对照，不作该声明。

可复验命令：

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-name-pattern="TTS resource" packages/proxy/src/services/egress/tts-resource-completion.test.mjs packages/proxy/src/routes/v1/request-dispatch-limit.test.ts
node node_modules/typescript/bin/tsc -p packages/proxy/tsconfig.dispatch-safety.json --noEmit
node node_modules/typescript/bin/tsc -p packages/proxy/scripts/staging/tsconfig.json --noEmit
```

完整命令、退出码、源码与日志摘要保存在 `.wrangler/staging/tts-resource-v239-verification.json`；操作器采用独占输出，不覆盖旧记录。新测试加入 `test:dispatch-safety` 与 `test:unit`。未运行远程 CI 或 Node 22。

## Workers 与未完成范围

workers-best-practices 技能要求将清理任务独立登记到请求生命周期，而不是依赖浮动 Promise；按此要求接入已有资源调度器。复查 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)及 2026-09-10 最新 `@cloudflare/workers-types@5.20260910.1` 的 `ExecutionContext` 和 reader 签名；类型包只下载到隔离检查目录，没有升级项目依赖或修改配置。

`waitUntil` 的平台期限仍适用，本地合成 ExecutionContext、reader 解锁、数字容量归零均不能证明原生 Workers 内存释放。当前 `confirmed` 只覆盖已登记的响应资源。

以下仍待完成：克隆音频上传源及 fetch 对上传 reader 的持有；入口准备／数据库初始化和写入自身时限；其他 ASR／JSON 消费者；Node 自动停机；原生 Workers 全消费者及原实例容量。共享 helper 新增可选接口不等于其所有调用方均已接入。生产容量保持关闭，下一次部署必须使用新的冻结构建。

下一步优先补克隆／上传资源合同及其取消交接，再推进剩余响应消费者和数据库时限；不以重复推理、RPC、上传或碰撞请求寻找相同实例。

## 历史与费用

继承并核验 v238 的 2,175 条记录，受影响旧源码按原路径＋SHA 映射至 `.wrangler/staging/tts-resource-v239-before-source/`，不重写历史 manifest。连同本轮源码、策略、验证日志及类型参考的精确总数见 [机器证据](./C02-tts-resource-v239-results.json)。

本轮 staging 管理／公开 HTTP、部署、生产写入、真实模型与 KMS 调用均 0。首轮累计公开 HTTP 422、模型/KMS 0/0，US$2 上限不重置；US$1.20 历史／延迟用量预留和 US$0.80 未分配仍是操作预算，不是已核验费用。最后远端观察仍为 v232 的 2026-09-09T06:45:06.937Z，本轮未重新核验云端状态或最终增量账单。旧云端 bundle 不含本轮变更。
