# C02 v275：活动部署与预览版本绑定清点（部分完成）

2026-09-21，Checklist v1.173。**LOCAL_PASS / PARTIAL_VERSION_BINDINGS_DEADLINE_RETAINED**。新增独立只读版本清点器，最终源码 / 打包 / 相关回归 177 项通过。真实读取取得 69 台 Worker 的部署信息及 389 个版本详情；68 台完成各自的前后复核，剩余一台遇到全局 5 分钟上限。因此，完整版本覆盖和完整预检仍未通过，未部署。

## 补足当前 settings 之外的覆盖

此前当前配置清点不足以说明所有可调用版本的绑定。此次按官方接口区分以下来源：

- 部署列表第一项才是当前承载流量的部署，不使用“最新上传版本”替代。[部署列表接口](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)
- 当前部署内 **0% 流量版本也要读取**：版本覆盖请求可指定这些版本，且覆盖头可经服务绑定转发。[Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)
- Preview URLs 开启时，分页读取所有列出的版本及其实际绑定；不使用 `deployable=true` 缩小集合，也不因 `hasPreview` 缺失或 false 而忽略某个已列版本。真实列表未提供该可选字段，不能把缺失当作无预览。[版本列表](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/)、[版本详情](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)
- Preview URLs 明确关闭且前后复核一致时，只记录其路由关闭条件，不声称旧版本已经删除。官方说明关闭开关会同时关闭版本 URL 与别名 URL；这不代替其他入口和数据库静默证明。[Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)

## 实现与限制

新增 `scripts/deploy/byok-d1-version-inventory.mjs` 及对应测试。固定账户与四个 staging 目标，仅使用管理 GET；至多 4 个 Worker 并行、1000 次请求、单请求 20 秒、单响应 2 MiB / 4096 次读取、全局 300 秒。版本列表至多每 Worker 500 项 / 20 页，达到限制即保留不完整结果，不把截断当作完整。

每台 Worker 核对默认服务环境、当前部署及全部流量份额、显式预览开关；预览开启则读取全部页面。实际绑定来自每个选定版本的 `resources.bindings`，投影 staging 服务、D1、DO 与 Dispatch 关系，私有环境值和 Secret 值不写入结果。D1 的 `id` / `database_id` 两种字段若同时出现必须一致。

结束前重复版本目录（预览开启时）、部署、预览开关和默认环境；全局还要求 Worker 根目录一致。非默认历史环境、形状缺失、分页不一致、部署或开关漂移均不静默省略。一次性本地目录和刷盘哈希链保留失败；无自动重试 / 续跑，不输出原始异常消息或凭据。其观察结果不会设置完整预检、独占、数据库静默或原生时序资格。

## 实际结果

| 阶段 | 管理 GET 尝试 | 结果 |
| --- | ---: | --- |
| 两个现有网关的接口结构探测 | 8 | 全部 200；确认真实版本分页没有 `total_pages`，绑定字段结构可用 |
| 首轮账户版本清点 | 14 | 10 个 200、4 个无记录状态；失败保留，首个原因未确定 |
| 首个失败服务接口单次诊断 | 1 | 200；默认环境为 production，不能据此反推首轮失败原因 |
| 增加脱敏错误分类后的独立清点 | 860 | 859 个 200；第 860 个因全局期限中止 |
| 合计 | **883** | **878 个 200、5 个无记录状态** |

第二轮窗口为 **2026-09-21 04:00:31.592–04:05:31.599 UTC**，报告耗时 300009 ms。读取 69 个当前部署（各一个版本），观察到 29 台开启预览；累计取得 389 个版本详情。

- **68/69 台 Worker**完成自己的前后复核。
- `cinashop-api` 的版本目录共 **168** 项，详情完成 **154** 项；余下 **14** 项、该 Worker 的结束复核和最终全局根目录复核未完成。
- 已读取样本只投影出此前已知的五条 staging 关联：gateway → upstream、controller → receiver，及 gateway / upstream / receiver 的三个 staging D1 绑定。
- 这不是“没有其他旧版本关联”的证明，也不是原子快照。`callableDefaultVersionBindingsObserved=false`、`allInvocationPathsInventoried=false`、`fullPreflightPassed=false` 保持不变。

859 个 ACK 的单请求平均耗时约 1336 ms，合计请求耗时约 1148 秒；4 通道在 300 秒窗口中已接近满载。因此后续需要根据真实目录规模和延迟校准只读发现预算或调度，不能只声称并行化必然能在原上限内完成；也不能将失败样本改标成功。此发现预算与原生维护 **5/10/15 秒**的新鲜度规则完全分开，后者未修改。

## 验证与安全边界

最终 177 PASS / 0 FAIL：新增清点器源码 44、打包 44、现有当前配置清点 37、现有读取传输 52。覆盖零流量部署版本、分页后部历史绑定、可选字段缺失、私有值不落盘、漂移、无效形状、超时、取消、迟到响应、保留目录和符号链接。此前 43 项初始手工测试通过，不重复累计到最终 177 项；本轮不重跑也不借用 v273 的 733 项结果。未修改 Worker 业务源码，不宣称原生 Workers/D1 验收通过。

两轮真实清点共 1752 条刷盘哈希链记录已复核。35 个增量证据文件记录摘要；引用 v274 与 v273 清单文件，但未重新验证其全部历史依赖。两次未完成结果及修改前清点器字节归档均保留。

Cloudflare 技能和 Firecrawl 官方文档核对直接决定了零流量版本纳入、预览开关语义及分页实现。五页官方文档保存在 `.firecrawl/`，没有向抓取服务发送项目配置或凭据。

本轮云写入 / 部署 / D1 SQL / 公开 Worker / 付费模型 / KMS 调用均为 **0**；首轮 US$2 上限不重置，未刷新实际账单。没有创建真实 BYOK 执行保留目录。

仍需完成剩余版本覆盖、Pages 历史部署、11 个 Zone 路由权限缺口、可见性 / 独占 / 预算基线和原生维护时序等预检。C02.G / C01 继续开放。

[机器证据](./C02-byok-d1-version-inventory-v275-results.json)
