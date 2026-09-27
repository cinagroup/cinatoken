# C02 — 普通 Images 结果不明的公开错误合同

日期：2026-09-08；Checklist v1.82。新普通 JSON 响应合同已实现，尚未部署。C02.B2.2 / C02.G 保持开放。

接续 [v1.81 wire / usage 边界](./C02-images-wire-boundaries.md)发现的缺口。本次修改共享 Images 路由，并新增仅用于 Images 的错误响应适配器；没有修改上游派发、耐久结算、费用计算或预算消费算法。

## 合同与边界

- 上游 2xx 后 usage 或属性名超限：保留 `502`、`upstream.server_error`、通用脱敏文案和 `error_type`，增加 `error.metadata.outcome_unknown=true`、`retry_safe=false`、网关 `request_id`。
- 上游 2xx 但没有有效图片：保留原 `502 gateway.upstream_request_failed`，同样标记结果不明。
- 成功响应不新增错误字段；明确上游 400/401/429 不被误标。即使上游 JSON 伪造同名 metadata，公开结果也不采用这些字段。401 仍按既有规则映射公开 502，但预算消耗为零，不能仅根据公开状态判定未知。
- 持久化未确认保留既有 `503 gateway.image_settlement_unconfirmed`、三个标志和原预留，不绕回第二条结算路径。
- 未知错误删除 `Retry-After` 与已失效的长度、编码、摘要头；保留既有兼容错误码。标志缺失不等于允许重试，请求 ID 不等于幂等键。

适配器只接收 `materializeNonOkResponse` 已限长、已脱敏的文本，不读取或 clone 图片响应流。解析前还有文本长度防线；无效内部 envelope 使用固定公开错误回退，不泄露原始文本。改写前取消已物化的小错误 body；成功流继续走原交付路径。遵循 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)的有界处理和 Promise 所有权要求。

取消/超时的买家零费用与上游是否执行是两个判断，因此未知标志使用 driver 的结果证据，而不使用预算是否按预留消费。补充两条完整 Worker handler 的本地信号取消验证：上传后取消均返回原生 499、保留错误码和未知标志，耐久快照/提交成功，零买家名义费用与零预算消耗，重复恢复不派发。**这不是实际网络断开后的客户端接收证明，也不是真实 deadline 超时验证**；超时目前仅覆盖适配器合同和既有生命周期回归。SSE 流内事件本次没有修改。

## 验证

新增 `packages/proxy/scripts/staging/images-outcome-metadata.test.mjs` 共 24 项：两种操作各 8 项完整 Worker handler + SQLite 合成链，1 项入口拒绝，2 项取消/超时适配器合同，5 项无效内部 envelope 回退。专项首次 24/24 通过，完整 Proxy 类型检查通过。

首次完整回归尝试在子进程恢复组失败：此前 441 项通过，该组 23/24 通过，总计 464/465；`snapshot-after, edits, cost=0` 的 `spawnSync` 触发既有 12 秒限制并报 ETIMEDOUT。失败点为成功请求快照写入后的进程退出，不经过新增错误适配器。保留完整输出 `.wrangler/staging/images-v182-verification.json`，没有放宽超时。相同源码/限制下独立复测该项 1/1 通过、退出码 0、总耗时 8,783.3705 ms；根因仍未确定。

第二次完整版本化 staging 本地链 656/656、新增合同 24/24 均通过，合计 680 项。另行 driver / Images 生命周期 / 公共错误物化回归 508/508 通过；完整 Proxy 与 staging 两项类型检查退出码均为 0。所有完成的测试组无失败/取消/跳过。运行期间核心修复三文件 SHA 保持不变；完整输出在 `.wrangler/staging/images-v182-verification-rerun.json`。专项与完整重跑不相加成新的唯一测试总数，也不称为真实 Workers 验收。

[机器结果与摘要](./C02-images-outcome-metadata-results.json)登记 130 个源码、154 个操作 artifact、14 个历史证据依赖，共 298 个摘要；旧路由的原字节归档用于历史证据复核。

未知结果用例复用实际 snapshot、八表、预算、reservation、重复 recovery 和直接 repository.commit 回执断言，确认零名义请求费用与 100,000 micros 保守预算消耗仍不同；明确拒绝则名义费用和预算消耗均为零。这些都是合成数据，不是买家资金账或模型真实账单。

补充 `images-dispatch-outcome-metadata.test.mjs` 4 项诊断最终通过，包含上述两项取消验证和两项传输异常的当前状态观测，不计入先前 680 项命令链。初始两次运行因错误预期 502/504 而各 0/4；实际分别为安全 503/原生 499。初始诊断源码归档为 `.wrangler/staging/images-dispatch-outcome-v182-initial.mjs.txt`，只修正测试观察，不改运行时去匹配预期。

## 新发现：普通传输异常缺少最终尝试事实

两条操作都在上传完成后抛出普通传输错误，未注入数据库故障。实际 `sends=1`、`upstreamAttemptCount=1`，但路由最终 timing 的 `providerAttempts=[]`。返回 `503 gateway.image_settlement_unconfirmed`，已有三个安全标志；数据库无快照/请求日志，intent 保持 `dispatch_claimed`、预留 100,000 micros，重复 recovery 无可恢复项。

从源码推断：`openai-images-driver.ts` 两处 catch 只补记客户端取消，没有为普通传输错误补最终 attempt；`usage-settlement-codec.ts` 要求快照存在与 intent 对应的 provider attempt。缺失事实与该持久化不变量冲突。**本轮未修复此缺口，不能把诊断通过当作传输错误恢复完成。** 下一项应优先补真实的出站后网络/超时尝试事实，保持出站前无发送、明确 HTTP 拒绝和禁止模型重放，再验证完整持久化链；不放宽 codec 的审计约束。

## 历史证据与部署状态

修改前的 `images.ts` 已原字节归档为 `.wrangler/staging/images-route-before-v182.ts.txt`，SHA-256 为 `5b7b351a071e6aa5860bd61c0586653f12424aa8ed389fb4992d5c30c9b900d4`。v1.81 的该源码 hash 现在指向这个历史版本；其余历史源码/artifact/依赖保持原样，合计 282 项重新核验通过。不得将 v1.81 对旧源码的结果冒充新代码验收。

本轮未修改配置/依赖/迁移，未部署或调用云端模型/KMS，未复核云端权限。累计公开测试 HTTP 保持 263，首轮累计新增费用 US$2 上限不重置，最终增量云账单仍未核验。最近实际 staging 证据仍为 v1.77。最新类型包查询失败 EACCES；按技能回退检查缓存的 Workers 类型 5.20260907.1，未声明更新依赖成功。

下一顺序：修复传输异常尝试事实缺口；补超时与 SSE 错误标志及账务对照；再冻结新候选、复核隔离与费用并做真实 staging 的 wire / 交付 / 持久化样本。完整物理容量、生产 SLO、KMS/IAM、客户端幂等及退款政策继续开放。此次本地修复不关闭 C02 或整个共享平台目标。
