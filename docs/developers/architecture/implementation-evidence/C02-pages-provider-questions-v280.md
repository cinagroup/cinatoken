# C02：Pages 身份与可见性问题——支持工单草稿

2026-09-21。**仅为本地草稿，尚未向 Cloudflare 或其他外部渠道提交。** 账户 / 项目标识不是凭据，但仍属于账户信息；请仅经自己的官方私密支持渠道发送，勿公开贴出完整附件。无需发送 API Token、环境变量、源码、构建日志、用户请求或账务数据。

## 希望确认的契约

我们需要在不调用公开 Pages / Worker URL、不修改或删除资源的情况下，核验同账户内 Pages Functions 对一组独立 staging Worker / D1 的绑定引用。已有项目、部署列表和内部 Worker 版本的只读访问，不能把未知字段或 404 自动视为无运行资源。请明确：

1. 是否有受支持的只读 API，将 **Pages deployment ID** 权威映射到其实际 **Worker script + version ID**？项目响应中的 `production_script_name` / `preview_script_name` 能否覆盖该项目全部仍可调用的历史 Functions 版本？是否存在迁移、保留或不可列出的版本例外？
2. Worker 版本中 `CF_PAGES_URL` 是普通 plain_text 绑定。它是否由 Pages 强制生成、不可被自定义配置覆盖，并具有官方保证的 deployment 身份语义？若没有，请提供替代接口。我们目前只把它当候选线索。
3. Pages deployment 返回 `uses_functions: null` 时含义是什么？尤其 build 已 success、deploy 仍 active 的历史记录，能否已经上传或仍保留可执行 Functions？如何只读取得实际执行资源 / 终态的权威证据？
4. 已知内部 Worker 的 `versions` 目录返回 404 / 10007 时，能否区分不存在、不可见、历史版本已迁移及其他原因？是否存在不依赖公开 URL 探测的正式覆盖证明？
5. Pages GET 对短 ID 返回 404 / 8000009，但相关内部 Worker 版本仍可读时，官方语义是什么？这些版本是否可能通过其他入口执行？不要求自动删除或重试部署。

## 可复核的具体记录

账户：`7ea8e46d8210bad342fa7595f7935fea`。

### 长期 active 的部署

- Pages 项目：`cinaseek`，project ID `1a335b76-d399-4058-a2bf-85ac4bf0da99`。
- deployment ID：`4c3f58d9-11b9-4875-adba-ad8165ff3180`；short_id：`4c3f58d9`；production。
- 2026-09-21 的列表双轮和 **05:44:29–05:45:13 UTC** 窗口内详情读取均报告 `uses_functions:null`、`is_skipped:false`、latest stage `deploy / active`。
- deploy 开始时间：`2026-05-22T18:43:29.125833Z`；结束时间 null。前序 build 为 success。
- 项目返回的 production 内部名为 `pages-worker--14050307-production`。当次版本列表前后均只有 2 个，详情均可读：
  - `18c0a4e1-8f8f-4839-bac3-7e7a9c9036f9`，number 1，URL 绑定候选短 ID `83a34847`。
  - `24b07cdb-5a66-4776-8d64-4752030e2412`，number 2，URL 绑定候选短 ID `ab9bcd3d`。
- 两版本显式绑定均只含 6 个 plain_text；annotations 为空，script 元数据只有 etag / handlers / last_deployed_from 类型字段。没有找到上述 active 部署的候选，但这不是运行时不存在的证明。

### Pages 查询不到的预览候选

Pages 项目 `cinagroup`，内部名 `pages-worker--11827931-preview`：

| Worker version ID | URL 绑定短 ID 候选 |
| --- | --- |
| 599363e1-9566-4181-9913-2454d1fdf2f8 | 55e834ab |
| 76d8ab4d-72cd-4547-b7bb-bb9908d23a8a | e30cedc6 |
| ca0cd4d7-1d38-4af7-9e20-d1a20f78db4e | d51bbb95 |
| f4ab7b6a-9b70-465f-8af6-c0715671b9ce | a3bb7b39 |

2026-09-21 已读取这些 Worker 版本；随后对四个短 ID 的两轮 Pages deployment GET 均返回 404 / 8000009。同轮已知 deployment 的完整 ID 与短 ID 阳性对照均返回 200 且摘要相同。未调用公开 URL，未创建 tail，未删除 / 取消 / 重试任何部署。

### SDK 与实际生命周期字段差异（辅助）

- 四条旧记录返回 `queued / skipped`，不在当时已安装 SDK 的阶段状态枚举中。我们已保留实测值，但不据此推断执行资源不存在。
- 两条 cinagroup 旧部署的 deploy 结束时间早于开始时间；原值保留，没有归因为时钟偏差或修正服务端数据：`71f6f0e1-8790-4d4a-be63-a5cfb22bc844`、`ab3dc282-53b3-4160-ad56-cd9ed4247427`。

## 希望得到的答复形式

请提供对应的官方 API / 文档、字段保证或对具体资源的供应方核查结论；尤其区分“列表看不到”“已没有执行资源”“不可达”和“无 staging 绑定”。我们不要求也不授权在调查中删除、取消、重试、迁移或重新部署任何项目。涉及此类操作请先另行提出方案。

本地参考：[v279 生命周期证据](./C02-byok-d1-pages-lifecycle-v279.md)、[v280 定点核验](./C02-byok-d1-pages-targeted-v280.md)。外发前只选择必要片段，不自动上传整套本地证据文件。
