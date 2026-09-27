# C02.B2.2 — 公开 Images 控制字段容量合同

日期：2026-09-06。状态：**控制字段入口子集 LOCAL_PASS；C02 DOING，整个实例容量未通过**。执行与自检：Codex；独立 Reviewer 待指定。接续 [JSON 工作集证据](./C02-image-json-working-set.md)，保留全部历史结果。

## 1. 用户决定与兼容变化

用户明确同意“允许制定并公开合理上限”。据此为四个公开 JSON 生成入口 `/v1/images`、`/v1/images/generations` 及各自 `/api/v1` 别名建立平台自己的容量合同；不是宣称 OpenRouter 的字段上限。

| 根字段 | 上限 | 依据与口径 |
| --- | ---: | --- |
| model | 256 字符 | 模型标识及常见路由后缀预留；不是任意文本 |
| n 的字符串形式 | 32 字符 | 保留原有 Number 转换及 1–10 校验，有界地容纳填充、指数等旧输入 |
| size、quality、background、service_tier | 各 64 字符 | 尺寸或模式控制，限制进入路由、Guardrail 投影和定价审计的文本 |
| provider 整个最终值 | 16,384 JSON 字节 | 保留常用有界选择列表与路由选项；未知嵌套值和属性名也计入 |

“字符”指 JSON 解码后的 UTF-16 单元，**去首尾空白之前**计算；一个常用 emoji 占两个单元，`\u0041` 占一个。provider 按最终解析值的紧凑 JSON UTF-8 大小计算，包含引号、转义、分隔符和所有存活属性名/值，不计算原始格式空白；计数不构造完整 JSON 字符串或编码副本。这些是明确收紧，过去尝试接受的超长标识/参数/填充或大 provider 现在会拒绝。字段类型、枚举、n 数值范围仍另行验证，处于长度上限内不代表业务有效。

超限返回 **400 / gateway.invalid_request**，错误只含固定字段名、上限及单位，例如 `size must be at most 64 characters`，不回显输入值。认证仍先于语义字段准入；完整 EOF/语法/50 MiB 字节/64 层与 65,536 节点准入先于新限制，新限制先于其他业务参数校验、Guardrails、模型规划、预算预留及 dispatch。请求字节或结构超限仍是 413；取消/绝对时限优先沿用 499/504。

重复属性仍最后值生效；以解码后的真实名字去重，因此转义等价名字不能绕过。被覆盖内容仍须通过完整语法、字节和节点预算，但不必重新构造其子树或合并大字符串。最后值合法则可以接受，最后值超限则拒绝；不在尚未收到尾部时假定当前值就是最终值。

仅修改 Images **JSON 生成入口**。prompt 继续沿用去空白后最多 4,000 字符；50 MiB 总请求、20 MiB 单文件、32 MiB 普通上游读取保持不变。图片/透传数据没有被套用这组小字段上限；multipart edits、管理端、其他模态和管理员路由默认值不自动继承，不能假称已经全平台生效。没有改动定价或退款政策。

## 2. 实现

- [image-control-limits.ts](../../../../packages/proxy/src/services/image-control-limits.ts)：集中定义限额、可识别错误与显式原生消费边界。先检查全部已选控制，再还原允许的标量/有界 provider 子树。
- [image-json-request.ts](../../../../packages/proxy/src/services/image-json-request.ts)：所有长值先保持片段，完整解析后再执行限额检查；错误类型的六个标量控制不会为其内部字符串执行整值合并，继续交既有业务校验拒绝。
- [text-request-lifecycle.ts](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)：新错误映射到明确的 400、安全错误体与 no-store，保留原有取消和资源错误分类。
- [segmented-json-response.ts](../../../../packages/proxy/src/services/egress/segmented-json-response.ts)：先按实际名字解析重复键，再只还原最终孩子。Map 保留第一次插入顺序及最后值，defineProperty 保留特殊属性和整数属性的原生顺序。不改变通用解析器默认原生值合同。

