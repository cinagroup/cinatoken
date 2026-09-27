# C02.B2.2 — Images 属性名与 usage 审计限额

日期：2026-09-06。用户明确批准“允许制定合理上限”。本地实现，未部署；C02 仍为 DOING，不等于整个实例容量或真实账务验收。接续 [解析恢复与持有期](./C02-json-key-restore.md)，其旧容量前后测量保留，不倒改历史。

## 1. 公开合同

| 项目 | 本次限制 | 检查位置 |
| --- | --- | --- |
| 每个 JSON 属性名 | 256 个解码后的 UTF-16 单元 | 生成请求 JSON、generations/edits 普通上游 JSON、单个 Images SSE 事件；任何层级/未知键/重复键/被覆盖子树都检查 |
| 每份实际生成的 raw_usage | 65,536 字节，即 64 KiB | 响应规范化、计量别名补充之后的完整紧凑 JSON UTF-8 表示；包括未知字段、嵌套结构和转义 |

这是本平台容量政策，不是 OpenRouter 或供应商限额的转述。属性名 256 为正常协议字段和扩展键留出空间，阻止单个数 MiB 原生名称；64 KiB 为计量明细和未知审计扩展留出空间，同时约束完整原生审计字符串。不是根据真实供应商全量样本推导出的兼容率承诺；上线前仍须 inventory/兼容检查。

UTF-16：常见 emoji 为两个单元，`\u0041` 为一个；不 trim 名称。usage 大小是最终审计表示，不是原始 usage 网络大小；源格式空白、被覆盖值不计入最终审计，但仍受原始字节/节点/语法预算。非对象 usage 仍按原有缺失/类型规则处理。

