# C02.B2.2 — 有界 JSON 字符串页紧凑存储

日期：2026-09-06。状态：**紧凑字符串页子集 LOCAL_PASS；C02 DOING，整个实例容量未通过**。执行 / 自检：Codex；独立 Reviewer 待指定。接续 [有界数字解析](./C02-json-numeric-scalars.md)，不覆盖历史记录。

## 1. 范围与实现

本轮推进长字符串的持有量，不新增公开字段、数字、Unicode 或图片容量限制。仍为完整 EOF、语法、50 MiB 入口 / 32 MiB 普通上游读取、既有结构和业务校验完成后才交付。用户批准的 Images 控制字段限额和 prompt 去空白后 4,000 字符合同不变。

- [compact-json-string-page.ts](../../../../packages/proxy/src/services/egress/compact-json-string-page.ts)：内部不可变页，私有字节不导入、不导出、不缓存解码结果。仅对至少 1,024 个 UTF-16 单元、非 Latin-1 且存储字节加 64 字节余量仍小于双字节文本的页面启用。无节省的 BMP/emoji 与短尾页沿用原生字符串。
- 编码是**私有内存表示，不是 UTF-8，也不是数据库、RPC 或接口格式**：使用 UTF-8 形状表示 Unicode，保留孤立代理单元，保留的 FF 字节表示 U+FFFD。这样任意顺序的 ASCII / 替换字符都可各用一个存储字节，不依赖重复次数压缩。跨页代理对由既有输出编码器衔接，公开 JSON 值与转义不变。
- [segmented-json-response.ts](../../../../packages/proxy/src/services/egress/segmented-json-response.ts)：已启用 paged 的字符串在每个 8 KiB 解码页完成时选择存储，而非 EOF 后才转换整值。新增结构上下文只选择存储，原生紧凑骨架解析仍是完整语法权威；深度 / 节点预算先于该上下文构造。
- 属性名以及已知完整原生消费子树不紧凑化，避免在最终整值还原时额外叠加一份紧凑字节。既有 `nativeStringFields` 自动获得此存储选择；新增内部 `uncompressedStringFields` 只选择存储、仍返回片段值。匹配解码后的根属性名，长属性名比较也不提前整值合并。
- [openai-images-driver.ts](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)：普通响应显式将根 `usage` 子树保持为原有解码页，因为现有账务接口仍需完整 `raw_usage`；图片和 metadata 才按需紧凑存储。未改变计量、结算、退款、重放和 SSE 合同。
- [json-string-pages.ts](../../../../packages/proxy/src/services/egress/json-string-pages.ts)：对消费者仍是不可变字符串片段。trim 只解码必要边界，复用中间存储页，避免通过展开 chunks 暂时还原完整大值。显式 `materialize()` 仍是完整分配边界，不声称其已消除。

Cloudflare Workers 最佳实践技能推动了“有界页面到达即转换、逐页消费、已知原生边界不额外叠加编码副本”的检查；参考 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新 types registry 读取失败，使用已安装 Workers types 5.20260829.1 和 Wrangler schema 核对；未安装依赖或修改兼容配置。

## 2. 验证范围

新增 **18 项测试**，位于 [json-string-pages.test.ts](../../../../packages/proxy/src/services/egress/json-string-pages.test.ts)：

- 全部 65,536 个 UTF-16 单元（含所有孤立代理与非字符），每个高代理与 8 个低位边界组合，128 组固定种子混合页。
- 8 KiB / 64 KiB 页面边界的代理对、空页、控制字符与转义；精确 UTF-8 输出长度及完整 JSON 与原生结果对照。
- 私有不可变存储、无字节导出、重复解码、显式序列化拒绝；无收益页保留原生表示。
- trim 不解码中间页，边界 / 全空白 / 分页组合保持原生 trim 值；EOF 前已完成页立即紧凑化，取消释放 reader。
- 根字段豁免、嵌套继承、相似字段不误匹配、转义属性名、长属性名、错误语法尾部；普通 generations / edits 驱动保留 raw_usage 与精确下游 JSON。

已完成：核心页面测试 55 项；`npm test -w @octafuse/proxy` 的完整 pretest 链与主 suite **2,870 项 / 135 suites**；`test:dispatch-safety` **2,495 项 / 50 suites**；Proxy / dispatch-safety / Admin 三项类型检查，均退出 0。最终无失败、取消或跳过，测试集重叠，不相加。早期 157 项联合测试亦通过，最终全量回归覆盖了后续存储选择调整。所有请求、模型和账务配置均为合成 fixture，不证明真实服务或支付。

## 3. 同脚本前后内存对照

