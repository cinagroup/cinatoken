# C02 v287：显式 CPU 配置与部署回读

2026-09-21，Checklist v1.184。**LOCAL_PASS；未部署，CPU / D1 费用严格上界及完整准入仍未通过。** 上轮预算计算完成后，本轮检查实际执行配置，补齐三份候选未显式固定 CPU 设置的缺口。

## 实现

- 三份现有 staging 替代候选配置均显式设置 `limits.cpu_ms=30000`：gateway、maintenance receiver、maintenance controller。不改变资源名称、绑定、compatibility date、公开入口关闭状态或生产配置。
- 固定部署适配器的上传 metadata 同样携带此值；该 metadata 已进入候选指纹，因此旧的“未固定 CPU”指纹不能授权新合同。
- 每次上传后的独立 settings 回读必须返回数值型 `cpu_ms=30000`。缺失、null、字符串、上下漂移或错误结构均停止后续部署；第二次 settings 回读及后续依赖检查继续核对完整摘要。
- 服务端附带的其他默认 limit 字段可以存在，不能掩盖 CPU 字段缺失或不符。失败不自动回滚、不重放、不打开入口。
- 仅更新部署主机适配器、两个测试夹具及三份配置；没有修改推理 / 账务业务逻辑、原生 D1 操作、八个维护守卫或 5/10/15 秒限制。

## 不能把配置值当作严格费用上界

按 Cloudflare / Workers 最佳实践技能，在修改前通过 Firecrawl 核对了当前[平台限制](https://developers.cloudflare.com/workers/platform/limits/)与[最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。官方限制文档明确区分 CPU 时间与等待网络 / 数据库的时间，并说明 isolate 会容忍偶发超出配置值的执行。因此：

- `cpu_ms=30000` 是明确配置及漂移检查，不是“每次最多恰好计费 30000 ms”的证明；不能直接把它填入预算组件的已证明 CPU 用量上界。
- CPU 限制不覆盖 D1 扫描 / 写入计费，也不证明在途 SQL 被取消。
- 本轮未观察云端实际 CPU 设置、终止行为或费用；`remoteCpuSettingObserved`、`cpuBillingUpperBoundProved`、`d1CostUpperBoundProved` 和 `nativeD1CancellationProved` 均为 false。

检查了已安装 Wrangler 4.127.1 的 `UserLimits` 配置 schema、CLI 参数与转换代码。绑定类型通过 Wrangler 生成；没有手写 Env 或更改现有绑定。参考页保存在 `.firecrawl/cloudflare-workers-limits-v287.md` 和 `.firecrawl/cloudflare-workers-best-practices-v287.md`，摘要纳入证据。

## 验证与保留的失败

首轮源码测试 85 项及首份 dry-run 通过，但 `wrangler types` 默认生成运行时类型时，Windows workerd 在启动阶段报 `0xc0000005` access violation，首轮整体记为 `FAILED_RETAINED`。日志提示可能与本机运行库有关，但**未确认原因，不声称已修复**；没有安装或调整系统组件。

采用项目已有的 `--include-runtime false` 方式，只生成三份绑定类型；运行时类型使用已安装的 `@cloudflare/workers-types` 5.20260829.1 作为回退。该步骤不等于成功运行 workerd 或原生 Workers 验收，失败目录及首版验证脚本均按字节保留。

最终结果：

| 项目 | 结果 |
| --- | ---: |
| 部署适配器源码测试 | 85 通过 |
| 打包适配器 + 三份真实 dry-run 产物的模拟上传合同 | 86 通过 |
| 完整操作器回归 | 73 通过 |
| 预算组件回归 | 83 通过 |
| 重新打包的只读预检组件回归 | 46 通过 |
| **最终测试执行合计** | **373 通过** |
| 三份 Worker dry-run / 绑定类型生成 | 通过 |
| staging TypeScript | 通过 |

新增独立部署用例为 26 个，不把重复打包执行算作新增用例。覆盖三角色的七类错误回读、配置一致性、服务端默认字段、最终回读漂移、已部署依赖漂移和旧指纹拒绝。使用真实本地 bundle 的 PUT 仍是模拟传输，不是线上上传。

本轮 80 项直接产物摘要已验证；v286 的 33 项与 v284 的 767 项直接产物按六个已改源文件的旧版归档映射复核，旧 manifest 未改写。八个维护守卫保持不变。未递归重验证整个历史依赖树，也未重跑完整业务 suite 或 Node 22。

## 边界与下一步

Cloudflare / Workers 最佳实践用于识别 CPU 语义限制和配置缺口；Wrangler 技能用于离线构建、绑定类型生成及参数核对；Firecrawl 技能用于两页公开文档取证。Cloudflare 管理 API、云写入、部署、D1 SQL、公开 Worker、模型和 KMS 调用均为 0。两次公开文档抓取另行记录，未核对 Firecrawl 信用点实际扣减；累计 staging US$2 不重置，实际账单未刷新。

本轮修改了候选 metadata 和本地配置，**没有重新生成完整来源冻结**。旧 v284 来源快照不得复用为当前候选准入；执行前须用当前构建重新冻结和绑定身份。

下一有限顺序仍在 C02.B2.2：

1. 确认发送前 D1 扫描 / 写入及全链路 CPU 的费用上界是否能由受支持的执行合同和完整基线建立；响应后行数检查、CPU 配置值或本地计时均不足以单独证明。
2. 补历史费用 / 未结预留完整性、失败现场保留期成本，以及与候选绑定的持久预算预留。没有上界依据时保持未知，不降低 US$2 要求。
3. 补路由 / Pages / Dispatch、排他所有权、原生维护时序与完整只读 preflight / 同步 assertReady；满足后再重新冻结并进行一次原生验收。

v285 的 11 个 Zone HTTP 403 未有新事实，本轮未重复请求。C02.G / C01 及后续依赖保持未通过。

[机器证据](./C02-byok-d1-cpu-setting-v287-results.json)
