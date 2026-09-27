# C02 v277：Pages 历史目录完成，绑定缺省语义仍待核实

2026-09-21，Checklist v1.175。**HISTORY_METADATA_OBSERVED_BINDING_SEMANTICS_PENDING**。完成当前 Token 可见的 **19 个 Pages 项目、1,560 条历史部署**的 production / preview 分页和双轮核对。成功清点 **182/182 GET、68,896 ms**；这不是历史绑定完整性、全调用路径或执行准入证明。

## 实现与边界

新增独立主机脚本 `scripts/deploy/byok-d1-pages-history.mjs`：先读全项目目录，再遍历两种环境的全部部署，完成一轮后再做第二轮，最后复核项目目录。绑定关系由部署历史自身返回的字段提取，不用项目当前配置替代。`uses_functions=false/null`、跳过或失败的旧部署均不排除。

每次至多 1000 次 GET、4 路并发、10 分钟总期限、20 秒单请求、2 MiB 解码正文；另限制 100 个项目、10,000 条部署、每环境 5,000 条及 200 页。页数、总数、重复 ID、项目归属、环境、绑定别名一致性与前后快照都检查。发送前刷盘 PENDING，独立目录单次执行，失败留存，无自动重试；超时和取消不允许迟到响应改写最终结果。只保存非敏感投影与摘要，不保存环境变量或配置正文。

Cloudflare 技能与 Firecrawl 官方来源核查促使本轮明确区分三件事：目录遍历完成、返回绑定已检查、绑定覆盖可证明完整。官方[部署列表](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/)与[详情](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/)模型未给出历史服务 / D1 字段缺省语义；已安装 Wrangler 的 Pages 配置转换逻辑处理的是项目当前配置，也不能据此推断历史缺省为空。公共检索未发送账户配置、Token 或私有数据。

## 真实观察

成功窗口：**2026-09-21 04:43:10.749–04:44:19.643 UTC**。19/19 项目双轮相同，项目目录结束核对通过；共 1,518 条 production、42 条 preview。最大项目 cinagroup 为 645 条。153 条部署的 Functions 标志未知，均被保留；当前项目标志为 false 也没有使历史记录被跳过。

| 历史绑定字段 | 显式返回的部署数 | 字段缺失的部署数 | 返回条目数 |
| --- | ---: | ---: | ---: |
| services | 0 | 1,560 | 0 |
| d1_databases | 51 | 1,509 | 51 |
| durable_object_namespaces | 0 | 1,560 | 0 |

已返回的 51 个 D1 条目均未匹配固定 staging D1；未观察到指向四台 staging Worker 的显式服务 / DO 绑定。**不能表述为“所有历史部署都没有 staging 关联”**：缺失字段仍是 `ABSENT_UNVERIFIED`，不是空集合。两轮一致只是观察窗口内稳定，既不是原子快照，也不证明 Token 可见范围完整。

`historyCatalogueComplete=true`、`reportedBindingMapsObserved=true`；`historicalBindingsComplete=false`、`absenceSemanticsVerified=false`、`allInvocationPathsInventoried=false`、`fullPreflightPassed=false`。未接入允许部署的完整预检。

## 失败保留与验证

前两次结构探测共 10 次 GET，确认真实部署对象可能含 D1 的 `{id}`，且 production / preview 可独立分页。首轮完整清点随后在 cinagroup 的第 3 页、第 12 条记录处中止：该跳过部署的 `uses_functions` 是 `null`，原校验只接受布尔值或缺省。首轮 34 次请求中 31 个 200，另外 3 个在途请求取消、没有记录到状态码；不得当作服务端未执行。

追加单页诊断 1 次 GET 确认字段类型，归档原清点源码与测试，再增加针对性反例：旧源码 **1 FAIL**，修正后源码 / 打包均通过。修正仅将历史 `uses_functions:null` 保留为未知，不过滤记录、不放松绑定或分页校验。诊断脚本的 `validTimes` 使用了过度转义的正则，其布尔结果不作为时间戳异常证据；真实时间校验未修改。

最终 **244 PASS / 0 FAIL**：源码 54、打包 54、既有版本清点 47、当前配置清点 37、读取传输 52。首轮本地 242 PASS、真实失败、针对性旧版失败和全部日志保留，不覆盖或删去。该结果仅为主机逻辑验证，不替代原生 Workers / D1 验收。

本轮共 **227 次管理 GET 尝试：224 个 200、3 个无记录状态**。无云写入、部署、D1 SQL、公开 Worker、模型或 KMS 调用。首轮累计 US$2 上限不重置，实际账单本轮未刷新。

## 证据与下一步

发布核验：本轮 47 项文件摘要；v276 的 20 项、映射的 v275 35 项及 8 个维护守卫文件均未改变；两次完整清点的 70 / 366 条哈希链逐条通过。未重验 v273 的整个历史依赖树。原生 5/10/15 秒维护新鲜度及数据库围栏未修改，实际 BYOK 执行保留目录仍不存在。

后续按顺序：

1. 确认 Pages 历史缺省绑定的可靠契约或受支持的替代绑定来源；不得仅因两轮一致而放行。
2. 补齐仍拒绝访问的 11 个 Zone 路由、Dispatch / 资源可见性和其他调用来源；本轮没有重复查询未变的路由权限。
3. 接入完整当次预检，刷新入口关闭、数据库 / 预算基线及独占证明，再做原生时序与 BYOK 验收。

C02.G / C01 继续未通过，不修改生产或开启测试入口。

[机器证据](./C02-byok-d1-pages-history-v277-results.json)
