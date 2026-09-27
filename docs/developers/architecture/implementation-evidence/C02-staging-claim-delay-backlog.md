# C02.B2.2 — 认领延迟、原生退避与十项积压恢复

2026-09-08；Checklist v1.77。**真实 Workers / D1 已通过认领后 interrupted → 原始退避 → 新租约恢复，以及十项 due 积压的五项扫描边界。C02.B2.2 与 C02.G 不关闭。** [v1.76 四类五项实证](./C02-staging-five-snapshot-recovery.md) 保留原状。

[机器可核验记录](./C02-staging-claim-delay-backlog-results.json) 固化 122 个源码、115 个操作产物、9 个证据依赖摘要，包含只读预检、部署、实验、完整收尾、构建与 568 项回归。新增五个文件：staging 认领延迟探针、专用 Worker 入口、探针测试、双租户积压校验器及测试。仅 staging consumer 运行代码和部署改变；生产、默认入口、恢复 repository、计费算法及依赖版本未改。

## 探针边界与离线验证

既有 fencing 探针暂停的是结算事务，不能确定性覆盖“认领成功、返回认领结果前耗尽准入窗口”。新探针包裹真实 D1 claim：核验完整 SQL、参数、身份、token、revision 和原始成功结果；控制行 armed → held 使用精确原值 CAS，配置等待 6 秒，再通过真实 D1 CAS 转为 released，随后返回同一个原生结果对象。它不改 job、available_at、快照、租约凭据或平台时钟。

旧 fencing 包装保留在内层。控制行不存在、已 released 或属于其他合成身份时正常透传；控制行 malformed / 超长 / 非本描述、claim SQL 漂移、非初始认领、原值 CAS 失败均拒绝。零变更 claim 不迁移控制行、不启动 timer、不伪造 ownership。没有新增网络能力、binding、公共参数或 HTTP 触发器；RPC 仍只接受零参数，HTTP 仍拒绝。

新增 **18 项**测试通过：探针 12 项（含真实计时持有、busy、原生重试、控制权变化、零变更 claim、组合 fencing 拒绝）和积压校验器 6 项（十项分批、前/后认领中断、3+3+3+1、全局顺序及跨租户篡改）。完整 staging 测试链 **568/568**，失败、取消、跳过均为 0；不是仓库所有测试的声明。

按 Workers 最佳实践与 Wrangler 技能，先核对当前官方文档及类型定义，再运行 Wrangler 4.127.1 的 types、types --check、禁用自动资源创建/自动配置的 deploy --dry-run，以及既有 staging 类型检查，均退出 0。新配置仅 main 相对上一 staging consumer 改变，生成类型与原有绑定一致；17 个构建输入和 16 个产物摘要复核通过。

