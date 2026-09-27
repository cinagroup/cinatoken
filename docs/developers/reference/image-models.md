# 文生图模型（Image Models）

本文整理 Gateway 当前支持的 **OpenAI Images** 文生图模型：预设 catalog、Provider 配置、参数差异、计费与预检、运营验收。

API 字段细节见 [用户接口 · Images](../api/user.md#images图片生成--编辑)；逐步验收清单见 [Admin API · 运维验收](../api/admin.md#运维验收文生图模型-gpt-image-2)。

## 架构要点

| 项 | 说明 |
|----|------|
| 入口 | **`POST /v1/images/generations`**；OpenAI 另有 **`POST /v1/images/edits`**（multipart） |
| 不走 Chat | 文生图 **不** 走 `/v1/chat/completions` |
| 驱动 | `packages/proxy` OpenAI Images driver；failover 复用 `failoverDispatch` |
| 路由协议 | `model_routes.upstream_protocol` **锁定 `openai`**（anthropic/gemini 保存应 400） |
| Kind 判定 | `output_modalities` 含 **`image`**（勿用 input 含 image——多模态 LLM 也会有） |
| Catalog 列表 | 默认 `/v1/models` **不含** 纯 image 模型；需 `kind=image` / `kind=all`，或直接打 Images API |
| 计费权威 | **双模式**：`pricing_profile.image_billing_mode` = `token`（usage 分项 × `image_*`）或 `per_image`（确认输出张数 × `image.default`，可选参考图 `image.input`） |

## multipart 上传资源边界

2026-09-06 本地实现，尚未部署：`POST /v1/images/edits` 与 `/api/v1/images/edits` 在读取上传时检查下列限制，超限不会进入选路、上游发送或用量结算。尾斜杠路径仍由严格路由返回 404，不声明为可用别名。

| 项目 | 入口限制 |
| --- | --- |
| 原始请求体 | 50 MiB，包含文件、字段及 multipart 分隔内容；不是 100 MiB |
| 文件 | 最多 5 个文件部分，每个原始文件部分最多 20 MiB；未知字段名下的文件也计入资源数量 |
| 表单部分 | 最多 64 个，重复字段也逐个计数 |
| 普通字段 | 单字段最多 64 KiB，所有普通字段合计最多 128 KiB，按上传字节计算；业务字符/参数校验仍适用 |
| 部分头部 | 每部分最多 16 KiB，不含末尾四字节头部结束标记 |
| 外层 Content-Type / boundary | Content-Type 最多 1,024 字符；boundary 为 1–70 个有效 ASCII 字符，重复 boundary 参数拒绝 |
| 前后附加内容 | preamble、epilogue 与已识别分隔行 padding 合计最多 16 KiB；未完成 padding 行也有 16 KiB 上限 |

格式错误、文件数量/单文件超限维持受控 400；请求体、字段、头部及表单数量等资源超限为 413。当前文件字段形式保持兼容；该检查不赋予未知字段新的业务含义。取消/总时限仍沿用同一请求生命周期。

公开 edits 现已改为单次扫描、请求所有的 64 KiB 文件页与按需流式出站，不再把完整上传交给原生 formData 或 Hono bodyCache；仅用有界头部和七字节合成正文探测本运行时的文件元数据、编码及 BOM 语义。明确拒绝后的合法重试复用文件页；观察到 2xx 且上传已结束后可提前释放全部文件页，未满足这两个条件时仍保留到安全终态，完成/失败/取消/到期由请求 owner 兜底清理。内部旧 bytes/Blob 调用者仍保留原生 FormData 兼容路径。

扫描器为公开 edits 的 framing 权威：有界分隔行 padding、文件内非分隔符的相似前缀与大小写不敏感的外层媒体类型可能比旧 Hono/原生组合接受更多合法形式；不承诺与旧实现对所有边缘输入完全一致。字段/文件元数据沿用本运行时探针，Node/Workers 的编码差异仍需真实运行时验收。

图片非 SSE JSON 的**上游读取**硬容量保持 32 MiB 原始字节，不等于规范化后客户端输出字节上限。公共读取器单次解码最多 64 KiB；普通 generations/edits 分段提取字符串/标量，经原生解析紧凑结构并还原字段，不再保留完整原始 JSON 文本。无转义片段复用已有解码文本；含转义或控制字符的片段仍经原生解析，完整语法不跳过。仍在 EOF、完整语法和业务验证后按需编码，输出每页最多 64 KiB，不提前发布部分图片。原始内容、显式 metadata、usage 与重复键语义保留；裸数字的词法现在逐段检查，保留有界有效位、指数及尾部状态，再交原生 Number 舍入，不再拼接整个数字文本；负零/舍入/溢出保持，不新增公开数字位数限制。Base64 媒体识别只提取有限前缀，过长 data URL 类型提示不自动推断 media_type。编码器持有结果至 EOF/取消/错误/原请求绝对 deadline；慢读/不读可能在 200 headers 后出现正文错误。编码 EOF 不是网络接收确认，不改变已确认生成的原有用量结算或允许重放。

生成请求 JSON、Images 非 SSE 响应（包括错误响应）及单个 SSE 事件均有构造值/对象前的结构预算：最多 64 层容器、65,536 个节点，包括容器、标量、属性名，重复属性和未知字段也计数。生成请求超限为 413，2xx 响应超限仍禁止重放，SSE 按原 error / DONE 合同终止。普通响应和生成入口均以分段解析和紧凑结构还原；响应长值及生成入口的参考图/透传长值保留片段。生成 prompt 逐页去首尾空白，验证既有 4,000 字符限制后才还原原生值，等待 Guardrail 前不再保留原始填充；格式/顺序生成等字段按原有 trim、透传、类型或存在性规则显式适配。六个标量控制和 provider 整个最终值先通过 [公开控制限额](../api/user.md#生成-json-控制字段长度上限)，再还原有界原生值；错误类型标量内部保持分段，重复键只还原最后值；Guardrail 投影不扩大，SSE 仍按事件整体解析。允许范围内沿用原生 JSON 值/语法合同并用差分测试核对；顶层长字符串仍非合法请求对象，片段类型不会作为对象发给供应商。既有结构限制会拒绝过去尝试接受的极深/极密输入；该预算不扩展到 multipart provider 字段、路由默认参数、Admin 或其他模态。

经用户新授权：上述 JSON 中每个属性名最多 **256 个解码后的 UTF-16 单元**，包含任何层级的未知/重复/被覆盖名称，读取时超限即拒绝。每份规范化并补充计量别名后的完整 `raw_usage` 最多 **64 KiB UTF-8 紧凑 JSON**，在原生审计字符串构造前检查，不截断、不删未知字段；原始格式空白/被覆盖 usage 仍只受原始字节/结构限制。普通 2xx 后容量拒绝为 502 且成本未知/禁止重放，SSE 发一次 error / DONE、不发布该 completed 图片，保留适用预留上界；客户端取消/超时政策不变。详见 [公开限额与错误合同](../api/user.md#json-属性名与上游-usage-审计上限)。

生成入口已直接消费受限请求流，不再留下 Hono 完整文本缓存；BOM/UTF-8 替换及 50 MiB 容量不变；控制字段按用户批准明确收紧为公开限额。出站前固定合并后的字段值，直接按 UTF-16/JSON 转义规则计算精确 Content-Length，不为字符串值或属性名重复序列化/编码；按需发送不超过 64 KiB 的字节页。发送时无需转义的片段复用原值，其余最多 8 KiB 的字符片段仍使用原生转义，跨页代理对保持完整。早期响应 headers 不会立即截断上传；普通 JSON 完整读取或 SSE 安全终态负责收尾，明确拒绝后的合法重试仍发送完整原请求。路由默认参数不受入口结构预算直接约束，不能把编码校验当成默认参数容量准入。

以上**不是零拷贝、物理清零或并发内存验收**。[当前属性名/审计限额](../architecture/implementation-evidence/C02-image-audit-limits.md)新增 61 项测试；完整 pretest 链与主 suite 2,989 项、安全专项 2,614 项（重叠）及三项类型检查通过。用户已批准并公开每个 Images JSON 属性名 256 UTF-16 单元、规范化后 raw_usage 64 KiB UTF-8 限额；前者在解析准入时检查，后者在完整审计字符串构造前检查。普通 2xx/SSE 新容量拒绝保留成本未知并禁止重放，不静默截断审计。usage 恢复紧凑页存储，但大 usage 在拒绝前的解析工作集、响应与后台记账持有期、SSE/其他原生边界及整个实例容量仍须验收。完整 EOF/语法之前不交付普通结果，被覆盖内容仍计入原始字节/节点预算；[前轮长键恢复](../architecture/implementation-evidence/C02-json-key-restore.md)、[用量审计](../architecture/implementation-evidence/C02-image-usage-working-set.md)、[紧凑页](../architecture/implementation-evidence/C02-json-page-storage.md)历史结果按旧容量合同保留。没有 Workers/Node 22/完整网关连续峰值或真实供应商验收。

## 目录中的 Image 预设

静态预设按 **`<vendor>-image.json`** 单独维护（LLM 仍在 `<vendor>.json`）：

- OpenAI：`packages/admin/lib/model-presets/openai-image.json`
- 字节 / 豆包：`packages/admin/lib/model-presets/bytedance-image.json`
- 智谱：`packages/admin/lib/model-presets/zhipu-image.json`
- xAI：`packages/admin/lib/model-presets/xai-image.json`
- Google：`packages/admin/lib/model-presets/google-image.json`
- 阿里云百炼：`packages/admin/lib/model-presets/aliyun-image.json`

Admin → Models → Import 勾选导入；**同 id 已存在不会覆盖**——改价需删后 re-import 或 PATCH。

| Catalog id | 展示名 | Vendor | 典型区域 | 图生图 / 编辑 | 计费模式 |
|------------|--------|--------|----------|---------------|----------|
| `gpt-image-2` | GPT Image 2 | openai | 海外 | **`/v1/images/edits`**（multipart，最多 5 张） | **`token`**（官方 $/1M） |
| `doubao-seedream-5-0` | Doubao Seedream 5.0 | bytedance | 国内（火山方舟） | generations + JSON **`image`** | **`per_image`**（¥0.22/张一口价） |
| `doubao-seedream-5-0-pro` | Doubao Seedream 5.0 Pro | bytedance | 国内（火山方舟） | 同上 | **`per_image`**（¥0.30/¥0.60 按像素档 + 参考图） |
| `glm-image` | GLM Image | zhipu | 国内 / Z.AI 国际 | generations（按上游） | **`per_image`**（¥0.1/次） |
| `grok-imagine-image-2.0` | Grok Imagine Image 2.0 | xai | 海外 | generations（及上游 edits） | **`per_image`**（$0.04/张一口价） |
| `grok-imagine-image-quality` | Grok Imagine Image Quality | xai | 海外 | generations（及上游 edits） | **`per_image`**（1K $0.05 / 2K $0.07；input $0.01） |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | google | 海外 | generations（OpenAI 兼容层） | **`token`**（Nano Banana 2） |
| `gemini-3-pro-image-preview` | Gemini 3 Pro Image Preview | google | 海外 | 同上 | **`token`**（Nano Banana Pro） |
| `qwen-image-3.0-pro` | Qwen Image 3.0 Pro | aliyun | 国内（百炼） | DashScope 原生（非 OpenAI Images） | **`per_image`**（¥0.25/¥0.50 按 1K/2K + 参考图） |
| `qwen-image-3.0` | Qwen Image 3.0 | aliyun | 国内（百炼） | 同上 | **`per_image`**（¥0.18/张 + 参考图） |
| `wan2.7-image-pro` | Wan 2.7 Image Pro | aliyun | 国内（百炼） | 同上 | **`per_image`**（¥0.50/张一口价） |
| `wan2.7-image` | Wan 2.7 Image | aliyun | 国内（百炼） | 同上 | **`per_image`**（¥0.20/张一口价） |

约定：

- Catalog id **=** 上游 `provider_model_name`（与 `gpt-image-2` 一致）；若控制台用推理接入点，Route 可填 `ep-…`。
- 模型预设 **不** 写 `suggested_provider_model_name` / `suggested_custom_params`；默认参数由客户端或 Route `custom_params` 注入。
- 旧 id（如 `doubao-seedream-4-5-*`、`cogview-*`、`gemini-2.5-flash-image`、`grok-imagine-image-pro`、`qwen-image` / `qwen-image-plus` / `qwen-image-2.0-*` / `wan2.6-*` / `wanx*`）不进静态预设；库里若仍有旧行需手工清理。
- 新增厂商：补 `<vendor>-image.json` + Provider 模板（须有 OpenAI Images `images.generations`）+ 本文表格。阿里云百炼目录已收录当前代 `qwen-image-3.0*` / `wan2.7-image*`（按张计费）；上游仍是 DashScope 原生接口，**尚未**接入 Gateway OpenAI Images 驱动，导入后不能直接打 `/v1/images/generations`。

## Provider 配置

### OpenAI（`gpt-image-2`）

- Import / 手建 Provider：`endpoints.openai.base` = `https://api.openai.com/v1`（或显式写 `images.generations` / `images.edits` 完整 URL）。
- `base` 会派生标准路径：`…/images/generations`、`…/images/edits`。
- Key 写入 `providers.api_key`（单键；`status=active`）。

### 火山方舟 Volcengine Ark（Seedream）

Import 模板名：**Volcengine Ark**（`packages/admin/lib/provider-import-presets.json`）。

| 必须 | 禁止 |
|------|------|
| `endpoints.chat` + **`endpoints.images.generations`** 完整 URL | **不要** 设 `openai.base` |

原因：Seedream **没有** OpenAI 形态的 `/images/edits`；若配置 `base`，Gateway 会派生死链 edits URL。图生图走 generations + JSON `image`。

```text
chat:                 https://ark.cn-beijing.volces.com/api/v3/chat/completions
images.generations:   https://ark.cn-beijing.volces.com/api/v3/images/generations
```

Coding Plan / Agent Plan 模板路径不同，**勿与标准 `/api/v3` 混用**（额度不生效）。

### 智谱 / Z.AI（`glm-image`）

- 国内模板 **Zhipu GLM**：`endpoints.openai.base` = `https://open.bigmodel.cn/api/paas/v4`
- 国际模板 **Z.AI GLM (International)**：`https://api.z.ai/api/paas/v4`
- Coding Plan 模板为 chat-only，**不要**用来跑 Images。

### xAI（`grok-imagine-image-2.0` / `grok-imagine-image-quality`）

- 模板 **xAI (Grok)**：`endpoints.openai.base` = `https://api.x.ai/v1`（派生 `images/generations`）。
- `grok-imagine-image-2.0` 为 2026-08-07 正式 API 型号；官网输出一口价 **$0.04/张**（支持 `quality=low|medium` 与 `resolution=1k|2k`，价目页未再按分辨率拆档）。

### Google Gemini（Nano Banana）

- 模板 **Google Gemini (Generative Language API)**：`endpoints.openai.base` = `https://generativelanguage.googleapis.com/v1beta/openai`
- 官方 OpenAI 兼容层文档常见示例含 `gemini-3-pro-image-preview`；`gemini-3.1-flash-image` 为当前稳定型号，若兼容层拒识再按 Google 文档改 Route `provider_model_name`。
- 建议请求显式 `response_format=b64_json`（与 Google 兼容文档一致）。

### 阿里云百炼（`qwen-image-3.0*` / `wan2.7-image*`）

- 模板 **Alibaba Cloud Bailian** 仍只配 OpenAI 兼容 Chat + DashScope 音频 Base；**不要**把 DashScope 原生生图 URL 写进 `images.generations`（OpenAI Images 驱动无法直打该路径）。
- 官方：千问 3.0 走 `…/services/aigc/multimodal-generation/generation`；万相 2.7 走 `…/services/aigc/image-generation/generation`。二者均 **不** 支持 `compatible-mode` Images。
- 目录用途：Admin → Models → Import 的价目与型号；真正经 Gateway `/v1/images/generations` 出图需等 DashScope 生图驱动，或上游另提供 OpenAI Images 兼容层。

## 参数对照

| 维度 | `gpt-image-2` | Seedream 5（`doubao-seedream-5-0-*`） |
|------|---------------|--------------------------------------|
| 文生图 | `POST /v1/images/generations` | 同左 |
| 参考图 / 编辑 | **`POST /v1/images/edits`** multipart `image` 文件 | **无 edits**；`generations` + JSON `image`（URL / data URL / 数组） |
| `size` | `auto` / `1024x1024` / `1024x1536` / `1536x1024` 等 | `2K` / `3K` / `4K` 或 `WxH` 像素 |
| `quality` | `auto` / `low` / `medium` / `high` | 通常不用 |
| `background` | 支持（如 `auto`） | 无 |
| `watermark` | — | 可选 boolean，**显式传入才透传** |
| `sequential_image_generation` (+ `*_options`) | — | 可选，显式透传 |
| `optimize_prompt_options` | — | 可选，显式透传 |
| `response_format` | GPT Image 系列常直接 `b64_json` 且可能拒收该字段；**仅显式传入时透传** | 按上游 |
| `n` | Gateway 首期仅 **1** | 同左 |
| `prompt` | 必填，最长 4000 | 同左 |

透传实现：`packages/proxy/src/services/image-generation-extras.ts`（`applyOpenAiImageGenerationExtras`）。Route `custom_params` 与用户体合并规则见 [Route 默认参数合并](../api/user.md#route-默认参数合并)。

### 调用示例

海外 GPT Image：

```bash
curl -sS "$GATEWAY_URL/v1/images/generations" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a red apple","size":"1024x1024","quality":"low","n":1}'
```

国内 Seedream：

```bash
curl -sS "$GATEWAY_URL/v1/images/generations" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"doubao-seedream-5-0","prompt":"海边灯塔水彩封面","size":"2K","n":1,"watermark":false}'
```

Seedream 图生图（勿打 `/edits`）：

```json
{
  "model": "doubao-seedream-5-0",
  "prompt": "把背景换成黄昏海边",
  "size": "2K",
  "image": "https://example.com/ref.png"
}
```

## 计费（双模式）

`models.pricing_profile` 用显式 **`image_billing_mode`** 区分（禁止混配）：

| 模式 | 适用 | 扣费权威 | `pricing_audit.kind` |
|------|------|----------|----------------------|
| **`token`** | gpt-image-2、Gemini Nano Banana | 上游 `usage` 分项 × tier `image_*` / text 单价 | `image_tokens` |
| **`per_image`** | Seedream / GLM / Grok / 阿里云百炼 | 确认输出张数 × `image.default`（+ 可选参考图 `image.input`）；**无需 / 不计价 `tiers`** | `image_per_image` |

再乘路由 `charged_factor` / `metered_factor`。Request log 另有结构化列 `billing_kind`、`input_image_count`、`output_image_count`。

### token 模式

```text
charged ≈
  text_input × input_price
+ cached_text × cache_read_price
+ image_input × image_input_price
+ cached_image_input × image_input_cache_price
+ image_output × image_output_price
（单价均为「每百万 token」；再 × charged_factor）
```

| 规则 | 行为 |
|------|------|
| 成功出图 | 按响应 `usage` 真实分项扣费 |
| 客户端取消 / Gateway 超时（已发出） | 未达到 SSE 成功结算点时零费用；已验证有效 completed + 上游 DONE 后，后续取消/超时不撤销费用（2026-09-08 已修复并部署独立 staging，未生产上线） |
| 明确上游错误 / 网络 502 / 空结果 | 零费用 |
| 无 mode 且无正 `image_*` | **不计费** |

### per_image 模式

```text
charged ≈
  output_unit × confirmed_output_count
+ input_unit × reference_count
（再 × charged_factor）
```

| 规则 | 行为 |
|------|------|
| 成功出图 | 按有效返回图片数 + 请求参考图数结算；**忽略** usage tokens |
| 客户端取消 / Gateway 超时 / 结果不明（已发出） | 未达到 SSE 成功结算点时沿用原规则；已验证有效 completed + 上游 DONE 后，后续取消/超时不撤销费用。持久化未确认不等于零费用，不得自动重试 |
| 明确失败且未发出 / 空结果 | 零费用 |
| 无显式 `image_billing_mode: per_image` 的 legacy `image` 块 | **不计费**（避免旧数据突然扣款） |

已部署库可用：`node scripts/db/migrate-image-billing-modes.mjs --dry-run`（再 `--apply`）。

### 预设单价（摘要）

**`gpt-image-2`**（`token`；USD / 1M；CNY = ×7）：

| 分项 | USD | CNY |
|------|-----|-----|
| text `input_price` | 5 | 35 |
| cached text `cache_read_price` | 1.25 | 8.75 |
| `image_input_price` | 8 | 56 |
| `image_input_cache_price` | 2 | 14 |
| `image_output_price` | 30 | 210 |

**按张类**（`per_image`；`image.default` 为权威单价 / 张；官方来源见备注）：

| Catalog id | CNY / 张 | USD / 张 | 备注 |
|------------|----------|----------|------|
| `doubao-seedream-5-0` | **0.22** | **0.035** | 火山方舟一口价；BytePlus $0.035；**不按 4K 翻倍** |
| `doubao-seedream-5-0-pro` | **0.30**（≤2.36MP）/ **0.60**（>2.36MP） | **0.045** / **0.09** | `by_size`：`2k`→低档，`3k`/`4k`→高档；`image.input` CNY **0.02** / USD **0.003**（官方首张免费网关暂按全量计） |
| `glm-image` | **0.1** | **0.014** | 智谱官方 ¥0.1/次；USD ≈ ×7.14（国内权威 CNY） |
| `qwen-image-3.0-pro` | **0.25**（1K）/ **0.50**（2K） | **0.036** / **0.071** | 百炼华北2 原价；`image.input` CNY **0.02** / USD **0.003**；USD = CNY ÷ 7 |
| `qwen-image-3.0` | **0.18** | **0.026** | 1K/2K 同价；`image.input` 同上 |
| `wan2.7-image-pro` | **0.50** | **0.071** | 一口价（含 4K 文生图）；官方输入不计费 |
| `wan2.7-image` | **0.20** | **0.029** | 一口价，最高 2K；官方输入不计费 |
| `grok-imagine-image-2.0` | **0.28** | **0.04** | xAI 官方一口价；CNY = USD ×7；价目页未单列参考图单价 |
| `grok-imagine-image-quality` | **0.35**（1K）/ **0.49**（2K） | **0.05** / **0.07** | xAI 官方；CNY = USD ×7；`image.input.default` USD **0.01**（CNY **0.07**） |

**Google Nano Banana**（`token`；官方 $/1M；CNY = ×7）：

| Catalog id | text/image `input_price` | text `output_price` | `image_output_price` | input CNY | text-out CNY | img-out CNY |
|------------|--------------------------|---------------------|----------------------|-----------|--------------|-------------|
| `gemini-3.1-flash-image` | 0.5 | **3** | **60** | 3.5 | **21** | **420** |
| `gemini-3-pro-image-preview` | 2 | **12** | **120** | 14 | **84** | **840** |

## 预检与估算

| 模式 | 预检 | 最终扣费 |
|------|------|----------|
| **token** | quality×size **估算** output tokens（偏保守）× 单价 × 最高 `charged_factor` | 成功响应 **usage** |
| **per_image** | `unit × 请求输出张数 + input_unit × 参考图数` × 最高 factor | 成功响应 **有效图片数** |

Admin Routes / Models 只展示目录权威价：token 模式为 `/1M` 分项；per_image 为 `/image` 单价。不再展示 quality×size 估算矩阵。

## Route 配置清单

1. `model_id` = 上表 catalog id  
2. `upstream_protocol` = `openai`  
3. `provider_model_name` = 与 catalog 同名（或火山 `ep-…`）  
4. Provider 指向正确 Key + Images generations（及 OpenAI 时的 edits）  
5. 可选 `custom_params`：如默认 `watermark: false`（用户显式传覆盖）  
6. `charged_factor` / `metered_factor` 按业务加价  

## 运营验收（最短路径）

Admin 闭环：**Routes → Playground → Simulator → Request Logs**（无独立 Images 管理页）。

1. Import Provider + Image 模型预设  
2. 建 openai 路由；Billing：token 模型显示 `/M`，per_image 显示 `/image`  
3. Playground 出图（不计费）  
4. Simulator / curl 打 Proxy，核对：
   - GPT：`pricing_audit.kind=image_tokens`，`charged_cost` 随 usage 分项变化  
   - Seedream：`pricing_audit.kind=image_per_image`，`output_image_count=1`，`charged_cost≈官方单价×charged_factor`  
5. Seedream 勿用 multipart `/edits` 做图生图  

逐步细节：[gpt-image-2 验收](../api/admin.md#运维验收文生图模型-gpt-image-2) · [Seedream 验收](../api/admin.md#运维验收国内文生图-seedream-火山方舟)。

## 相关代码与文档

| 主题 | 路径 |
|------|------|
| Images 用户 API | [api/user.md · Images](../api/user.md#images图片生成--编辑) |
| 运维验收 / 模型价目说明 | [api/admin.md](../api/admin.md) |
| Provider Import 预设说明 | [provider-import-presets.md](./provider-import-presets.md) |
| 流式计费与取消（Chat；Image 取消预检语义并列） | [streaming-billing.md](./streaming-billing.md) |
| Image extras 透传 | `packages/proxy/src/services/image-generation-extras.ts` |
| Token 预检 / Seedream 常量 | `packages/core/src/db/image-token-usage.ts` |
| OpenAI Images 驱动 | `packages/proxy/src/services/egress/openai-images-driver.ts` |