Cloudflare Workers 最佳实践技能推动了“先限制，再合并原生字符串”以及请求所有权、完整 EOF 的检查；参考 [Cloudflare 官方指南](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新 types registry 获取失败，使用本机 Workers types 5.20260829.1 和 Wrangler schema 复核；未安装依赖或修改兼容日期、flags、bindings。

## 3. 验证

新增 **102 项测试**：入口 46 项、通用解析器 2 项、公开路由 54 项；另调整原有 15 个字段表示测试中六个错误类型字段的预期，保留精确 JSON 值/发送字节断言。

覆盖每一标量的精确上限与加一、ASCII/Unicode/转义/空白；provider 的字符串/数组/对象、键名、Unicode/转义后的精确字节；未知嵌套值、错误类型、重复/转义等价属性、整数键及 __proto__/constructor/toJSON；超长内容不发生 materialize；四个公开生成入口的错误体/错误码、无 policy/预算/dispatch、合法边界的明确拒绝后完整重试；完整 50 MiB 的 size/provider、错误对象、被覆盖的控制字段；等待尾部、晚到错误/超限、取消和超时。

| 检查 | 最终结果 |
| --- | --- |
| 解析器 / 入口 / 字段表示联合 | 153 项，全通过，退出 0 |
| 新增公开路由专项 | 54 项，全通过，退出 0 |
| npm test -w @octafuse/proxy | 完整 pretest 链；主 suite 2,821 tests / 135 suites，退出 0 |
| test:dispatch-safety | 2,446 tests / 50 suites，退出 0 |
| Proxy / dispatch-safety / Admin 类型检查 | 三项均退出 0 |
| 控制字段内存脚本 | 17 个独立子进程，全部通过，退出 0 |

测试集有重叠，不相加。最终无失败、取消或跳过；未声称测试先在旧实现失败。公开路由使用合成模型、Guardrail 配置及受限 SQL sink，不访问业务库、不证明实际供应商或资金账本。

## 4. 内存证据及剩余风险

[原始结果](./C02-image-control-limits-memory.json)由更新后的 [测量脚本](../../../../packages/proxy/scripts/measure-image-control-ingress.mjs)生成。native-controls 是**当前解析器强制旧 15 字段原生还原的对照**，不是旧 checkout；deferred-controls 是当前实际入口和生成校验。旧记录仍是历史 18 组；当前超大 size 必须拒绝，故其两个发送/取消案例变成一个拒绝案例，总数 17。没有把它作为合法请求继续发送以凑齐旧测量。

| 完整 50 MiB 输入 | 离散观察 heapUsed 基线增量 | 解析/拒绝后 GC 增量 | 最大整值还原 |
| --- | ---: | ---: | ---: |
| 原生对照 size | 154.47 MiB | 102.27 MiB | 52,428,747 字符 |
| 当前 size 拒绝 | 65.42 MiB | 2.28 MiB | 0 |
| 当前填充 prompt | 约 65.4 MiB | 52.54 MiB | 10 字符 |
| 当前替换解码 prompt 拒绝 | 104.85 MiB | 102.52 MiB | 0 |

减少的是不必要的整值合并与持有，不是将解码变成零分配。当前 size 拒绝已完成全量读取、释放 ingress reader，没有创建上传；原生对照仍合法发送，因此后续生命周期不同，不能比较为同功能吞吐提升。测量是 Node v24.14.1 / Windows、独立子进程、离散观察和显式 GC；可能与其他本地验证进程重叠，不证明连续峰值、Workers 总容量或 CPU/延迟改善。

**整个实例内存仍未通过**：大控制字段仍在解析期间持有片段；长属性名在属性构造前仍需原生还原，JSON 数字仍有整值解析，raw_usage、SSE 事件、路由默认值、UTF-8 替换的固有工作集、在途请求/响应重叠与传输/存储持有期仍待治理。provider 限额不是对全部 JSON 属性名的词法上限，也不是服务级并发准入。输入保持 50 MiB，不能因此推断所有允许输入都能在 Workers 内存中安全共存。

## 5. 状态、快照与下一项

用户对字段上限的选择已落实，不再等待该问题。当前唯一下一项为 **C02.B2.2 — 解码/长键/长数字/raw_usage 工作集治理，接整个实例统一容量准入**；还须核对默认值等非客户端来源，不能让它们绕过后续统一容量设计。HTTP Audio/Admin 完整入口、分阶段时限、数据库确认恢复、Realtime marker/Guardrail 零更新、共享音频收益、Qwen 格式等门禁保持。

C00 LOCAL_PASS；C01/C02 DOING；C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。整体目标仍未完成，本轮分类 progress，未触发 blocked。GCP 项目 cinatoken 与 KMS API 状态沿用既有 C01 证据，没有重复云核验、创建密钥、IAM/云资源写入、真实 OAuth/模型、业务库、迁移、部署、支付、远程 CI 或安装。

轮初 HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`，236 个 dirty/untracked 文件，前轮 196 个快照哈希已核对。新 [快照](./C02-image-control-limits-snapshot.json)固定受测源码、脚本、当前公开文档及原始结果；本证据、Checklist 和索引不自引用。全部既有用户变更保留。若需要回退兼容收紧，应显式撤销新字段合同及映射/测试；不整体还原工作树，不移除已有字节/结构限制、生命周期或 unknown 禁止重放，不删除账务事实。

收尾复核：相对轮初 12 个既有文件变化、4 个新增文件，共 240 个 dirty/untracked 文件；无轮初文件缺失或其他内容变化。200 个快照哈希全部匹配，五份当前文档的 75 个本地链接目标存在，git diff --check 退出 0。全部测试、类型检查与测量进程已终止。Git 无权读取用户级 ignore 的警告不影响本次项目枚举，未修改用户配置。测量中 expectedBytes 是原始输出对照的预期计数，拒绝组 outputBytes 为 0，未创建上传或调用模型。
