# C02：DashScope JSON 上传所有权与 ASR 长度声明（v243）

日期：2026-09-10。结论：**Node 本地回归通过；原生 workerd 启动失败，Workers gate 未通过；未部署。** 本轮为实质实现与验证进展，不代表 C02.G、C01 或后续依赖完成。

## 已实施

1. DashScope Qwen3 / Qwen-Audio / Fun 同步 ASR、异步提交、原生多模态透传均接入独立 JSON 上传资源 owner。快照和资源登记在认证／准入前，所有退出路径停止源；异步提交收到响应后停止上传，不由后续轮询重发。
2. 同步 Data URL 改为分页 Base64；原始片段至多 24 KiB，Base64 页面至多 32 Ki 字符；JSON pull 页面至多 64 KiB。不再在 dispatch 中构造完整二进制字符串、拼接 Data URL 或序列化完整 JSON 字符串。页面仍预先保留；入口、调用方文件和大配置字段的全部工作集不因此获得硬上限。
3. 内部 JSON 编码器结束不等于外层消费 EOF。已读取／锁定的上传被迫停止仍为未确认；响应 ACK 或稍后解锁不覆盖该结果。迟到响应清理保持原请求所有权，取消不触发异步查询或重提交。
4. multipart 与 JSON 最外层源设置 workerd 的 `expectedLength`，以声明精确原生长度；Node 保留显式 Content-Length。没有引入新的转发泵，也没有增加云资源。

三项既有测试调整为在 mock fetch 内消费 JSON 流，再断言原有参数；不再把 RequestInit.body 当作可在请求结束后读取的字符串。未改变 Images 不可逆成功点、金额算法、已观察上游状态的账务分类、生产容量开关或重放权限。内部不可序列化值仍在 dispatch 前拒绝；公开 JSON 请求／配置不支持自定义 hooks。

## 本地验证

首组同源码 40 项由修复前 **0 PASS / 40 FAIL** 到接线后 **40/40 PASS**。这组先断言新流式表示，再检查资源与 wire 语义，不把失败数解释成不同产品缺陷数。随后增加 48 项边界／取消／传输测试，最终新增 **88/88 PASS**：

| 范围 | 数量 | 证据边界 |
| --- | ---: | --- |
| 五路径 × 完整／主动取消／未读／锁定／部分读／解锁／末页非 EOF／明确 503 | 40 | JSON 字节兼容，资源独立，异步只提交一次 |
| 五路径 × 客户端取消／deadline × 迟到响应 ACK 成败 | 20 | 不追加查询／重提交，错误脱敏，上传未确认不被覆盖 |
| 原生 Node 本机 HTTP 五路径提交 | 5 | JSON 与 Content-Length 一致；异步用明确 503，未测真实异步服务 |
| 分页 Base64、上限、取消、快照、错误、EOF、声明长度 | 23 | 包括 10 MiB 既有上限与编码器末页不等于消费结束 |

最终完整回归 **3,439/3,439**（此前 3,351 + 新增 88），无失败、取消或跳过；dispatch 与 staging 两项类型检查均通过，最终验证进程退出 0。命令、测试日志与摘要在 `.wrangler/staging/asr-framing-v243-final-verification.json`。新 Node 测试纳入 `test:dispatch-safety` 与 `test:unit`，原生专项单独执行，未被掩盖为常规回归成功。

## 原生运行失败与长度证据

本轮按 workers-best-practices 技能重新检索 [Workers 官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、最新 npm 类型 `5.20260910.1` 与 [workerd 官方源码](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/streams/standard.c%2B%2B)，检查 `expectedLength` 的 setup、detach、tryGetLength 传递。不安装／升级依赖，不改变配置、系统库或兼容日期。

新增 `asr-upload-workerd.test.mjs` 专项原计划以真实 workerd 向本机合成上游发送 6 种长度的 multipart，核对 Content-Length、非 chunked 和逐字节内容。初次夹具使用旧 Miniflare 参数形式，已改为已安装 Miniflare 5 导出的 `convertV4MiniflareOptions`。修正后仍在启动阶段报 `ERR_RUNTIME_FAILURE / 0xc0000005 access violation`，进程终态退出 1；**没有进入上传请求，0 项原生上传通过**。不能据此断定 VC 运行库就是根因，也不能将它解释成上传代码失败。后来仅修正专项的 cwd 独立路径并通过语法检查，没有再次重启失败运行时。

这次失败保留为 tool output 的明确转录观察，不虚构为独立捕获的 stdout 日志，详见 `.wrangler/staging/asr-framing-v243-runtime-observation.json`。源长度声明检查在 Node 仅证明构造参数；官方实现提供支持依据，但实际原生 wire 仍未证实。此点与 [上一轮普通流的风险记录](./C02-asr-upload-v242.md)不矛盾：本轮新增源级声明，不宣称已经通过原生验收。

技能促使本轮避免仅凭手工 HTTP 头宣称定长，并区分编码完成、消费者完成与原生运行证据。合同见 [ASR JSON 上传与长度声明](../../reference/asr-json-upload-policy.md)。

## 剩余与费用

剩余包括其他 JSON／错误正文消费者、入口准备／数据库自身时限、调用方引用和全工作集、Node 自动停机、JSON 原生专项、原生 multipart 专项、Cloudflare staging 完整驱动及原实例容量。不能以 Node、本机小夹具或可替换的相邻实例样本放行生产。下一轮继续这些依赖；云端验收须新冻结 bundle。

继承并核验 v242 的 **2,283 条**摘要记录；受影响历史源码按路径＋SHA 重定位，不重写旧 manifest。完整哈希与范围见 [机器证据](./C02-asr-framing-v243-results.json)。

本轮 staging 管理／公开调用、部署、生产写入、真实模型及 KMS 全为 0；首轮累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置。US$1.20 历史／延迟预留和 US$0.80 未分配仍不是已核实账单；最后远端观察仍 v232（2026-09-09T06:45:06.937Z），未刷新云端状态或账单，旧已部署 bundle 不含本轮改动。
