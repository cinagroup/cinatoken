# C02：ASR 响应与异步下载资源所有权（v241）

日期：2026-09-10。结论：**LOCAL_PASS，未部署**。原实例容量、C02.G、C01 及后续依赖继续未通过。

## 实现

当前工作树核对显示，ASR 已使用有界正文读取和请求级 deadline，但驱动未返回独立资源完成任务，公开路由也未登记相应的资源 owner。异步结果下载在外层 race 取消时，会遗留等待重定向正文 ACK 的执行链。

本轮完成：

1. OpenAI 转录、Qwen3 / Qwen-Audio / Fun 同步 ASR、异步文件 ASR、原生多模态透传，都使用请求局部的 buffered-audio 资源汇总。HTTP 头等待、迟到响应清理、正文取消／超限／读取失败均接入资源结果。
2. 公开 `/v1/audio/transcriptions`、`/api/v1/audio/transcriptions` 及原生 DashScope 多模态入口，在 dispatch 前登记现有 Workers／Node 资源调度器。原生 DashScope 目前无 `/api/v1` 别名，不为测试虚构入口。
3. 异步提交、轮询和结果下载继续各自归原请求所有。重定向工具增加可选 `cancelResponseBody` 钩子，ASR 用它登记 ACK 并受同一 deadline 约束；不再用外层 race 遗弃整段下载执行。未传钩子的其他工具调用方保留原行为。
4. 确认失败为 `unconfirmed`，不释放可选逻辑容量，不用 TTL 或响应完成替代确认。usage／记账不等待清理，已知非成功提交也不因清理失败变成未知收费。

没有修改金额算法、unknown 预算规则、异步重放权限、结果 URL 允许范围或 Images completed＋真实上游 `[DONE]` 的不可逆成功结算点。详见 [ASR 资源合同](../../reference/asr-resource-completion-policy.md)。

## 验证结果与失败记录

最终新增 **118 项**通过：

| 覆盖 | 数量 | 主要证据 |
| --- | ---: | --- |
| 六种驱动 × 正文取消／声明超限／实际超限／迟到 HTTP 头 × ACK 成败 | 48 | 资源独立持有，取消／超限仍及时返回 |
| 六种正常响应 | 6 | 正文完成后确认，时长保持 1 秒合成值 |
| 异步轮询头／正文、下载头／正文、重定向 ACK × 成败 | 10 | 单次提交，取消后不增加查询／下载 |
| 危险或缺失重定向目标 | 3 | 不发送后续请求，失败的清理仍保留 |
| 六种驱动的明确 503 × ACK 成败 | 12 | 资源确认与已知失败账务分类分离 |
| 六种迟到 transport 拒绝 | 6 | 未确认，不泄漏原始异常 |
| 重定向 deadline × ACK 成败 | 2 | 504 及时返回，不等待不可信清理 ACK |
| 安全相对跳转 × ACK 成败 | 2 | 内容与有效时长保留，清理失败仍未确认 |
| 重定向上限 | 1 | 六个允许观察到的响应全部清理，无第七次下载 |
| 四种公开路由、实际存在的前缀、头／正文取消 × ACK 成败 | 28 | 一次记账意图，ACK 到达前保留逻辑容量 |

完整回归 **3,310/3,310**，由此前 3,187 项、本轮 118 项与额外重跑的 5 项既有 URL 安全测试组成；无失败、取消或跳过。dispatch 与 staging 类型检查均通过，最终验证进程正常退出 0。新驱动测试已加入 `test:dispatch-safety` 和 `test:unit`；完整命令、源码摘要与日志在 `.wrangler/staging/asr-resource-v241-final-verification.json`。

公开测试走真实入口／调度／记账代码，但数据库为合成 SQL sink：断言一次 `expired` 转换及 1,500,000 微美元预留，不是实际扣费或持久化事务证明。客户端已取消时，容量响应包装器会阻止正文读取；测试明确断言安全的交付停止错误，而非要求取消后仍能读取错误 JSON。

首轮执行记录保留：修复前 95 项为 0 PASS / 95 FAIL；初次接线后为 9 PASS / 86 FAIL。两轮包含测试夹具错误：清理时重复将已扰动流包装成 Response，以及取消后错误地要求客户端正文可读。修正夹具后原 95 项通过，再增加 23 项边界测试得到最终 118 项。原始测试及日志已归档；**不将首轮失败数当作产品缺陷数，也不声称最终测试具有同源码修复前后对照**。

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-name-pattern="ASR resource" packages/proxy/src/services/egress/asr-resource-completion.test.mjs packages/proxy/src/routes/v1/request-dispatch-limit.test.ts
node node_modules/typescript/bin/tsc -p packages/proxy/tsconfig.dispatch-safety.json --noEmit
node node_modules/typescript/bin/tsc -p packages/proxy/scripts/staging/tsconfig.json --noEmit
```

## Workers 和剩余要求

依 workers-best-practices 技能重新核对 [官方文档](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)与官方 npm 最新类型版本 `5.20260910.1`，检查已有相同版本的 ExecutionContext 和 reader 签名，未升级依赖、配置或运行时。技能促使本轮使用明确的请求局部资源任务、保留 `waitUntil` receiver，并将异步下载的取消等待纳入所有权链。

`confirmed` 仅证明已登记 HTTP／正文工作终结，不证明原生 Workers 物理内存释放、上游异步任务取消或资金落账。平台 `waitUntil` 期限仍适用。尚未完成：ASR multipart／Blob 与大 JSON 上传的完整资源所有权、其他 JSON 消费者、入口准备及数据库自身时限、Node 自动停机和原生 Workers 全消费者／原实例容量。未运行新的原生 Workers、Node 22、远程 CI 或历史 staging 全套。

下一步继续 ASR 上传及其他 JSON 消费者，再推进数据库自身时限；新云端验收须重新冻结构建。生产容量保持关闭，不重放不确定推理或以碰撞式请求寻找同一实例。

## 证据与费用

继承并核验 v240 的 2,226 条摘要记录。受影响历史源码按路径＋SHA 重定位至 `.wrangler/staging/asr-resource-v241-before-source/`，不重写旧 manifest。精确总数与全部哈希见 [机器证据](./C02-asr-resource-v241-results.json)。

本轮 staging 管理／公开调用、部署、生产写入、付费模型和 KMS 均 0。首轮累计公开 HTTP 422、模型/KMS 0/0，US$2 上限不重置；US$1.20 历史／延迟预留与 US$0.80 未分配仍是操作预算，不是核验后的账单。最后远端观察仍 v232（2026-09-09T06:45:06.937Z），本轮未刷新云端状态或最终增量账单。旧云端候选不包含本轮源码。
