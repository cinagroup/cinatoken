# C02.B2.2 — 长属性名恢复与审计持有期

日期：2026-09-06。状态：**解析恢复所有权子集 LOCAL_PASS；C02 DOING，原生字符串/统一容量/真实运行时未通过**。执行 / 自检：Codex；独立 Reviewer 待指定。接续 [用量审计工作集](./C02-image-usage-working-set.md)，不覆盖历史记录。

## 1. 已完成的实现

[segmented-json-response.ts](../../../../packages/proxy/src/services/egress/segmented-json-response.ts) 在完整 EOF 和原生骨架语法验证之后，改变对象恢复过程：

- 每个骨架引用唯一，消费 token 时立即把解析器槽位置空，向结果对象转移持有权，不再把已消费长键的解码页保留至整棵树完成。
- 在最终对象自己的可写数据属性上完成重复键判定，不再用额外 Map 同时保存全部完整属性名。先解析实际键名和最终值引用，再恢复子值；保留整数键枚举顺序、首次键位置与最后值、转义等价键、`__proto__` / `constructor` / `toJSON` 数据语义。
- 遇到被覆盖子树时，递归清除其 token 引用，不构造其长属性名或原生长值。深度/节点预算仍覆盖所有原始重复字段和被覆盖内容，语法错误不会因丢弃而漏过。
- 恢复与丢弃过程中检查原取消信号，完整原生字符串合并之后也检查；取消原因本身是 SyntaxError 时不误判为供应商 JSON 错误。原生 join / 属性名构造仍是不可分割的同步操作，这不是任意时刻抢占 CPU 的机制。

最终属性名仍是**完整原生字符串**；已消费引用变为可回收，不意味着运行时已经 GC，更不意味着物理清零。不新增属性名/usage 限额，50 MiB 入口、32 MiB 普通上游及已批准控制字段/prompt 合同保持。生成入口与普通 Images 响应共用此解析器；SSE 和其他原生 JSON 路径不自动获得此优化。

使用 Cloudflare Workers 最佳实践技能检查所有权、分段消费和实际容量边界，参考 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新 types registry 读取失败，核对已安装 Workers types 5.20260829.1 / Wrangler schema；未改变兼容配置或安装依赖。

## 2. 回归与停止行为

[segmented-json-response.test.ts](../../../../packages/proxy/src/services/egress/segmented-json-response.test.ts) 新增 **21 项测试**：

- 分段 / 原生模式 × 三种输入分片，覆盖嵌套重复键、整数键顺序、null/false/-0、最终 nativeStringFields 与长值。
- 被覆盖子树的长键和长值从不 materialize；不再把完整长键写入第二个 Map；自己的数据属性不触发继承 getter/setter，属性描述符保持。
- 首个/最后长键和原生值合并时取消，Error / SyntaxError / 字符串原因均原样传播；丢弃子树时取消也不吞掉；EOF reader 已释放，无残留 abort listener。
- 被覆盖长键的非法转义、容器尾逗号、附加根仍拒绝，不把未经完整验证的结果交付。

最终执行：

| 验证 | 结果 |
| --- | --- |
| 解析器单文件 | 98 项，退出 0 |
| `npm test -w @octafuse/proxy`，完整 pretest 链 + 主 suite | 退出 0；主 suite 2,928 tests / 135 suites |
| `npm run test:dispatch-safety -w @octafuse/proxy` | 退出 0；2,553 tests / 50 suites |
| Proxy / dispatch-safety / Admin 类型检查 | 三项退出 0 |
| 同脚本前后测量 | 各 8 个独立进程，退出 0 |

最终无失败、跳过或取消；测试集有重叠，不相加。早期三文件联合 192 项亦通过。没有真实模型、KMS/OAuth、业务库或支付测试。

## 3. 内存证据：可回收不等于自然峰值下降

[原始结果](./C02-json-key-restore-memory.json) / [测量脚本](../../../../packages/proxy/scripts/measure-json-key-restore.mjs)。生产源码变更前运行 8 个基线进程，变更后相同脚本再运行 8 个进程。每个源 JSON 精确 50 MiB，16 个长键；包括唯一 ASCII、无效 UTF-8 替换字符、相同键重复、被覆盖子树的 12 个键加 4 个保留键。独立构造并流式核对完整输出字节数 / SHA-256、最终键数/值、最多 64 KiB 输出页和 reader 释放，不在验证中留存完整期待字符串。

自然模式只在读取、长 join、属性定义、解析返回、指定 GC 阶段和输出 pull 处取样；不在恢复循环中强制 GC。另一组 `gc-probe` 在长 join / 属性定义前后强制 GC，仅诊断哪些引用仍可达，**不能当作自然峰值或吞吐测试**。新旧属性定义次数在重复键场景不同，GC-probe 钩子次数也不同，更不能把其耗时当作业务 CPU 对照。

以下为每个进程基线以上的 **heapUsed + external 同时刻增量**（MiB）；arrayBuffers 已包含于 external，不再相加。离散最大值不是连续峰值。

| 自然回收场景 | 解析返回时：前 → 后 | GC 后仍持有结果：前 → 后 | 全流程离散最大：前 → 后 |
| --- | --- | --- | --- |
| 唯一 ASCII 长键 | 113.59 → 111.37 | 53.79 → 53.81 | 135.10 → 112.91 |
| 唯一替换字符长键 | 216.84 → 164.47 | 103.78 → 103.80 | **216.84 → 243.03** |
| 重复 ASCII 长键 | 116.34 → 116.41 | 6.91 → 6.94 | 116.34 → 116.41 |
| 覆盖替换字符子树 | 169.62 → 169.93 | 28.76 → 28.79 | 169.62 → 169.93 |

