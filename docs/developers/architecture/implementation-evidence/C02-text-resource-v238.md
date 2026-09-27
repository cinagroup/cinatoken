# C02：四类文本 SSE 独立资源完成（v238）

日期：2026-09-09。结论：**LOCAL_PASS，未部署**；不放行原实例容量、C02.G、C01 或后续依赖。

本轮把 v235–v237 的“usage 可及时结算、pump 单独等待取消 ACK”落实为显式资源完成通道，接入四类文本公开路由的生命周期和可选逻辑容量 owner。Images 已授权的不可逆成功结算点不变。

## 实现

1. Chat、Responses、Anthropic 和 Gemini SSE 返回独立 `resourceCompletion`，取消 ACK 未到时不报告清理成功；ACK 拒绝或泵异常报告 `unconfirmed`。用量和正常协议结束交付不等待该信号。正常三类文本终点原有提前释放 reader lock 的兼容行为保留，但 lock 已释放不等于取消 ACK 已确认。
2. Failover 在任何 dispatch 启动前同步登记请求级汇总任务；每个已启动 dispatch 和其报告的后续清理都进入汇总，先前失败尝试不被后续成功掩盖，deadline 返回后才到的响应也不丢失其已报告清理。登记失败不发起 dispatch，无额外推理重试。
3. Chat / Responses / Messages 的普通模型循环与 `partition=none` 全局链路，以及 Gemini 公开路由，使用独立资源调度器登记 `waitUntil` 并保留容量。确认后释放；等待中或未确认时不释放。失败只留数字预留及固定告警，不记录原始错误／负载，不以 TTL 放行。
4. Node 的资源任务集合与记账集合分开，提供独立显式 drain。原记账 drain 不会被永不返回的取消 ACK 阻塞。未新增自动停机编排。

详细合同见 [文本资源完成策略](../../reference/text-resource-completion-policy.md)。这是资源所有权修复，不改金融算法或 Images 成功点，不代表所有消费者已覆盖。

## 验证与历史失败

新增 74 项：14 项汇总器／运行时与容量测试、32 项驱动／failover 测试、28 项完整公开路由测试。涵盖四类流、客户端及下游取消、ACK 成功／拒绝、正常终点不拖延、EOF、前序失败清理、deadline 后迟到结果、登记失败、普通／全局模型链和别名。

首轮专项 74/74、完整 dispatch 回归 2,977/2,977、staging 类型检查通过，但 dispatch 类型检查有三条诊断：新 TypeScript 测试使用的 `Promise.withResolvers` 不在项目既有 lib 中。仅将该测试改成普通 Promise 辅助函数，没有升级运行时、TypeScript lib 或依赖。首轮源码、失败 receipt 和日志完整保留；不称首轮全部通过，也不声称运行时前后同源码失败对照。

最终 r2：专项 74/74、完整回归 2,977/2,977、dispatch 与 staging 两项类型检查全部通过。公开路由使用真实 handler／调度／记账代码和合成仓储、SQL sink、上游及 `waitUntil`，验证调用意图与生命周期顺序，不是数据库持久化或云端验收。

可复验入口（操作证据使用独占文件名，不覆盖旧 receipt）：

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-name-pattern=resource packages/proxy/src/services/resource-completion.test.ts packages/proxy/src/services/egress/text-resource-completion.test.mjs packages/proxy/src/routes/v1/request-dispatch-limit.test.ts
node node_modules/typescript/bin/tsc -p packages/proxy/tsconfig.dispatch-safety.json --noEmit
node node_modules/typescript/bin/tsc -p packages/proxy/scripts/staging/tsconfig.json --noEmit
```

完整回归命令、退出码、计数和摘要保存在 `text-resource-v238{,-r2}-verification.json`。新测试也加入 `test:dispatch-safety` 和 `test:unit`，未运行远程 CI 或 Node 22。

## Workers 与剩余门禁

按 workers-best-practices 技能复查 [官方生命周期最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)和最新只读查询的类型 `5.20260908.1`；复用已下载类型，不安装依赖。`waitUntil` 保持原 receiver、登记发生在 dispatch 前，但不能突破平台生命周期上限；本地 Promise 持有和数字容量归零不能证明真实 Workers 内存释放。

`confirmed` 仅涵盖已登记工作。无资源通道的驱动并未额外报告清理，不能视为其未知工作已验收。TTS、上传、JSON／错误正文及其他消费者的资源合同，数据库初始化／写入自身时限，Node 停机以及 Workers 原实例容量仍开放。未确认清理保留容量是保守可用性取舍，不能据本轮测试开启生产容量。

下一步沿此合同接入 TTS，并审计上传／JSON／错误正文的清理边界；随后使用新冻结构建进行受控原生验收。不以重复推理、RPC、上传或碰撞式请求寻找同实例。C02.G、C01 及后续依赖继续开放。

## 摘要、云端和预算

继承并核验 v237 的 2,126 条摘要；14 条受影响旧记录通过原路径＋SHA 显式映射到字节相同的归档，不重写旧 manifest。连同本轮源码、策略、首轮失败和最终日志共 2,175 条记录，见 [机器证据](./C02-text-resource-v238-results.json)。当前源码不匹配 v232 云端 bundle，下一次部署必须新冻结构建，旧 CLI 应拒绝源码漂移。

本轮 staging 管理／公开 HTTP、部署、生产写入、真实模型及 KMS 调用均 0。首轮累计公开 HTTP 422、模型/KMS 0/0，US$2 累计上限不重置；US$1.20 历史及延迟用量预留、US$0.80 未分配仍是操作预算，不是已核验费用。最后远端观察仍为 v232 的 2026-09-09T06:45:06.937Z，本轮未重新核验云端状态或最终增量账单。
