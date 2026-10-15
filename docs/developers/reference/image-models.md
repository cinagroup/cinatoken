# 文生图模型（Image Models）

本文是网关生图能力的总入口：客户端入口与路由、目录模型与单价、计费与预检、验收与维护流程。各厂商的端点、参数规则和官方来源写在厂商文档里：

| 厂商文档 | 覆盖型号 |
| -------- | -------- |
| [OpenAI 兼容生图透传](../architecture/openai-compatible-image.md) | OpenAI GPT Image、智谱 GLM Image、xAI Grok Imagine |
| [Gemini 原生生图](../architecture/gemini-image.md) | Gemini Nano Banana / Flash Image / Pro Image |
| [火山方舟 Seedream 生图](../architecture/volcengine-image.md) | Seedream 5.0 lite / pro / flash |
| [DashScope 原生生图](../architecture/dashscope-image.md) | 千问图像、万相 |
| [MiniMax 生图](../architecture/minimax-image.md) | `image-01`、`image-01-live` |

字段细节见 [用户接口 · Images](../api/user.md#images图片生成--编辑)。

## 入口与路由

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
文生图不走 `/v1/chat/completions`。OpenAI Images 是默认入口，各厂商另有原生透传入口：

| 客户端路径 | 请求协议 / 能力 | 上游协议 / 能力 | 适配器 | 厂商文档 |
| ---------- | --------------- | --------------- | ------ | -------- |
| `POST /v1/images/generations` | `openai` / `images.generations` | `openai` / `images.generations` | `passthrough` | [OpenAI 兼容](../architecture/openai-compatible-image.md) |
| 同上 | 同上 | `volcengine` / `images.generations` | `volcengine-image` | [火山方舟](../architecture/volcengine-image.md) |
| 同上 | 同上 | `dashscope` / `images.generations.multimodal` | `dashscope-image-qwen`、`dashscope-image-wan` | [DashScope](../architecture/dashscope-image.md) |
| 同上 | 同上 | `minimax` / `images.generations` | `minimax-image` | [MiniMax](../architecture/minimax-image.md) |
| 同上 | 同上 | `gemini` / `models.generate` | `gemini-image` | [Gemini](../architecture/gemini-image.md#openai-入口gemini-image) |
| `POST /v1/images/edits`（multipart） | `openai` / `images.edits` | `openai` / `images.edits` | `passthrough` | 只有 OpenAI GPT Image 可用 |
| `POST /v1/volcengine/images/generations` | `volcengine` / `images.generations` | 同左 | `passthrough` | [火山方舟](../architecture/volcengine-image.md) |
| `POST /v1/dashscope/services/aigc/multimodal-generation/generation` | `dashscope` / `images.generations.multimodal` | 同左 | `passthrough` | [DashScope](../architecture/dashscope-image.md) |
| `POST /v1/minimax/image_generation` | `minimax` / `images.generations` | 同左 | `passthrough` | [MiniMax](../architecture/minimax-image.md) |
| `POST /v1beta/models/{model}:generateContent`（及 `streamGenerateContent`） | `gemini` / `models.generate` | 同左 | `passthrough` | [Gemini](../architecture/gemini-image.md) |

失败转移复用 `failoverDispatch`。混合协议的路由池会把同一份请求交给每条路由的适配器各自转换。

模型的种类按输出模态判定：`output_modalities` 含 `image` 即为生图模型，不能看输入模态（多模态 LLM 也接受图片）。默认的 `/v1/models` 不含纯生图模型，需要 `kind=image` 或 `kind=all`。

### OpenAI 入口的参数速查

下表只列网关自己的处理。各型号的官方取值范围以厂商文档为准。

| 路由 | 尺寸字段 | `n` | 参考图 |
| ---- | -------- | --- | ------ |
| OpenAI 兼容透传 | 顶层字段原样转发，不校验、不改名 | 只能为 1 | GPT Image 走 `/v1/images/edits`；其它厂商经网关只能文生图 |
| `volcengine-image` | `size` 原样转发，包括 `auto` | 1 为单图，2–15 映射成组图；5.0 pro / flash 只能为 1 | generations 的 JSON `image` |
| `dashscope-image-qwen` | 顶层 `size` 原样写入 `parameters.size`。千问用 `宽*高` 或 `auto` | 1–6 | generations 的 JSON `image` |
| `dashscope-image-wan` | 同上。万相用 `1K` / `2K` / `4K` 或 `宽*高` | 1–4 | generations 的 JSON `image` |
| `minimax-image` | 不转发 `size`。`aspect_ratio`、`width`、`height` 有值才原样转发，不填默认比例 | 1–9 | 走原生透传的 `subject_reference` |
| `gemini-image` | `宽x高` 换算成最接近的 `imageConfig.aspectRatio`，长边决定 `1K` / `2K` / `4K`；也可只传 `512` / `1K` / `2K` / `4K` 或 `auto` | 只能为 1 | generations 的 JSON `image`（data URL） |

## 模型目录

静态预设放在 `packages/admin/lib/model-presets/`，生图模型一般在 `<vendor>-image.json`（MiniMax 在 `minimax.json`）。在管理后台的模型（Models）页导入预设；同 ID 已存在时不会覆盖，改价需要编辑模型，或对已知型号运行 `node scripts/db/migrate-image-billing-modes.mjs --apply`。

目录 ID 一般与上游的供应商模型名一致。例外是 MiniMax：目录 ID 带 `minimax-` 前缀，路由的供应商模型名填 `image-01` / `image-01-live`。火山方舟用推理接入点时，路由填 `ep-…`。预设不写 `suggested_provider_model_name` 或 `suggested_custom_params`，默认参数由客户端或路由 `custom_params` 注入。退役型号不进预设，库里的旧行需要手工清理。

下面三张表由 `npm run docs:image-models` 从预设生成，请勿手改。CNY 一般按 USD × 7 换算，以预设为准。

<!-- BEGIN GENERATED: image-models (npm run docs:image-models) -->

### 目录总览

| 模型 ID | 展示名 | 厂商文档 | 计费模式 | CNY | USD | 分档 | 预设文件 |
|---|---|---|---|---|---|---|---|
| `qwen-image-2.1-pro` | Qwen Image 2.1 Pro | [百炼 DashScope](../architecture/dashscope-image.md) | `per_image` | ¥0.25/张 | $0.04/张 | 一口价 | `aliyun-image.json` |
| `qwen-image-3.0` | Qwen Image 3.0 | [百炼 DashScope](../architecture/dashscope-image.md) | `per_image` | ¥0.18/张 | $0.03/张 | 参考图 | `aliyun-image.json` |
| `qwen-image-3.0-pro` | Qwen Image 3.0 Pro | [百炼 DashScope](../architecture/dashscope-image.md) | `per_image` | ¥0.25/张 | $0.04/张 | `by_size`、参考图 | `aliyun-image.json` |
| `wan2.7-image` | Wan 2.7 Image | [百炼 DashScope](../architecture/dashscope-image.md) | `per_image` | ¥0.2/张 | $0.03/张 | 一口价 | `aliyun-image.json` |
| `wan2.7-image-pro` | Wan 2.7 Image Pro | [百炼 DashScope](../architecture/dashscope-image.md) | `per_image` | ¥0.5/张 | $0.075/张 | 一口价 | `aliyun-image.json` |
| `doubao-seedream-5-0` | Doubao Seedream 5.0 | [火山方舟 Seedream](../architecture/volcengine-image.md) | `per_image` | ¥0.22/张 | $0.035/张 | 一口价 | `bytedance-image.json` |
| `doubao-seedream-5-0-flash` | Doubao Seedream 5.0 Flash | [火山方舟 Seedream](../architecture/volcengine-image.md) | `per_image` | ¥0.12/张 | $0.018/张 | 一口价 | `bytedance-image.json` |
| `doubao-seedream-5-0-pro` | Doubao Seedream 5.0 Pro | [火山方舟 Seedream](../architecture/volcengine-image.md) | `per_image` | ¥0.6/张 | $0.09/张 | `by_size`、参考图 | `bytedance-image.json` |
| `gemini-3-pro-image-preview` | Gemini 3 Pro Image Preview | [Google Gemini](../architecture/gemini-image.md) | `token` | 图出 ¥840/1M | 图出 $120/1M | 按 usage | `google-image.json` |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | [Google Gemini](../architecture/gemini-image.md) | `token` | 图出 ¥420/1M | 图出 $60/1M | 按 usage | `google-image.json` |
| `gemini-nano-banana-2.1` | Gemini Nano Banana 2.1 | [Google Gemini](../architecture/gemini-image.md) | `token` | 图出 ¥210/1M | 图出 $30/1M | 按 usage | `google-image.json` |
| `minimax-image-01` | MiniMax Image 01 | [MiniMax](../architecture/minimax-image.md) | `per_image` | ¥0.025/张 | $0.0035/张 | 一口价 | `minimax.json` |
| `minimax-image-01-live` | MiniMax Image 01 Live | [MiniMax](../architecture/minimax-image.md) | `per_image` | ¥0.025/张 | $0.0035/张 | 一口价 | `minimax.json` |
| `gpt-image-2` | GPT Image 2 | [OpenAI GPT Image](../architecture/openai-compatible-image.md#openai-gpt-image) | `token` | 图出 ¥210/1M | 图出 $30/1M | 按 usage | `openai-image.json` |
| `gpt-image-2.5-flare` | GPT Image 2.5 Flare | [OpenAI GPT Image](../architecture/openai-compatible-image.md#openai-gpt-image) | `token` | 图出 ¥210/1M | 图出 $30/1M | 按 usage | `openai-image.json` |
| `gpt-image-2.5-sunburst` | GPT Image 2.5 Sunburst | [OpenAI GPT Image](../architecture/openai-compatible-image.md#openai-gpt-image) | `token` | 图出 ¥210/1M | 图出 $30/1M | 按 usage | `openai-image.json` |
| `grok-imagine-image-2.0` | Grok Imagine Image 2.0 | [xAI Grok Imagine](../architecture/openai-compatible-image.md#xai-grok-imagine) | `per_image` | ¥0.28/张 | $0.04/张 | `by_quality_size`、`by_quality`、`by_size`、参考图 | `xai-image.json` |
| `grok-imagine-image-quality` | Grok Imagine Image Quality | [xAI Grok Imagine](../architecture/openai-compatible-image.md#xai-grok-imagine) | `per_image` | ¥0.35/张 | $0.05/张 | `by_size`、参考图 | `xai-image.json` |
| `glm-image` | GLM Image | [智谱 GLM Image](../architecture/openai-compatible-image.md#智谱-glm-image) | `per_image` | ¥0.1/张 | $0.014/张 | 一口价 | `zhipu-image.json` |

### 按张分档

查价顺序是 `by_quality_size`（键为 `quality:size`）→ `by_quality` → `by_size` → `default`。没有列出的模型按目录总览里的一口价计费。

| 模型 ID | 档位 | CNY / 张 | USD / 张 |
|---|---|---|---|
| `qwen-image-3.0` | 参考图 `input.default` | ¥0.02 | $0.003 |
| `qwen-image-3.0-pro` | `by_size` · `1k` | ¥0.25 | $0.04 |
| `qwen-image-3.0-pro` | `by_size` · `2k` | ¥0.5 | $0.075 |
| `qwen-image-3.0-pro` | 参考图 `input.default` | ¥0.02 | $0.003 |
| `doubao-seedream-5-0-pro` | `by_size` · `1k` | ¥0.3 | $0.045 |
| `doubao-seedream-5-0-pro` | `by_size` · `1.5k` | ¥0.3 | $0.045 |
| `doubao-seedream-5-0-pro` | `by_size` · `2k` | ¥0.6 | $0.09 |
| `doubao-seedream-5-0-pro` | 参考图 `input.default` | ¥0.02 | $0.003 |
| `grok-imagine-image-2.0` | `by_quality_size` · `low:1k` | ¥0.28 | $0.04 |
| `grok-imagine-image-2.0` | `by_quality_size` · `low:1.5k` | ¥0.35 | $0.05 |
| `grok-imagine-image-2.0` | `by_quality_size` · `low:2k` | ¥0.42 | $0.06 |
| `grok-imagine-image-2.0` | `by_quality_size` · `medium:1k` | ¥0.42 | $0.06 |
| `grok-imagine-image-2.0` | `by_quality_size` · `medium:1.5k` | ¥0.49 | $0.07 |
| `grok-imagine-image-2.0` | `by_quality_size` · `medium:2k` | ¥0.56 | $0.08 |
| `grok-imagine-image-2.0` | `by_quality` · `low` | ¥0.28 | $0.04 |
| `grok-imagine-image-2.0` | `by_quality` · `medium` | ¥0.42 | $0.06 |
| `grok-imagine-image-2.0` | `by_size` · `1k` | ¥0.28 | $0.04 |
| `grok-imagine-image-2.0` | `by_size` · `1.5k` | ¥0.35 | $0.05 |
| `grok-imagine-image-2.0` | `by_size` · `2k` | ¥0.42 | $0.06 |
| `grok-imagine-image-2.0` | 参考图 `input.default` | ¥0.07 | $0.01 |
| `grok-imagine-image-quality` | `by_size` · `1k` | ¥0.35 | $0.05 |
| `grok-imagine-image-quality` | `by_size` · `2k` | ¥0.49 | $0.07 |
| `grok-imagine-image-quality` | 参考图 `input.default` | ¥0.07 | $0.01 |

### Token 单价

单位是每百万 token。`—` 表示该币种没有预设，导入后需要手工补价。

| 模型 ID | 币种 | 文本输入 | 文本缓存 | 文本输出 | 图片输入 | 图片输入缓存 | 图片输出 |
|---|---|---|---|---|---|---|---|
| `gemini-3-pro-image-preview` | CNY | ¥14 | — | ¥84 | ¥14 | — | ¥840 |
| `gemini-3-pro-image-preview` | USD | $2 | — | $12 | $2 | — | $120 |
| `gemini-3.1-flash-image` | CNY | ¥3.5 | — | ¥21 | ¥3.5 | — | ¥420 |
| `gemini-3.1-flash-image` | USD | $0.5 | — | $3 | $0.5 | — | $60 |
| `gemini-nano-banana-2.1` | CNY | ¥10.5 | — | ¥52.5 | ¥10.5 | — | ¥210 |
| `gemini-nano-banana-2.1` | USD | $1.5 | — | $7.5 | $1.5 | — | $30 |
| `gpt-image-2` | CNY | ¥35 | ¥8.75 | ¥0 | ¥56 | ¥14 | ¥210 |
| `gpt-image-2` | USD | $5 | $1.25 | $0 | $8 | $2 | $30 |
| `gpt-image-2.5-flare` | CNY | ¥35 | ¥8.75 | ¥0 | ¥56 | ¥14 | ¥210 |
| `gpt-image-2.5-flare` | USD | $5 | $1.25 | $0 | $8 | $2 | $30 |
| `gpt-image-2.5-sunburst` | CNY | ¥35 | ¥8.75 | ¥0 | ¥56 | ¥14 | ¥210 |
| `gpt-image-2.5-sunburst` | USD | $5 | $1.25 | $0 | $8 | $2 | $30 |

<!-- END GENERATED: image-models -->

## 计费

`models.pricing_profile.image_billing_mode` 决定计费方式，两种模式不能混用。金额最后再乘路由的 `charged_factor` / `metered_factor`。请求日志另有结构化列 `billing_kind`、`input_image_count`、`output_image_count`。

| 模式 | 扣费依据 | `pricing_audit.kind` |
| ---- | -------- | -------------------- |
| `token` | 上游 `usage` 分项 × tier 的 `image_*` 与文本单价 | `image_tokens` |
| `per_image` | 确认输出张数 × 出图单价，加参考图张数 × `image.input` 单价；不需要 `tiers` | `image_per_image` |

### token 模式

```text
charged ≈
  text_input × input_price
+ cached_text × cache_read_price
+ image_input × image_input_price
+ cached_image_input × image_input_cache_price
+ image_output × image_output_price
（单价均为每百万 token；再 × charged_factor）
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
单价按 `by_quality_size`（键为 `quality:size`）→ `by_quality` → `by_size` → `default` 的顺序查找，键不区分大小写。查价用的 `quality` 与 `size` 来源：

- `quality` 取请求值，缺省为 `auto`。
- `size` 取请求的 `size`；没有时取扩展字段 `resolution`（xAI 用它选 1k / 2k）；都没有时为 `auto`。
- 火山方舟两条入口把 `宽x高` 按像素换算成档位；千问 3.0 Pro 从响应 `usage.output_image_type` 反推 `1k` / `2k`。换算结果会覆盖请求里的 `size`。

### 零费用规则

| 情况 | 行为 |
| ---- | ---- |
| 成功出图 | token 按响应 `usage` 分项；per_image 按有效图片数与参考图数，忽略 usage |
| 客户端取消、网关超时（合成 504，请求已发出）、结果不明 | 零费用，与 `uncertain_result_policy` 无关 |
| 明确的上游错误、网络 502、空结果 | 零费用 |
| 没有 `image_billing_mode`，且 tier 里没有正的 `image_*` | 不计费 |
| 只有旧的 `image` 块、没有显式 `per_image` | 不计费，避免旧数据突然扣款 |

### 预检

| 模式 | 预检 | 最终扣费 |
| ---- | ---- | -------- |
| `token` | 按 `quality` × `size` 估算输出 token（偏保守）× 单价 × 最高 `charged_factor`。路由池全是 `gemini-image` 时改按 Gemini 的 `imageSize` 估算，见 [Gemini](../architecture/gemini-image.md#计费) | 成功响应的 `usage` |
| `per_image` | 出图单价 × 请求张数 + 参考图单价 × 参考图数，再 × 最高 factor | 成功响应的有效图片数 |

预检只拦额度，不落成实扣。管理后台的路由与模型页只展示目录价：token 模式显示 `/1M` 分项，per_image 显示 `/image` 单价。

## 路由配置清单

1. 模型 ID 选目录里的生图模型。
2. 按上方“入口与路由”表选请求协议、上游协议与适配器。
3. 供应商模型名一般与目录 ID 相同；MiniMax 去掉 `minimax-` 前缀，火山方舟可填 `ep-…`。
4. 供应商配好 Key 与对应协议的端点，见各厂商文档。
5. 可选 `custom_params`，如默认 `watermark: false`；用户显式传入的值优先。
6. 按业务设置 `charged_factor` / `metered_factor`。

## 运营验收

管理后台没有独立的生图页，闭环是路由（Routes）→ 调试台（Playground）→ 模拟器（Simulator）→ 请求日志（Request Logs）。

1. 导入供应商与生图模型预设。
2. 建路由。路由页的计费栏应显示 `/1M`（token）或 `/image`（per_image）。
3. 在调试台出图。调试台直连上游，不计费、不写请求日志。
4. 用模拟器或 curl 打代理服务，在请求日志核对：
   - token 模型：`pricing_audit.kind=image_tokens`，`charged_cost` 随 usage 分项变化。
   - per_image 模型：`pricing_audit.kind=image_per_image`，`output_image_count` 与实际张数一致，`output_unit_price` 与目录档位一致。
5. 各厂商的特有检查见厂商文档的“验收”一节。

逐步细节见 [Admin API · gpt-image-2 验收](../api/admin.md#运维验收文生图模型-gpt-image-2) 与 [Seedream 验收](../api/admin.md#运维验收国内文生图-seedream-火山方舟)。

## 新增或更新模型

1. 在 `packages/admin/lib/model-presets/` 改价或加型号，`modalities.output` 写 `image`，两种币种都写 `image_billing_mode`。
2. 运行 `npm run docs:image-models` 重新生成本文的目录表。`npm run test:docs` 会在预设与文档不一致时失败。
3. 新厂商要先写厂商文档，并在 `scripts/docs/gen-image-models.mjs` 的 `VENDOR_DOCS` 登记，否则生成脚本会报错。
4. 在厂商文档里更新参数规则，以及“官方来源”的核对日期。
5. 已部署实例的模型不会自动更新。改价时在 `scripts/db/migrate-image-billing-modes.mjs` 同步单价，并在 `CHANGELOG.md` 的 Unreleased 说明需要手工改价或运行迁移脚本。

## 相关代码与文档

| 主题 | 路径 |
| ---- | ---- |
| Images 用户接口 | [api/user.md · Images](../api/user.md#images图片生成--编辑) |
| 运维验收 | [api/admin.md](../api/admin.md) |
| 供应商导入预设 | [provider-import-presets.md](./provider-import-presets.md) |
| 流式计费与取消（Chat；生图的取消语义并列） | [streaming-billing.md](./streaming-billing.md) |
| OpenAI 入口与扩展字段 | `packages/proxy/src/routes/v1/images.ts`、`packages/proxy/src/services/image-generation-extras.ts` |
| Gemini OpenAI 入口转换 | `packages/core/src/gemini-image-openai.ts`、`packages/proxy/src/services/egress/gemini-openai-image-driver.ts` |
| 按张查价与计费 | `packages/core/src/db/pricing-profile.ts`、`packages/proxy/src/services/image-usage-charge.ts` |
| token 预检估算 | `packages/core/src/db/image-token-usage.ts` |
| 目录表生成 | `scripts/docs/gen-image-models.mjs` |