自然模式下 ASCII 有较低观察值，但替换字符观察最大值反而增加约 26 MiB；其余两类基本不变。**不声称整体内存下降，也不把不利样本隐藏。** 自然模式解析耗时分别约 667 → 698、963 → 1,034、575 → 540、776 → 730 ms，属于单次 Node v24.14.1 / Windows 观察，不能推断稳定吞吐。

GC-probe 的解析返回时增量分别约 110.41 → 57.41、216.79 → 110.98、66.64 → 10.53、141.76 → 35.96 MiB，支持“恢复阶段存在更少可达引用”的结构性结论。结果完整持有量几乎不变，因为最终长键本来就必须存在。当前实现不具备 Workers/Node 22/完整网关/多请求连续容量证明。

## 4. 完整 raw_usage 的持有链核对

本段为源码持有关系核对，**不是完整账务安全审计，也没有测量数据库客户端内部缓冲**。未改动下列账务/后台实现。

| 边界 | 当前证据 | 容量准入必须考虑 |
| --- | --- | --- |
| 生成审计字符串 | [image-response-usage](../../../../packages/proxy/src/services/egress/image-response-usage.ts) 返回完整 raw_usage；[驱动](../../../../packages/proxy/src/services/egress/openai-images-driver.ts) 的 imageUsage 与 usagePromise 共享该字符串引用 | 多个引用不等于多份完整字符串；但审计字符串与原始分段 usage 是不同表示，可能同时存在 |
| 响应交付 | [stream-json-body](../../../../packages/proxy/src/services/egress/stream-json-body.ts) 的迭代器持有结果树至 EOF/cancel/error，并在 finish 清除 | 流未结束时，不能因驱动或 usagePromise 已完成就释放响应资源预算；编码 EOF 也不等于客户端接收确认 |
| 路由转交记账 | [Images finalizeImageResponse](../../../../packages/proxy/src/routes/v1/images.ts) 提取计数后删除 meta.parsedBody，但将 imageUsage 传入后台 recordImageUsage | 删除一处引用不等于响应编码器与后台审计都释放；这两条生命周期独立 |
| 后台持有 | [schedule-background-work](../../../../packages/proxy/src/runtime/schedule-background-work.ts) 在 Workers 用 waitUntil，在 Node 用受管 Promise 集合，终态后移除 | 不能在 HTTP handler 返回、仅 response 结束或仅 driver usagePromise 结束时归还全部容量；仍在途的记账必须计入 |
| 仓储原生边界 | [recordImageUsage](../../../../packages/proxy/src/services/image-usage-charge.ts) 把完整 rawUsage 交给 [critical write](../../../../packages/core/src/storage/critical-write-paths.ts)；[请求日志类型](../../../../packages/core/src/db/request-logs-types.ts) 要求 string/null；[D1](../../../../packages/core/src/db/d1/request-logs.impl.ts)、[Postgres](../../../../packages/core/src/db/postgres/critical-writes.impl.ts)、[MySQL](../../../../packages/core/src/db/mysql/critical-writes.impl.ts) 均转交该字段 | 现有接口不是分块审计存储。数据库等待、事务终态及客户端编码缓冲需要单独测量，不得擅自删改审计事实 |

统一准入应覆盖请求读取/准备、在途上传、响应编码和后台记账的独立持有权，允许按真实终态分阶段转交/归还，不把一条链完成冒充全部释放。还须覆盖其他模态与共享实例；不能用 Images 单独并发数或仅对象数量代替字节/持有期预算。

## 5. 下一步、授权与完成范围

唯一下一项：**C02.B2.2 — 统一容量准入合同与响应/后台记账所有权**。长键的解析器历史引用与额外 Map 已处理，不重复列为未做；最终长属性名和完整审计字符串仍未受专门容量约束，单请求自然峰值也未证明符合目标运行时。

本子阶段测量与测试时尚未获准为 Images 属性名与上游 usage 添加上限，保持原兼容合同。收尾时用户已明确回复“允许制定合理上限”；后续限制作为独立增量实现并重新验证，不倒改本节前后测量，也不截断审计事实。

HTTP Audio/Admin 完整入口、headers/有效 TTFT/idle、数据库提交确认与恢复、Realtime marker/Guardrail 零更新、共享音频收益、Qwen 格式以及 Node 22/真实 Workers/数据库门禁保持。全池读取/解密留 C07/C09。C00 LOCAL_PASS，C01/C02 DOING，C03–C20 TODO；C02.1–C02.7/C02.G 不勾选。

## 6. 基线与回退

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`，轮初 258 个 dirty / untracked 文件。上一轮 212 个快照哈希已在本轮起点全部验证匹配。[最终快照](./C02-json-key-restore-snapshot.json)记录当前受测实现及文档/测量。保留用户已有改动，回退只针对本轮 token 消费/丢弃、对象恢复及配套测试；不得整体恢复脏工作树，不撤销已批准控制限制、完整语法/字节/结构验证、deadline 或未知结果禁止重放合同，不删除账务事实。

本子阶段快照 214 文件；受测解析器与测量脚本哈希匹配。相对轮初 258 文件仅 6 项修改、4 项新增，总计 262 项，无轮初文件缺失。所有测试/测量进程已正常终止；后续授权上限增量另建快照。

无云写入、真实 KMS/OAuth/模型、业务库、迁移、部署、支付、远程 CI、依赖安装或 git commit。Google Cloud KMS / cinatoken 沿用既有证据，不重复检查或创建密钥。上一轮与本轮均为实际 progress；整个共享平台目标保持 active。
