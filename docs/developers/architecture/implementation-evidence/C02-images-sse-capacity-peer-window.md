# C02.B2.2 — Peer 封闭候选构建与一次性读体窗口

日期：2026-09-09；Checklist v1.113。整体 **STAGING_PARTIAL**。本轮补齐候选包与 HTTP/读体执行模块；没有部署，也没有开启新的云端测试窗口。有效 completed 图片与上游真实 DONE 均已验证后不可撤销成功结算的业务规则不变。

## 实现范围

`staging-sse-capacity-peer-window.mjs` 组合原 session、协调器和外层收尾模块，接管一个 after-hold 请求的真实 Response reader。重复调用返回同一个 Promise，不重发推理，不创建新预算。该模块要求外层先完成最新只读前检、Access/tail 归属和原子夹具 seed；**它还不是包含这些前置步骤的完整云端操作器**。

- 发请求前核对测试 key SHA-256 与原 session，重建规范合成夹具并校验 ids/cases，快照调用方输入与两项 Access headers；不允许调用方临时换成付费模型或改变清理归属。前检失效时连 watch 都不打开。
- 固定 staging URL、POST 禁止重定向、不使用缓存、单次请求。仅发送规范合成模型、协议 prompt 与内部诊断头；日志不保留 key、Access secret 或原始异常。
- 在原单调时钟 60 秒总窗口内读取至多 8 KiB 的有效 UTF-8 completed 帧，单次读体上限 15 秒。此帧只是私有测试的观察点，不是新的业务成功结算点；下游提前收到 DONE、EOF 或异常均拒绝正常验收。
- 保留真实 pending read，同时读取持久化 held snapshot、上游 completed/DONE 顺序、pending job 与空日志投影；经核心校验和 held marker 后才取消原 fetch。取消读体上限 10 秒，真实读取结束才调用完成步骤。定时器胜出后，迟到 read 不再调用正常成功转换。
- 原 session tail collector 的有界等待与原始 cancel/snapshot 行交给现有 V3 原生校验；不新建 collector，不注入或补造平台警告。然后沿用原两次 RPC 限额做恢复 1 / 去重 0，并核对完整账务事实。
- 无论失败发生在 headers 前、第一帧、held 读取、原生等待或恢复阶段，都立即停止核心并进入同一个 finalizer。finalizer 仍负责双入口/Access/tail/key 关闭、原生证明、350 秒安全等待及全字段 guarded 清理。收尾成功不把失败实验改成成功；最终日志写入失败明确返回 ATTENTION_REQUIRED。

## 封闭构建

新建 v214 专用目录和结果，不修改历史发布包，不重跑旧 v208 操作器。Wrangler 4.127.1 `deploy --dry-run` 成功，禁用自动配置与资源 provision；仅将旧容量诊断入口替换为 Peer V2 入口。配置逐字段比对确认其余不变：workers.dev / preview 均关闭、无 routes/crons、同一 staging D1 与私有 IMAGE_UPSTREAM binding、CPU 1000 ms、原兼容日期及 flags。

构建结果记录 789 个真实输入摘要、虚拟模块列表、配置、metafile、bundle 和 map；入口 SHA-256 为 `87c09d97c6297e016781b94e5f49e90ef6d8ef21fb8352e413983858567e9765`。Wrangler 日志留在工作区，构建子进程不继承 Cloudflare API 密钥。数据库 UUID 来源仍是历史记录，**不是本轮远端身份复验**。

## 本地验证

新增 22 项测试，真实组合 window、session、coordinator、finalizer、ReadableStream 和 SQLite。覆盖正常/分片 completed、真实 pending job 恢复及去重、headers 丢失、首次读体失败/超时、非法 UTF-8、超长帧、提前 DONE/EOF、观察失败、日志失败、输入身份/模型/header/前检边界、await 中输入替换、恢复 ACK 丢失、原生事件缺失和取消迟到回调。

测试中的网络、Access/tail、host-stop、pool 计数与单调时点均为**本地模型**。测试夹具从冻结的 v1.112 测试派生，只在本地轮换合成 key；不改写账务数字来满足断言。正常测试实际执行一次独立 SQLite 恢复和一次去重，预算为七次模拟公开请求；与未授权的真实模型调用无关。

联合回归 **1,766/1,766 通过**，失败/取消/跳过为 0，staging 类型检查通过。验证前后复核全部 1,695 条历史摘要、新源码、789 个构建输入和四项构建产物。[完整本地验证记录](../../../../.wrangler/staging/sse-capacity-peer-v214-verification-result.json)与[机器结果](./C02-images-sse-capacity-peer-window-results.json)记录命令和摘要。Node v24.14.1 本机验证；Node 22/24 CI 已定义，但远程 CI 和 Node 22 未执行。

## 平台边界与下一步

尚须组合新的完整一次性云端入口：最新身份/隔离/账单前检、候选部署与线上 module 摘要确认、固定 API/D1 传输、Access/tail 创建、原子夹具 seed、原预算计数与终态隔离复验。完成这些后才能运行平台测试。不能将闭合的 dry-run 或本地模拟标成 Workers 原生验收。

本轮没有 Cloudflare 管理 API、部署、公开 HTTP、远端 D1 写入、真实模型/KMS 调用或生产变更。首轮 HTTP 累计 **382**，真实模型/KMS **0/0**，**US$2 累计上限不重置**，最终增量账单未核验。最后实际云端观察仍为 v1.108 的 `2026-09-08T12:59:42.118Z`；容量 **INCONCLUSIVE_HELD** 保留。本轮 candidateNativeResult/windowResult 均为 NOT_RUN，C02.G 与完整物理容量门禁仍未通过。

后续仍按原 checklist 顺序推进 C02.B2.2 物理容量及其他消费者、unknown/幂等、C02.G；C01 剩余决策和 C03–C20 不关闭，也不以本模块完成替代完整目标。
