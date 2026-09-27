# C02 v285：新确认后的 Zone 路由权限复核

2026-09-21，响应用户新回复“路由只读权限已补齐”，使用当前进程的 CLI Token 对固定账户再执行一次只读检查。结果仍为 **PARTIAL_ZONE_ROUTE_ACCESS_UNCHANGED**：17 个 Zone 中 6 个可读、11 个 HTTP 403，权限缺口未关闭。

## 本次结果

观察时间 `2026-09-21T07:12:26.016Z` 至 `07:12:37.962Z`（新加坡时间 15:12:26 至 15:12:37），耗时 11,946 ms。共 19 次管理 GET：前后 Zone 目录各一次、17 个 Zone 路由各一次；8 次 HTTP 200、11 次 HTTP 403，无自动重试。

| Zone | 路由 HTTP 状态 | 已读取路由数 |
| --- | --- | --- |
| china-electric.com | 403 | 未知 |
| cinachain.cn | 403 | 未知 |
| cinachain.com | 200 | 5 |
| cinaclaw.cn | 403 | 未知 |
| cinaclaw.com | 403 | 未知 |
| cinacoin.cn | 403 | 未知 |
| cinacoin.com | 200 | 16 |
| cinagroup.cn | 403 | 未知 |
| cinagroup.com | 200 | 4 |
| cinaseek.ai | 200 | 1 |
| cinaseek.cn | 403 | 未知 |
| cinaseek.com | 403 | 未知 |
| cinaskill.cn | 403 | 未知 |
| cinaskill.com | 403 | 未知 |
| cinatoken.cn | 403 | 未知 |
| cinatoken.com | 200 | 2 |
| 海内集团.中国 | 200 | 0 |

本次 11 份拒绝响应均返回 `No access to the specified resource.`，没有非空错误码。诊断脚本允许错误码缺省并原样记录为 null，不再因整数校验而丢失错误消息；未修改既有 v282 证据。状态、字节数与响应哈希均保留，不保存或输出 Token。

六份已读列表共 28 条路由，未指向四个固定 staging Worker。Zone / 状态 / 路由数量 / 已读路由投影哈希均与 v282 一致。前后 Zone 目录一致不是原子快照，也不能证明未读的 11 份路由或其他调用路径没有 staging 入口。

## 验证与边界

- 使用 Cloudflare / Wrangler 技能约束只读范围，并核对本机官方 SDK 的单页路由列表契约。最多 19 GET、3 并发、单请求 20 秒、总期限 120 秒；不调用部署工具。
- 两个本轮脚本语法检查通过；38 条操作日志哈希链、每次 PENDING 与完成记录核对通过。v284 的 767 项直接产物及八个维护守卫摘要保持一致，未递归重验证整个历史依赖树。真实执行 reservation 仍不存在。
- 只新增诊断脚本及证据文档，未修改业务代码、未重跑业务测试。未重新比较 Windows User / Machine Token，不把 v282 的环境比较当作本次事实。
- 云写入、部署、D1 SQL、公开 Worker、付费模型、KMS 调用均为 0；未刷新账单，不重置累计 US$2 上限，不声称已核验余额。5/10/15 秒维护限制不变。

## 下一步

需提供正在修改的 Token 的**权限名称及 Zone 资源范围脱敏截图**，并核对其持有者的账户成员 Zone 权限。不要提供 Token 值；无需增加 Write 或 Token 管理权限。目前证据不能区分 Token 资源范围、成员权限、正在使用的凭据与网页所修改凭据是否一致等原因。

获得可区分原因的新信息之前，不再重复同样的 403 请求。Pages / Dispatch、排他、累计预算、原生时序及完整准入提供器仍未完成，`allInvocationPathsInventoried`、`fullPreflightPassed`、`databaseQuiescenceProved`、`nativeTimingQualified` 均保持 false；C02.G / C01 不放行。v284 的部分只读证据组件成果保留，不代替缺失的权限和完整准入。

[机器证据](./C02-byok-d1-route-permission-v285-results.json)
