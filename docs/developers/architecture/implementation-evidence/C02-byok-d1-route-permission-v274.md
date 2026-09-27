# C02 v274：Zone 路由权限补充复核

2026-09-21，用户再次确认路由只读权限已补齐后，实际验证结果为 **PARTIAL_ZONE_ROUTE_ACCESS**：17 个已知 Zone 中，6 个路由接口成功、11 个仍返回 403。本补记不改变 Checklist v1.172 的未部署 / 完整预检未通过结论。

## 逐 Zone 结果

| Zone | 路由 GET | 返回路由数 |
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

所有 403 的响应均为 `No access to the specified resource.`。未知路由数不能当作零。成功的 6 个 Zone 合计 28 条路由；本轮不声称这些路由全部与 staging 无关，因为最初的 cinatoken.com 诊断只持久化了数量和响应哈希，没有路由目标投影。

## 已排除与仍未知

- 仅用布尔值比较，确认当前进程、Windows User 与 Machine 的 `CLOUDFLARE_API_TOKEN` 一致；没有输出或持久化 Token 值及 Token 哈希。
- 两次只读 Zone 列表均返回原有 17 个 Zone，响应字节哈希一致；后一次确认全部 `active`、`paused=false`、`type=full`。当前差异不能用这些状态字段解释。
- 成功与失败 Zone 的列表权限字段都含 `#worker:read`；此字段不足以替代对路由接口的实际验证。
- 至少部分 Zone 的实际路由读取已可用，不应再描述为整个 Token 完全没有路由读取能力。但现有证据不能区分 Token 的资源范围、账户成员的 Zone 权限或 Cloudflare 侧其他授权限制；没有读取 Token 策略详情，也没有增加 Token 管理权限。

请核对当前 Token 的 **Zone → Workers Routes → Read** 资源范围，以及持有者对表中 11 个拒绝 Zone 的权限。如界面已覆盖全部 Zone，可提供只含权限名称与资源范围的脱敏截图；不要发送 Token 值，无需增加 Write 权限。

## 操作与证据边界

本轮只对每个 Zone 读取一次路由，另读取两次 Zone 列表，共 **19 次管理 GET：8 次 200、11 次 403**。没有重跑 69 台 Worker / Pages 的全账户清点。云写入、部署、D1 SQL、公开 Worker、付费模型、KMS 调用均为 0；首轮累计 US$2 上限不重置，未刷新实际账单。

三个网络诊断脚本的 `node --check` 通过；摘要脚本核对 17 个唯一 Zone、19 个 GET、38 条操作日志及 10 个文件摘要。不修改业务代码、不重跑业务测试，不借用 v273 的 733 项本地测试作为本轮验证。原始失败日志保留。

本次为增量权限证据，引用并记录 v273 清单文件摘要，但**没有重新验证其全部历史依赖**。`allInvocationPathsInventoried`、`fullPreflightPassed`、`nativeTimingQualified`、`databaseQuiescenceProved` 均保持 false。仍需权限缺口、活动 / 预览版本绑定、Pages 历史部署及其他预检事项完成后，才可考虑真实独占 staging 验收。

[机器结果](./C02-byok-d1-route-permission-v274-results.json)