[原始结果](./C02-json-page-storage-memory.json) / [测量脚本](../../../../packages/proxy/scripts/measure-json-page-storage.mjs)。修改业务源码前运行 12 个基线进程，最终源码再运行同一脚本的 12 个进程，均退出 0。脚本最初的 mixed 场景将尾空白置于 Ā 前，导致预期长度错两字节；在基线开始前修正该测试构造，此后前后脚本相同。

每组读取完整 50 MiB 原始 JSON（参考图两端有空白），经过实际入口读取、图片 extras 的 trim、出站长度预检与取消 / 完整 drain。对输出长度和 SHA-256 逐块核对，不调用 fetch。包含 ASCII、尾部混合字符、全部无效 FF 字节、交替 ASCII/无效字节、普通混合 Unicode、转义孤立代理六类。

度量同时记录 heapUsed / external / arrayBuffers / RSS。下表为各时刻 **heapUsed + external** 的基线增量；arrayBuffers 已包含于 external，不能再加一次。观察最大值按每次样本先求和后比较，**不相加不同时间的两项最大值**。GC 阶段的 external 统计可能延迟回收；没有在正常流处理循环中强制 GC。

| 场景 | 未读出站仍持有：前 → 后 | 离散观察最大增量：前 → 后 | 完整 drain 耗时：前 → 后 |
| --- | --- | --- | --- |
| 全部替换字符 | 约 116.45 → 55.63 MiB | 188.60 → 89.45 MiB | 2.07 → 6.39 秒 |
| ASCII / 替换字符交替 | 约 116.45 → 55.41 MiB | 185.89 → 89.06 MiB | 1.65 → 6.11 秒 |
| ASCII | 约 60.20 → 60.23 MiB | 114.27 → 114.57 MiB | 1.07 → 1.14 秒 |
| 普通混合 Unicode | 约 60.73 → 60.75 MiB | 160.96 → 160.99 MiB | 0.81 → 0.99 秒 |

替换字符的持有改进包含真正的总量下降，而非只把堆转到缓冲：完整 drain 组的未读出站阶段，当前堆增量约 4.04 MiB、external 增量约 51.59 MiB；旧实现约 115.18 MiB 与 1.28 MiB。取消场景同样完成输入但不创建已发送的模型请求。输出仍可能约 150 MiB，输入上限没有被偷换为编码后上限。

**这是内存 / CPU 权衡，不是吞吐提升。** 编解码增加扫描与临时对象；高替换密度输入的总耗时约为之前 3–4 倍。Node v24.14.1 / Windows、进程内离散样本和指定 GC 阶段，不是持续峰值、Workers CPU、网络接收确认、完整网关或并发容量证明。普通 Unicode 仍有明显高峰，不能以有利场景替代全量容量门禁。

## 4. 剩余门禁与下一项

唯一下一项：**C02.B2.2 — 原生字符串边界与全实例容量准入，优先长属性名 / raw_usage**。此次豁免保持原有持有量，不是解决这些原生消费者；SSE、multipart 内嵌 JSON、默认参数、Admin / 其他模态、在途请求 / 响应重叠及网络 / 存储持有期仍须计入。新增页表示不能当作全局容量管理器，不能用 Images 独立并发数冒充整个实例保护。

HTTP Audio / Admin 完整入口、headers / 有效 TTFT / idle、数据库提交确认与恢复、Realtime marker / Guardrail 零更新、共享音频收益、Qwen 格式、Node 22 / 真实 Workers / 数据库门禁保持；全池读取 / 解密留在 C07 / C09。C00 LOCAL_PASS，C01 / C02 DOING，C03–C20 TODO；C02.1–C02.7 / C02.G 不勾选，整体目标未完成。

无云写入、真实 KMS / OAuth / 模型、业务库、迁移、部署、支付、远程 CI 或依赖安装。GCP cinatoken 状态沿用现有证据，不重复检查。上一轮只复验已完成限额，本轮按 no progress 复查后进入实际实现；本轮有源码、测试和可比较实测变化，分类 progress，不符合 blocked。

## 5. 基线与可恢复性

轮初 HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`，245 个 dirty / untracked 文件；保存了全部轮初文件哈希，保留用户已有更改。[最终快照](./C02-json-page-storage-snapshot.json)的 206 个哈希全部匹配。相对轮初仅 8 个既有文件变化、5 个新增文件，合计 250 个 dirty / untracked 文件，无轮初文件缺失或无关内容变化。回退须针对本轮页面表示 / 选择及对应测试，不整体恢复工作树，不移除已有字节、结构、控制字段、deadline 或未知结果禁止重放合同，不删除账务事实。

收尾：前轮 203 个受测文件只有本轮 4 个源码 / 测试目标发生变化；后续公开文档变更已计入新快照。五份当前文档的本地链接目标已核对，git diff --check 退出 0。本轮所有测试、类型检查和测量进程均已正常结束，无未处理的运行句柄。没有提交 git commit 或启动远端部署。