不降低原始请求 50 MiB、普通上游 32 MiB、单文件 20 MiB、prompt 去空白后 4,000 字符容量；已批准六类标量/provider 限额保留。新属性名预算不自动应用于 multipart 内嵌 provider JSON、默认参数、Admin 或其他模态。公开说明：[User API](../../api/user.md#json-属性名与上游-usage-审计上限)。

## 2. 实现与错误路径

- [JsonStructureBudget](../../../../packages/proxy/src/services/json-structure-budget.ts) 增加可选名称长度预算，以有界容器栈和转义状态计数，不保存名称内容。Images 使用单独的 `IMAGE_JSON_ADMISSION_LIMITS`；原 `IMAGE_JSON_STRUCTURE_LIMITS` 不变，通用解析器/历史低层测量仍可显式不启用名称上限。
- [生成入口](../../../../packages/proxy/src/services/image-json-request.ts) 在构造对象前执行该预算，超限为 413 `gateway.payload_too_large`，不等待巨大尾部、不进入 Guardrail/选路/发送/账务。
- [审计解析](../../../../packages/proxy/src/services/egress/image-response-usage.ts) 对最终别名展开对象先计算精确 JSON UTF-8 长度，再进行固定计量投影和完整审计串序列化；不静默截断，不删除未知字段后冒充完整审计。超过上限抛出 `ImageUsageLimitError`，包括带大审计内容的全零计量对象。
- [Images 驱动](../../../../packages/proxy/src/services/egress/openai-images-driver.ts) 在普通 2xx 后遇到新限额错误返回脱敏 502，保留上游请求 ID、`upstreamOutcomeUnknown` 和 `failoverForbidden`；已明确非 2xx 保持其 HTTP 状态/原重试判定。EOF 已到达的 usage 拒绝不额外伪造未读数据，提前名称拒绝取消 reader 且不等 cancel ACK。
- 普通 usage 恢复紧凑页存储：完整审计已被限制为 64 KiB，不再为整个潜在大 usage 保留“未紧凑化”例外。紧凑页解码、计数、序列化仍有分配/CPU 成本，不声称零拷贝。
- SSE 新名称/usage 容量拒绝通过一次 error / DONE 终止，取消上游、结算 `completed=false`，不把该 completed 图片发出，明确记录成本未知。[调度元数据](../../../../packages/proxy/src/services/failover-dispatch.ts) 和 [路由结算](../../../../packages/proxy/src/routes/v1/images.ts) 透传此事实：适用的普通预算保留未知成本，Guardrail 使用 reserved 模式，不以 `clientOutcomeBillable=false` 冒充已知非计费。原客户端取消/超时政策不改变；没有新增退款政策或真实扣款。

SSE 在本次修改前已为不可重放路径。此前普通协议错误的处理不在本次全面重设计范围；新成本未知标记仅用于新增两类容量拒绝。独立账务/共享收益/恢复和生产配置仍须按 checklist 验收。

## 3. 验证

新增 **61 项测试**：结构预算 22、入口解析 3、usage/驱动 22、完整公开路径 14；包含四个生成路径、generation/edit/SSE 上游、精确边界/多一个单位、UTF-8 非法字节替换、Unicode/转义、重复/被覆盖内容、规范化别名膨胀、零计量超限、reader/取消监听清理、禁止第二供应商与单个 error/DONE。

旧 provider 键容量测试改成多个合法长度键共同占用 16 KiB，而不是一个违反新名称上限的键；保留键本身计入 provider 字节上限的验证。旧用量兼容与取消样例调整到 64 KiB 内，保留特殊键、未知字段、分页/数值转换和终止行为。

首轮主 suite 2,989 / 安全专项 2,614 均发现 4 项旧 json-string-pages 成功样例依赖超大 usage/未压缩例外。按新公开合同调整这四项样例，未删除测试；新超限测试独立保留。中间定点复测另发现两个缩短后的数值样例不再触发分页，恢复到上限内的 10,000 字符填充后，157 项定点通过。较早四文件联合 613 项通过（尚未加入最后 5 项时）。

最终完整回归：`npm test -w @octafuse/proxy` 完整 pretest 链 + 主 suite **2,989 tests / 135 suites，退出 0**；`npm run test:dispatch-safety -w @octafuse/proxy` **2,614 tests / 50 suites，退出 0**；Proxy、dispatch-safety、Admin 三项类型检查均退出 0。最终无失败、取消或跳过；测试集有重叠，不相加。所有测试进程均已终止。

只使用合成上游/本地测试。公开路径 fixture 是受检查的 SQL sink，不是真实金融数据库；新 SSE 未知标记与路由映射已覆盖源码/驱动/路由检查，实际预留账本事务、提交丢失/恢复仍需独立门禁。新限额不是额外的真实运行时内存测量。

## 4. 剩余容量风险与唯一下一项

名称限制在解析前生效，但普通 usage 上限在完整解析后生效：上游仍可能先产生接近 32 MiB 的分段值树、规范化对象和长度扫描成本；SSE 仍整事件解析。每个合法短键的累计内存、默认参数、并发请求/上传/响应、网络缓冲与后台记账持有期仍须共同核算。响应结束不等于记账终态；字段上限不能代替整个实例准入。

该阶段完成时的下一项为 **C02.B2.2 — 统一容量准入合同与响应/后台记账所有权**；后续基础合同已接续至 [HTTP 容量/独立持有者证据](./C02-http-capacity-ownership.md)，默认未启用，完整运行时容量仍未验收。新上限授权已经解决，不再列为用户待答问题。C00 LOCAL_PASS，C01/C02 DOING，C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。

## 5. 基线与回退

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`。本限制子阶段起点 262 个 dirty/untracked 文件；前一子阶段 214 文件快照已留存。最终 [文件快照](./C02-image-audit-limits-snapshot.json) 单独记录，214 项哈希全部匹配；6 份当前/接续文档共 99 个本地链接目标存在（文件存在性检查，不是所有锚点渲染验收）。最终 264 个 dirty/untracked 文件，相对本子阶段起点 16 项修改、2 项新增、无起点文件缺失；包含前子阶段证据收尾。`git diff --check` 通过。旧测量不会被当成新受限合同的容量证明。

只回退本增量的名称/审计限制、SSE 新拒绝标记及配套测试/文档，保留用户其余脏工作树、已有控制字段限制、token 恢复改进与未知结果禁止重放合同。没有提交、部署、安装依赖、云写入、真实 KMS/OAuth/模型、业务库、迁移或支付操作。Google Cloud KMS 项目 `cinatoken` 沿用原证据。

使用 Cloudflare Workers 最佳实践技能核对流消费、审计原生边界与响应/后台独立持有链；参考 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新 types registry 本轮仍不可读，回退核对已安装 5.20260829.1 类型与本地 Wrangler schema；未改平台配置。
