# C02 — 容量候选的产物补核与关闭入口部署

2026-09-08；Checklist v1.106，状态 **STAGING_PARTIAL**。已将 v1.105 容量观测候选部署到独立 staging，并核验云端实际代码。没有执行测试 HTTP 或推理，原生容量门禁未通过，生产未修改。

## 发布前发现的缺口

v1.105 dry-run 成功，但 Wrangler 将相对 `outdir` 解释为相对于配置目录：实际 JS 和 map 位于嵌套的 `.wrangler/staging/sse-capacity-v205/.wrangler/staging/sse-capacity-v205/bundle/`。原清单枚举的外层 bundle 只有 README，遗漏了可部署代码的摘要。因此旧清单不足以独立证明可部署包已冻结，不能直接据此上传。

本轮保留旧结果不改写，按构建元数据定位实际产物并补记摘要。核对 788 个真实源输入的字节长度与 SHA-256；14 个 `node-built-in-modules:` 虚拟模块单独记录，不能冒充普通文件或假定它们是零字节。改用绝对输出路径重新离线打包，实际 JS 与上一轮嵌套产物逐字节相同。

冻结可部署入口：`.wrangler/staging/sse-capacity-v206/bundle/images-sse-capacity-host-gateway.js`，SHA-256：`8f7e1d987092dc96c7f4037ac9d09261f6801b21ec8a6d7940e758635d92b34b`。新配置保留远端现有 `cpu_ms=1000`，不扩大 CPU 或物理容量额度。

## 实际部署和核验

部署前在同一操作时钟内完成只读预检：

- staging D1 的 UUID / 名称，56 表计数、295 schema 项摘要，以及恢复控制行不存在。
- 四个 staging Worker 的部署版本、设置指纹、关闭入口/预览、无 custom domain / Cron。
- 三个生产 Worker 的设置指纹；双 Access 应用身份、整域目标、deny-all 和 redirect 关闭。
- 历史临时 token 不存在、网关无 tail；费用接口返回 192 条延迟记录，所选 Workers/D1 USD ContractedCost 均为 0。

这组预检不是最终账单。首轮累计 US$2 上限保持不变，不因新一轮部署重置。离线冻结包再次 dry-run 成功后，发布使用 `--no-bundle`、关闭自动配置/资源创建，且第一次部署写入必须在本轮单调时钟预检结束后 60 秒内开始。仅允许一次部署尝试，结果不确定时核查远端，不自动重复上传。

实际结果：

| 项目 | 证据 |
| --- | --- |
| Worker | `cinatoken-proxy-staging` |
| 新版本 | `448e313a-7fef-4712-bde0-412173954b65`，100% |
| 云端代码 | content/v2 返回的实际模块中恰有一个与冻结 JS 的 SHA-256 相等 |
| 设置 | 除部署 annotations 外与发布前一致；settings SHA-256 仍为 `f29a9ff94d17c6f1ef0b9e09976058907553557689db88a0cf7590e76b2e4c71` |
| 入口与后台触发器 | 发布后 gateway 及其他三个 staging Worker 均重新核对关闭入口/预览，无 custom domain / Cron；候选配置无 Queue consumer，入口只导出 HTTP |
| 其他资源 | 发布后其他 staging 设置、三个生产设置指纹和双 Access 指纹均复核未变；未部署其他 Worker |

执行报告结束时间 **2026-09-08T12:11:50.801Z**。53 个可计数管理 API 请求（其中 D1 查询为只读 POST）和 1 次 Wrangler 部署操作；Wrangler 内部管理请求不包含在 53 中。D1 管理查询返回 rows_read=674、rows_written=0。数据库基线、其他 Worker 的部署版本和 token/tail 不存在是在发布前核对，不声称发布后又全部查询一遍。

本轮没有改运行时源代码或金额算法；沿用 v1.105 的 1,521/1,521 本地回归，不冒称重跑全集。重新构建的实际 JS 与已测试候选相同，并在部署前后校验完整历史文件及新增包/输入摘要。详见 [v1.106 清单](./C02-images-sse-capacity-deployment-results.json)。

本轮使用 Wrangler 技能，实际核对 4.127.1 命令、当前 schema 和关闭入口配置；技能影响了先 dry-run、禁用自动创建、固定 staging 资源和发布后字节核验。参考 [Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/)。不按技能的一般自动 provision 建议创建新资源，因为用户明确要求生产隔离与累计费用约束。

## 未完成与下一步

候选已部署但测试入口仍关闭。新在线脚本尚未接入有上限的 census 请求及同池分类；不得直接执行旧 v203 操作脚本，其版本/冻结源假设和容量观测合同不适用于当前候选。

下一步先完成 bounded census 的实际传输接线及错误/次数预算回归，再在同一会话重新预检当前云端隔离、Access 与费用，开展一条 after-hold 推理的原生取消/同池观测及独立恢复。后续是否开展 before-hold 必须由第一条的容量状态和剩余预算决定；不同实例仅记未证实，原池仍占用则保留事实，不重置计数或重新部署掩盖结果。

首轮测试 HTTP 累计仍为 **366**，真实模型/KMS 累计 **0**；无生产写入、订阅升级或真实支付。US$2 不重置，最终增量账单未核验。C02.G、完整物理工作集、其他消费者、unknown/幂等政策、Node 22 / 远程 CI 及 C03–C20 仍开放。
