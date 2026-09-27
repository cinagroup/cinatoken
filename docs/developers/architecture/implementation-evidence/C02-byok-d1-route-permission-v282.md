# C02 v282：再次确认后的 Zone 路由只读复核

2026-09-21，用户再次回复“路由只读权限已补齐”后，对固定账户重新执行一次完整的已知 Zone 路由权限检查。结果仍为 **PARTIAL_ZONE_ROUTE_ACCESS_UNCHANGED**：17 个 Zone 中 6 个可读、11 个 HTTP 403；不能宣告权限缺口关闭。

## 本轮观察

观察时间为 `2026-09-21T06:14:37.550Z` 至 `06:14:49.606Z`，共 12,056 ms。Zone 目录前后各一次 GET、每个 Zone 的路由各一次 GET，总计 **19 次管理 GET：8 次 200、11 次 403**。前后目录均为相同的 17 个 Zone；这不是原子快照，也没有重复读取路由来证明路由前后稳定。

| Zone | 路由 HTTP 状态 | 本次读取路由数 |
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

六份已读取列表合计 28 条路由，均未指向 `cinatoken-proxy-staging`、`cinatoken-staging-recovery-control`、`cinatoken-staging-usage-recovery`、`cinatoken-staging-images-upstream`。本轮补齐了 cinatoken.com 的目标投影；不能把这项局部事实扩展到其余 11 个未知列表，也不排除通过其他调用路径访问 staging。

`06:15:25.1120193Z` 的只读环境检查显示：当前进程、Windows User 和 Machine 均配置 Token，三者逐值比较一致。只输出存在性 / 相等布尔值，没有输出或保存 Token 值及其哈希。这排除了这三个环境作用域之间的旧值差异，但不证明用户修改的网页 Token 就是该 Token，亦不证明资源范围或账户成员权限正确。

## 证据与限制

- Cloudflare 技能用于约束为只读验证；路由列表契约核对了本机官方 SDK 的 `RouteListResponsesSinglePage`。没有增加权限、修改资源或发起支持工单。
- 脚本固定账户 / 已知 Zone 路径，最多 19 次 GET、3 并发，单请求 20 秒、整体 120 秒；不自动重试。结果及 fsync 操作日志在独立新目录落盘，不使用真实执行 reservation。
- 403 均保留 HTTP 状态、`success=false`、响应字节数 / 哈希。本轮错误详情投影要求整数 `error.code`，该校验未通过，故日志为 `FAILED_RETAINED`；**没有完整错误详情投影，不将旧错误文本当作本次原文**。不为补错误文本再请求同一接口。权限未通过的结论直接来自已记录的 HTTP 403，不受详情投影失败影响。
- 两个脚本 `node --check` 通过；摘要验证 17 个唯一 Zone 路径、19 次 GET、38 条日志哈希链及最终操作对应关系；六项本轮证据文件、v281 的 20 项直接产物与八个维护守卫摘要核对通过。未重新验证整个历史依赖树，未修改业务代码、未重跑业务测试，不计入旧版本测试数量。
- 云写入、部署、D1 SQL、公开 Worker、模型、KMS 调用均为 0。累计 US$2 上限不重置，未刷新账单，不声称余额已核验。

## 下一步

请提供当前所修改 Token 的**权限名称和 Zone 资源范围**脱敏截图，并核对 Token 持有者的账户成员 Zone 权限；不需要 Token 值，也不需要 Write 或 Token 管理权限。现有证据不能区分 Token 资源范围、成员权限或其他 Cloudflare 授权限制。

在得到新外部事实前，不重复这些 403 查询。Pages 身份 / 生命周期契约、Dispatch、独占 / 预算、完整当次预检提供器和原生维护时序仍待解决；可继续同一 C02 的本地来源冻结与只读预检接线。`allInvocationPathsInventoried`、`fullPreflightPassed`、`nativeTimingQualified`、`databaseQuiescenceProved` 保持 false；C02.G / C01 及后续依赖不放行。原有 5/10/15 秒规则不变。

[机器结果](./C02-byok-d1-route-permission-v282-results.json)
