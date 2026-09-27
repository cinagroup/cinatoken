# C02 — 同实例容量观测与 staging 候选

2026-09-08，Checklist v1.105；状态 **LOCAL_PASS**。本轮推进新组合的原生验收前置实现，不把本地测试或离线打包称为云端通过。生产运行时、已部署 Worker、恢复 SQL / 金额算法均未修改。

## 已实现

- 新独立 staging 入口组合真实容量池、耐久 Images SSE、冻结的 before-hold / after-hold 探针和原始客户端取消观测。只导出 HTTP，不导出 scheduled / queue。
- 一个组合实例只创建一个池，首次请求生成随机实例 UUID；实例间不同，不从请求输入取得。标准响应附带此 ID，但不读取、复制或 tee 响应正文。
- 固定 `GET /__staging/sse-capacity` 返回六个标量字段：profile、instanceId、两项上限、两项占用。无 SQL、无正文读取、无租户/密钥/请求缓存、无重置/释放接口。诊断入口故意不占用 HTTP 池，饱和时仍可观测，必须由 staging Access 保护。
- 固定 origin、D1 / 正文日志关闭 / Batch 关闭的配置检查；诊断路径拒绝 POST、HEAD、query、fragment、Upgrade。仅靠这些检查不能证明远程 Access 已正确配置，部署前仍须重新核查。
- 严格观察值校验与三态分类：原实例 occupied、原实例 idle、different-instance。落到另一个实例只能说明路由不同，不能证明原实例释放或被驱逐。
- 纯配置生成函数沿用 staging 名称、资源隔离和关闭入口检查，只改变候选 main；不提供自动部署/建库路径。

逻辑池仍是任意 1 请求 / 1,024 字节实验额度，不是生产内存配置。实例 UUID 是该池身份，不是 Cloudflare 暴露的宿主进程 ID、跨部署身份或路由亲和保证。诊断和取消观测本身有开销，不能从这个实验推导整实例物理内存预算。

## 验证

新增 26 项观测/分类/配置/背压测试，以及 2 项真实 SQLite 完整 host-handler 测试。后两项验证原请求 ID 和 census ID 一致、快照前/后取消、无 DB 读取的饱和拒绝、独立恢复后原池仍占用，以及原 Promise 真正终结后的原池空闲。after-hold 成功账单只有一条，before-hold 无快照时保留未决状态，均不重放上游。

首次完整 handler 专项的两项失败来自测试在已 errored 的流上调用 reader.cancel；修正为断言 reader.read 拒绝并释放锁后，两项通过。没有吞掉异常来修改产品成功点，也没有使用本地 ACK 拒绝冒充平台取消。

本轮查阅 Workers 最佳实践与 Wrangler 技能，核对当前类型 5.20260908.1、Wrangler 4.127.1 的命令帮助及本地配置 schema。技能影响了无请求级全局状态、只读诊断、流式透传、HTTP-only 组合和离线 dry-run 的边界。官方依据：[最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[waitUntil 生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)、[Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/)。

受控并发为 2 的完整回归 **1,521/1,521 通过**，失败/取消/跳过均为 0；Wrangler dry-run、配置类型生成与 staging TypeScript 检查均退出码 0。生成的绑定字段与现有 ImagesStagingEnv 逐项一致。候选包显示 3,733.82 KiB / gzip 673.68 KiB，CLI 明确以 dry-run 退出，没有实际上传。产物、配置与全部结果见 [v1.105 清单](./C02-images-sse-capacity-observation-results.json)。Node 22 / 远程 CI 尚未实际运行。旧 v1.104 及更早的源码/证据清单保持原样，未覆盖旧测试或旧报告。

## 原生实验执行条件

1. 新操作脚本须先校验候选源码/打包摘要；只读核验 staging D1 身份、四个 Worker、生产设置指纹、双 Access deny-all、无公网/预览/custom-domain/Cron/Queue，以及累计费用。离线生成配置里的历史 D1 UUID 不算新鲜身份核验。
2. 本轮新增诊断路径必须纳入原 staging Access 的整域保护；无认证、错误认证均应被挡在网关前，不能为诊断路径配置 bypass。
3. 原成功请求响应头中的池 ID 是后续比较基准。每个 census 记录实际请求次数、响应 ID、原始六字段及同一操作时钟的开始/完成样本；只读探测也必须消耗有界 HTTP 额度。
4. 达到已验证 held 阶段后先确认同实例 occupied，再取消客户端。原生取消仍以既有 native tail / V3 单调时序 / D1 原始 marker 证据验证；容量三态不能单独证明取消发生。
5. 平台取消之后以有界只读请求观察同一池。只有 different-instance 时标为未证实，不能不断重试直到碰到 idle；同实例 occupied 是需要处理的持有期结果，不允许通过重置计数、TTL 释放或重新部署将其改写为成功。
6. 如果池已饱和，不重放原推理或强行执行下一模式。独立恢复、双入口收尾及合成数据清理仍走既有有界/先存证/原子合同。不得让单请求容量上限阻挡运维从独立控制 Worker 进行恢复。

操作脚本的在线接线及同实例原生观测仍待实施，不能直接重跑旧 v203 脚本：它没有新的容量证据合同，且冻结源码已归档。后续仍需最大工作集、其他模态/消费者和 intent-only/unknown 政策验收；C02.G 保持开放。

## 费用与外部状态

本轮无已认证 Cloudflare 管理请求、测试 HTTP、部署、模型/KMS 或生产写入。仅查阅公开文档和 npm 元数据；离线 CLI 不上传。首轮 HTTP 累计仍为 366，模型/KMS 累计 0；US$2 上限不重置，最终增量账单未核验。云端最新权威隔离观察仍为 v1.103 的 2026-09-08T11:23:20.520Z，本轮没有重新观测。
