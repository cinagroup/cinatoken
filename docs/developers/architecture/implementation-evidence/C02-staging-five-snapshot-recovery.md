# C02.B2.2 — 五项最大快照与跨轮恢复

2026-09-08；Checklist v1.76。**四类各五份精确 256 KiB 快照、五项候选扫描、未认领任务的跨轮补齐、重复调用与审计一致性线上通过。认领后 interrupted 退避再恢复仍未线上验收；C02.B2.2 与 C02.G 不关闭。** [v1.75 四类三项证据](./C02-staging-max-snapshot-completion.md) 保持原状。

[机器可核验记录](./C02-staging-five-snapshot-recovery-results.json) 保存 117 个源码、91 个操作产物、8 个证据依赖摘要，保留被中断的预检和回归原始记录，另存本次完整线上运行及 550 项回归。新增四个固定五项的操作侧文件：fixture、分批器、进度校验和测试；Worker 运行时、部署、生产源码、配置及依赖均未修改。

## 中断后的恢复方式

2026-09-07 的首次启动被用户中断。原 cloud / regression / typecheck 会话句柄已失效；2026-09-08 的提升权限只读 Win32_Process 检查确认对应进程不存在。首次 cloud 记录仅 11 个 GET 管理请求，其中最后一个未记录完整响应；没有令牌创建、样本写入或公共测试 HTTP。该记录没有终态，不改写成 PASS，也不声称它完成了收尾。

首次回归只完成前六组共 441 项，没有整体结果。确认原进程不存在后，才启动新记录 run2。新运行重新验证全部源码摘要、四个 Worker 版本/设置、关闭入口、Access 策略、D1 schema/计数和三项生产只读指纹；同时核对首次生成的四组样本 ID 在数据库中全部不存在，之后才创建临时 Access 令牌。没有重放不确定的 seed，也没有重置累计请求或费用授权。

## 五项固定样本与本地验证

此前三项 fixture 的身份校验和 SQL 占位符不能直接用于五项。新增固定五项版本，沿用真实 repository 的意图准备/认领、预算预留/已出站、快照持久化和触发器入队；不插入伪造的 terminal job 或 receipt。

每类包含费用为 0 / 0.1 / 0.2 / 0.3 / 0.4 的五笔合成任务，四笔正费用各预留 500,000 micros。总合成预留 2,000,000 micros，全部恢复后合成已花费 1,000,000 micros、预留归零。每份序列化快照严格为 262,144 个 UTF-8 字节。

每组捕获 28 条原始 INSERT / UPDATE，按不超过 524,288 wire 字节的管理请求分批，保持 SQL、参数、顺序及快照摘要；最后禁用该用户和 key，再执行恢复 RPC。分批不承诺跨批原子性；遇到未知结果必须停止后续 seed 并核对耐久状态。

| profile | seed 批次数 | 最大单批 wire 字节 |
| --- | ---: | ---: |
| ASCII | 5 | 269,082 |
| Unicode | 5 | 269,082 |
| 密集 JSON | 5 | 269,058 |
| 转义字符 | 10 | 523,813 |

新增 **9 项**本地测试全部通过：

- 四类精确快照的 seed、结算、大审计相等性、重复调用和清理。
- 五项扫描在认领前停止、认领后 interrupted 两种边界，下一轮分别补齐；后者等待 SQLite 原始五秒退避，不重写 available_at，重认领的 receipt lease revision 为 3。
- 十笔真实 due 任务只扫描并提交前五笔，下一次补齐余五笔；精确清理一个租户不影响另一个。
- 转义样本每个分批中断前缀均可清理，并保持另一合成租户及外键完整性。
- 身份、费用、任务数、重复 ID、回执/日志/统计及不确定状态篡改被校验拒绝，超大单语句被分批器拒绝。

完整 staging 回归 **550/550**，失败、取消、跳过均为 0；定向 staging 类型检查退出 0。这是当前明确执行的 staging 测试链，不代表仓库全部测试。部分本地准入测试使用受控单调时钟，只证明逻辑边界；不替代真实 Workers 时序或物理内存证明。按 Workers 最佳实践与 Wrangler 技能保留这一证据分层，本轮没有改变部署来获得通过结果。

## 真实 Workers / D1 结果

四类均使用现有配置：maxItems=5、concurrency=1、runBudgetMs=5000、leaseSeconds=30，实验容量分配 64 MiB。不改配置、不伪造平台时钟、不重放推理。

