# C02.B2.2 — Peer 不匹配只读诊断

2026-09-09；Checklist v1.128。状态：STAGING_PARTIAL，新增诊断 LOCAL_PASS，未构建部署候选或进行新云端试验。

## 结果与边界

新增独立 staging 入口和原 V3 handler 的外层诊断组合。只有固定 watch 路径的 GET / 409 响应才读取同一个 handler 的内部 census UUID，附加固定版本和 36 字符 UUID 两个响应头；原始拒绝正文、状态及业务容量不变。成功响应及 WebSocket 101 不重建，不读取、克隆或 tee 原响应体，不增加网络、SQL、计时器或后台工作。客户端输入同名诊断头在委托前拒绝，避免反射或传至上游。

新增纯分类器，必须先满足既有 V3 完整、精确、自然 EOF 的 canonical mismatch 校验，再比较原 primary DTO 与该次拒绝中的实例 UUID：不同 UUID 归为 `instance_mismatch`；同 UUID 归为 `epoch_mismatch`，但不声称知道 epoch 值或失效原因。分类结果明确不授予重试权限，不构成容量、原生生命周期或财务证明。

来源条件仍由传输层负责：primary、响应头、原始字节及 EOF 必须来自同一次实际链路，纯分类器不能认证调用者传入的对象。尚未把新响应头持久化采集接入一次性线上执行器，也没有更改现有 8 次 / 20 秒观察上限。不得拿新入口替换旧候选后伪装成旧内容摘要通过前检。

## 验证

38 项新增测试覆盖两个真实本地 handler 组合、旧 primary 与新 epoch、非 200 后 eligible 失效、正常 Upgrade、已释放 / 已观察 / 已取消等非 mismatch 拒绝、有界及重复头、截断或篡改正文、原 body 所有权和禁止业务副作用。这里的 WebSocketPair / 101 使用明确的本地适配器，不是 Workers 原生验收。

联合回归 2,312/2,312、staging 类型检查通过；之前发布的 1,918 条摘要不变，新机器清单共 1,928 条摘要。新增 Node 22/24 CI 工作流但未执行远端 CI，本机仅 Node 24.14.1。首测因新测试夹具漏填三个 staging 环境开关导致 23 项失败；补齐夹具后 38 项通过，未修改冻结校验器或降低业务断言。

遵循 Workers 最佳实践技能，将诊断保持为请求作用域只读操作，稳定的实例 UUID 继续由原组合持有，不缓存 Request / Response / Promise，也不新增 `waitUntil`。[Cloudflare 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## 云端与下一步

本轮 staging 管理 API、公开 HTTP、D1 写入、模型及 KMS 调用均为 0；累计公开 HTTP 仍 406，模型 / KMS 0/0，首轮 US$2 不重置，最终增量账单未核实。最新关闭读回仍是 v228 的 2026-09-09T05:41:52.641Z，不是本轮重新观察。v228 试验的总体 FAILED / 容量未证明结论保留，不能用本地分类测试补写八次历史拒绝的具体原因。

下一步接入同次 Upgrade 原始头与完整拒绝的有界采集、冻结新候选和新一次性执行编号，再进行独立 staging 前检与受控验证。不重放已消费的 v227 deploy/run，不伪造实例亲和性，不增设资源。完整容量、unknown / 幂等、C02.G、C01 和 C03–C20 继续开放。

机器证据：[v229 清单](./C02-images-sse-peer-diagnostic-v229-results.json)。