**6 秒只是探针配置，不单独构成线上成功证据。** Workers 的时钟在 I/O 后推进，本地计时不能替代云端行为；本轮以数据库和真实 RPC 返回的 interrupted、退避与新回执作为验收依据。[Workers 时钟说明](https://developers.cloudflare.com/workers/runtime-apis/performance/) 本实验是延迟认领确认，不等同于永久确认丢失或原生执行上下文终止。

## 十项真实 due 积压

两组独立合成租户分别为 Unicode 和转义字符，各五份精确 **262,144 UTF-8 字节**快照；每组沿用费用 0 / 0.1 / 0.2 / 0.3 / 0.4 的五笔合成账务。真实 repository 的 28 条 seed SQL 按每批最多 524,288 wire 字节送入 staging D1：分别 5 批 / 10 批，最大单批 269,082 / 523,813 字节。样本 key 和用户在恢复前已禁用。没有推理调用，没有直接插入 terminal job 或 receipt。

每次恢复前读取未按 fixture 过滤的全局标量查询，按 available_at、request_id 排序并 LIMIT 11：必须恰好是本轮十项，拒绝第十一项、外来身份、错误摘要或顺序。所有 pending 均等待原始 due 时间到期，再执行无其他写入者的单次 RPC。每轮用实际变化集合核对首批 due 前缀和两个租户各自的 **11 项财务投影**，不能用总金额抵消跨租户错误。

配置保持 maxItems=5、concurrency=1、runBudgetMs=5000、leaseSeconds=30，逻辑实验容量 64 MiB。

| 轮次 | scanned | claimed | 本轮 committed | deferred | 剩余 pending | admissionStopped |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1：延迟首个 claim | 5 | 1 | 0 | 1 | 10 | true |
| 2 | 5 | 2 | 2 | 0 | 8 | true |
| 3 | 5 | 3 | 3 | 0 | 5 | true |
| 4 | 5 | 3 | 3 | 0 | 2 | true |
| 5 | 2 | 2 | 2 | 0 | 0 | false |
| 重复调用 | 0 | 0 | 0 | 0 | 0 | false |

全部六次恢复/重复 RPC 为 HTTP 200、finished、retry_safe=false，blocked / lostOwnership / uncertain / skipped 均 0，capacityLimited=false。这里的 5 秒是停止后续准入的预算，不是强制取消正在进行的操作或整个 HTTP 请求的五秒时限。

## 原生退避、回执与账务证明

探针只有收到原生 revision=1 / attempts=1 的成功 claim 结果才会暂停；线上释放该结果后，原消费者记录 pending / revision=2 / attempts=1 / last_error=interrupted。数据库观察值 available_at=1788829718、updated_at=1788829713，差值严格为 **5 秒**；操作脚本没有更新这些字段，只等真实 due 时间到期。

该任务最终 job revision=4 / attempts=2，receipt lease_revision=3；其余九项均 job revision=2 / attempts=1、receipt lease_revision=1。十份原快照、摘要与 recorded_at 不变；回执、日志、预算预留/释放、审计、统计、意图和尝试记录全部按租户和请求核对。两个账户各自合成已花费 1,000,000 micros、预留归零。

D1 标量相等性确认每笔 raw_usage、pricing_audit、route_trace、timing_metadata 与原快照一致；重复调用后全部 11 项投影和这四类大审计内容仍不变。校验器重新播放每轮证据后才生成最终 PASS 记录。没有用“扫描五项”冒充“本轮提交五项”，也没有重放推理补账。

## 部署、隔离与收尾

只部署一次 `cinatoken-staging-usage-recovery`，版本从 `e386f210-43a8-4b03-b91e-f179cadf8354` 变为 `b45d752e-361e-45d8-aca7-f24feca4afec`；网关、控制器和私有上游版本不变。消费者完整设置 SHA256 仍为 `31b9554cdf690adde347a5d03024fa2db125d214c75c92a3ed2bfff95e447e96`，仅持有 staging D1 和原来的八项变量。运行时探针在控制行不存在时不触发延迟；生产/default 模板没有启用它。

只读预检和部署后核验均通过。实验前无凭据及错误凭据两项请求均被 Access 返回 401。实验六项收尾全部通过：关闭控制入口、禁用令牌、恢复 deny-all 并取消 service-auth 401 模式、删除令牌、等待最后 RPC 后安全窗口并精确清理本轮样本、复核最终状态。控制行删除使用精确描述/原值匹配，INSERT 未落库时允许不存在；不清理仍 leased 的任务。

最终四个 Worker 的 workers.dev / previews 均关闭，custom domains / schedules 为空；临时令牌和本轮两租户样本已删除，两个消费者控制行均不存在。56 张表计数恢复基线、295 个 schema 对象摘要不变，其他 Access 应用未变，三项生产只读指纹未变。没有生产数据库写入或迁移，没有重放 ALTER。

## 费用口径

本轮公共测试 HTTP **8**，首轮累计 **263**，不因跨日、模式或重启重置。只读预检 / 部署 / 实验的管理请求为 61 / 65 / 136，合计 **262**；其中 REST SQL 调用 82、语句 347、返回 meta 读取行 8,299、写入行 393。没有包含 Wrangler 内部管理请求或 Worker 内部 D1 指标，不能作为完整账单。

两组总计 **US$2 合成账务**，恰与费用授权上限同数，但不是实际充值、付款或云费用。真实模型调用 **0**、KMS 调用 **0**、生产写入 **0**。首轮累计新增费用授权仍为 **US$2**，最终增量账单未核验。

## 下一有限顺序与保留门禁

1. 先校准公开 Images producer 的**最大可达快照**，不要假设公开输入能产生精确 256 KiB。实际生产者会将 usage 缩为六个计数，剔除路由诊断、timing metadata 和用户快照等；操作侧 exact-size fixture 填充这些字段，不能直接替代公开链路证据。先在真实 generations / edits 本地链路测字节与摘要，检查仍可增长的 catalog 定价审计身份。[生产者实现](../../../../packages/proxy/src/services/image-usage-recovery.ts)
2. 分开验证公开控制字段的出站前拒绝、上游 usage 规范化限额、保留定价审计/快照编码边界；保留 503 image_settlement_unconfirmed、retry_safe=false 与已出站意图/预算语义。只将已校准的小矩阵送独立 staging，再核对故障交接、恢复和重复调用，不为凑大小放宽生产合同。
3. 继续跨消费者完整物理容量、其他故障组合及生产 SLO；本轮不是并发消费者公平性、全局容量或所有失败交错的证明。

64 MiB / 单消费者 / 每批五项仍为实验分配，没有测得物理内存峰值，也没有启用生产容量。C02.B2.2、C02.G、Google Cloud KMS/IAM、Node 备选、其他模态、客户端未知结果/幂等及退款政策门禁继续保留。无快照不重建用量，不按 TTL 自动退款。