| profile | 第一轮 scanned / claimed / committed | 第一轮剩余任务 | 第二轮 scanned / claimed / committed | 重复调用 |
| --- | --- | --- | --- | --- |
| ASCII | 5 / 3 / 3 | 2 个 pending，attempts=0 | 2 / 2 / 2 | 所有计数为 0 |
| Unicode | 5 / 3 / 3 | 2 个 pending，attempts=0 | 2 / 2 / 2 | 所有计数为 0 |
| 密集 JSON | 5 / 3 / 3 | 2 个 pending，attempts=0 | 2 / 2 / 2 | 所有计数为 0 |
| 转义字符 | 5 / 3 / 3 | 2 个 pending，attempts=0 | 2 / 2 / 2 | 所有计数为 0 |

第一轮均 admissionStopped=true，第二轮和重复调用均 false；所有调用 deferred=0，其余错误/不确定计数为 0、capacityLimited=false。12 次恢复/重复 RPC 均 HTTP 200、finished、retry_safe=false。

每轮前读取数据库真实 due 状态，每轮后按实际提交集合核对 11 项财务投影；已提交任务下一轮不再认领。20 份原快照和摘要保持不变，每笔最终 job revision=2、attempts=1，receipt lease revision=1。通过 D1 标量相等性核对 raw_usage、pricing_audit、route_trace、timing_metadata 与原快照一致；重复调用后财务投影和大审计内容仍一致。

**这是认领前停止后的跨轮补齐，不是认领后退避重试。** 第一轮剩余任务的 revision=0、attempts=0、last_error=null，没有 interrupted/deferred。不得用本地后认领测试或 v1.74 的历史部分状态补成线上证明。此外，真实云端每组只有五项；超过五项积压时的扫描上限目前只有本地十项测试证明。

## 隔离、清理与费用

run2 六项收尾全部通过：关闭控制入口，禁用/删除临时令牌，恢复 Access deny-all 并关闭 service-auth 401 模式；最后 RPC 后等待安全窗口、确认无 leased 任务，再精确删除本轮合成样本并复核基线。旧样本仍不存在。四个 Worker 版本及完整设置前后相同，workers.dev / previews 全部关闭，逐服务 custom domains / schedules 为空；其他 Access 应用未变。56 张表计数、295 个 schema 对象摘要保持/恢复基线，消费者控制行不存在，三项生产只读设置指纹未变。没有生产数据库写入或迁移。

本轮测试 HTTP **14**：两项鉴权拒绝、八次恢复和四次重复调用；首轮累计 **255**。run2 管理请求 158，计入中断预检的 11 次后合计 169（含一个无完整响应的只读 GET）；REST SQL 调用 89、语句 544、返回 meta 的读取行 5,877、写入行 780。指标不包含 Worker 内部 D1 操作，不能当作完整云账单。

四组总计 **US$4 合成账务**，不是实际付款、充值或云费用。真实模型调用 0、KMS 调用 0、部署 0、生产写入 0。首轮累计新增 **US$2** 授权跨日和重启均不重置；最终增量账单仍未核验。D1 实际收费依据资源指标，参见 [D1 计价](https://developers.cloudflare.com/d1/platform/pricing/)，不得用合成账务金额代替。

## 下一有限顺序与保留门禁

1. 用确定性的独立 staging 观测补齐“认领后 interrupted → 原始退避到期 → 新租约恢复”，核对 revision、回执、全部财务投影和重复调用；不能依靠无限重复抽样碰时序。同步补超过五项 due 积压的真实扫描边界。
2. 验证公开 Images 生产者产生最大快照的完整链路，包括边界拒绝和故障交接，而非仅操作侧准备快照。
3. 继续跨消费者完整物理容量、其他故障组合及生产 SLO 验收。

Workers 的实例内存、执行时间和后台持有期限属于不同限制，参见 [平台限额](https://developers.cloudflare.com/workers/platform/limits/)。本次成功不提供物理内存峰值或完整并发安全证明，64 MiB / 单消费者 / 每批五项仍只是实验配置，生产容量未启用。C02.B2.2、C02.G、Google Cloud KMS/IAM、Node 备选、其他模态、客户端未知结果/幂等及退款政策门禁继续保留；不调用推理补账，不重建无快照用量，不按 TTL 自动退款。
