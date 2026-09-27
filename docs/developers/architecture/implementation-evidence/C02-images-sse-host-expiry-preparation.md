# C02 — SSE 原生平台取消探针准备

2026-09-08；Checklist v1.98。状态：LOCAL_PASS，完整专项回归 **1,086/1,086 PASS**，零失败、取消或跳过。本轮是本地实现与冻结候选准备，**不是新的线上终止验收**。C02.G 仍开放；最近线上证据仍是 [v1.97 真实客户端取消](C02-images-sse-cancel-staging.md)。

## 实现与证据边界

新增独立 staging 入口及固定 45 秒暂停，组合使用原 V2 的原生 INSERT、完整 12 字段身份核对和原生元数据，不修改旧探针或生产结算算法。在自有 held 标记的原生 CAS 已提交、但确认尚未返回 V2 时等待，因此不会进入旧探针的 20 秒释放轮询。无任意 SQL、可选等待时长、ctx.abort()、忙循环或自动重试。提前写 release-requested 不会提前放行；所有权变化不会被覆盖。

若 45 秒计时器正常返回，只能写 host-expiry-not-observed 并抛出实验失败。不能将其视作原生平台取消，也不能继续未执行的快照 INSERT。写入前保持 intent-only 和未结算预留；已经提交快照时，独立消费者可完成一次结算，生产者后续失败不撤销费用、不重复计费。这保持用户确认的“有效 completed + 实际上游 DONE”成功点；测试未重放推理、未构造退款。

独立入口要求三个固定版本/探针头、明确模式、D1、精确 POST 路径和 JSON 类型；这些头不授予 API-key 权限，转发前全部移除。无探针的普通请求沿用原 handler。取消观察复用原始 Request.signal、原生数据库和即时登记的 waitUntil，不读取响应正文。

Workers 技能要求区分请求仍在流式交付和断连后的后台时限。官方文档说明断连/响应结束后 waitUntil 的共享时限最多 30 秒，并给出平台取消警告。因此本轮采用固定 45 秒实验窗口，且只把匹配的平台警告作为终止证据的一部分。[Context 官方说明](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)、[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

## 平台证据合同

新增有界 tail 投影与断言，要求同时满足：

- 操作器从已核验 staging Worker 的原生 tail 获取数据，WebSocket 字节在解析前受限；校验器本身不认证来源，不能接收用户构造 JSON 当作云证据。
- 原生 tail 中三个探针头与请求唯一对应，Worker 名、部署版本、精确路径、POST 和 200 匹配；保留原始平台警告及时间，不保存原始请求头、凭证、正文或无关日志。
- 原始 Request.signal 已观测取消且快照仍停在目标阶段；之后读到的自有快照与取消时的值逐字节一致，提交后还要求原生成功元数据及完整身份验证。
- 平台警告必须是已知的两种精确格式之一，只有一条、无异常，并与发起、响应头、客户端取消、原生取消和日志收取时间有界关联。outcome=ok 不能单独说明后台任务完成。
- 通过只能证明该请求的 waitUntil 任务被平台取消，**不证明整个 isolate 已被回收**，也不能代替财务 oracle、完整实例容量或恢复验收。

## 本地验证

新增 40 项测试：10 项真实网关/SQLite/固定计时器/取消/独立恢复合同，30 项平台证据与边界校验。计时器使用 Node mock，因此这些是本地合同证据，不是 Windows workerd 或 Cloudflare 原生终止证据。写入前/后各覆盖计时器存活、提前释放、所有权改变；已有快照在暂停时恢复后，生产者失败与再次对账均保持完整财务行一致。缺失/错误所有者/非 armed 探针不能进入快照提交。

首次 10 项测试因合成 SHARED_KEY_ENCRYPTION_SECRET 少于 32 字符全部失败；只修正测试夹具长度后全部通过，未放宽运行时校验。后续完整回归与冻结结果见 [机器证据](C02-images-sse-host-expiry-preparation-results.json)。

核对最新 Workers 类型 5.20260908.1（注册表与当天已下载文件版本一致）；Wrangler 4.127.1、绑定生成/一致性检查、staging TypeScript 与离线 deploy dry-run 均通过。候选只改变入口，不创建资源、不自动 provision；Node 22 与新增远程 CI 尚未运行。

## 下一实施项与费用

下一步先实现对 held / host-expiry-not-observed 等真实状态的专用安全清理：保持财务原始事实，不把 held 改写成 release-timeout 来套用旧 oracle；平台证据、取消观察行和完整账务守卫需共同约束同一原子删除。随后接入有界原生 tail 操作器，再核验隔离、预算、冻结构建并执行两类 staging 实验。失败也必须关闭双 Access、回收临时身份/tail，并等待固定安全窗口后精确收尾。

本轮未部署、未调用 Cloudflare 管理 API 或测试 HTTP，未远端迁移。累计公开测试 HTTP 保持 333，真实模型/KMS 累计 0，首轮累计新增 US$2 上限不重置；最后一次云端关闭/清理证据属于 v1.97，本轮没有重新验证云状态，最终增量账单仍未核验。C02.G、客户 intent-only/unknown/幂等政策、SSE 完整生命周期、Node 22/host、跨消费者物理容量及 C03–C20 继续开放。
