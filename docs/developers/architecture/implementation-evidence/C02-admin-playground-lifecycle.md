# C02.B2.2 — Admin playground 辅助认证预算与请求生命周期

日期：2026-09-05。状态：**下列本地子集 LOCAL_PASS；C02 仍为 DOING**。执行与本地自检：Codex；独立 Reviewer 待指定。接续 [Realtime 回退/提交边界](./C02-realtime-fallback-recovery.md)，不覆盖历史证据或将本地测试视为生产验收。

## 1. 实际变更与边界

- [Core 请求生命周期](../../../../packages/core/src/request-deadline.ts)：从 Proxy 原实现提取纯 deadline / cancellation / response stream / owned mutation 合同；Proxy 文件保留再导出和文本记账错误分类。Admin 不依赖 Proxy，也没有接入买家调度器或账本。
- [预览服务](../../../../packages/admin/lib/services/admin/playground-service.ts)：在服务入口建立不可续期的 300 秒本地上限，覆盖路由/指定供应商/模型读取、凭据处理、OAuth、出站、异步 ASR 查询、下载及响应流；每请求至多一次冷 OAuth exchange，OAuth 时限不超过剩余总时限与既有 30 秒上限。已完成 token 数据缓存命中不额外消费认证预算，未跨请求共享未完成 I/O。
- 供应商读取改为 `getProvidersByIds([selectedId], control)`，沿既有加密/env 包装层传递取消。仍只用选定供应商单键，不查询或预解密整个池。已经开始的兼容格式回写由 owner 等待确认，不能靠 deadline race 丢弃持久写入。
- 模型 POST 显式 manual redirect，取消后不重试、不切供应商；迟到响应会被丢弃。ASR 最多查询 60 次、间隔 1 秒，查询与签名下载的每次 GET/redirect 都受同一 owner 约束，不重新提交任务或换凭据。TTS/ASR 签名下载不转发供应商 Authorization。
- [生命周期辅助](../../../../packages/admin/lib/services/admin/playground-request-lifecycle.ts)：控制 JSON 检查声明及实际字节数，至多 1 MiB，严格 UTF-8/JSON 解析；媒体/SSE 仍流式传递。轮询 timer/abort listener 在完成和取消时移除；不会等待无限挂起的 response cancel acknowledgement。
- 修复预览 ASR 结果下载返回非成功 HTTP 时仍包装为成功文本的问题；现在取消响应并返回 502。取消/超时/认证预算/上游异常分别保留固定消息的 499/504/429/502，瞬时 PostgreSQL 错误仍交既有 503 mapper。没有把原始 transport error 中的签名 URL 或凭据反射给客户端。
- [Admin 配置模板](../../../../packages/admin/wrangler.base.jsonc)加入 `enable_request_signal`；本地生成配置保持一致。初次只修改了 gitignored 生成文件，最终复核发现会被 postinstall 覆盖，已补到模板并同时测试两者。未增加 binding、修改线上配置或运行部署。
- [Admin scripts](../../../../packages/admin/package.json)新增 `test:playground` 和 Core 预构建；[现有安全 CI](../../../../.github/workflows/proxy-dispatch-safety.yml)增加 Admin 路径和专项 job。本轮未触发远程 CI。

静态核对：排除 Core 定义及测试 fixture 后，既有 **17 个应用 `resolveProviderUpstreamSecret` 调用点均传入辅助认证预算参数**。这只证明这些调用点已接线，不代表所有鉴权方式、插件或完整入口生命周期都已验收。

300 秒与 1 MiB 是本地安全上限，不是已批准的生产 SLO 或供应商官方限制。原 latency 展示仍从凭据处理后的阶段计时，不能用它证明总 deadline 从入口启动。

## 2. 新增测试及证据层级

[新测试文件](../../../../packages/admin/lib/services/admin/playground-request-lifecycle.test.ts)共 **32 项**，合成 RSA/service account、拦截 fetch、受控时钟与最小类型化 repository；没有真实 OAuth 或模型请求。

| 范围 | 关键断言 |
| --- | --- |
| 配置与单路由 | 模板/生成结果启用取消信号；四种协议单次 manual POST；普通凭据与服务账号缓存；冷认证预算耗尽拒绝、已有缓存不再消费 |
| 准备与所有权 | route/provider/model 读取中及预先取消后均零出站；准备耗尽总 deadline；OAuth 仅获得剩余时间；已开始回写确认前请求不结束 |
| 认证与响应取消 | OAuth 头/体取消、超时与迟到响应不缓存；不等待挂起 cancel；未读模型流仍可终止；模型 POST 不重放；EOF 移除父信号 listener |
| 控制数据与轮询 | 声明/实际超限均拒绝；连续 12 次等待不累积 listener；ASR 三次查询后完成或下载 403；查询取消后迟到结果不恢复流程 |
| 媒体与错误合同 | TTS 下载不携带供应商认证、流取消有效；迟到下载 redirect 不再出站；Hono 错误映射不反射 transport secret；既有数据库 503 保留 |

已有 rerank fixture 改用完整类型化的最小 repository 合同，移除绕过类型系统的双重断言，并消费/取消测试响应以释放 owner。初次类型检查发现新增测试直接访问未知 JSON 的 output；最终使用对象/字段检查修正，没有放宽生产类型。

这些是服务集成与错误 mapper 测试，**不是完整经过 Next/OpenNext 管理员鉴权的公开路由 E2E**。回写测试是合成 owned-mutation barrier，不是真实 SQL 回写或 KMS 迁移。未独立进行生产性能、内存峰值或 DNS/SSRF 全链路验收。

## 3. 最终本地验证

Windows / Node.js **v24.14.1**；Proxy 既有真实内存 SQLite 测试使用 **3.51.2**，与本轮 Admin 合成 repository 测试不同。本轮无外部/业务数据库访问、云账号访问、真实 KMS/OAuth/模型调用、支付、业务库迁移、部署或远程 CI。

| 命令 | 结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/admin` | 最终退出 0 |
| `npm.cmd run test:playground -w @octafuse/admin` | 退出 0；47 tests / 5 suites，0 fail/cancelled/skipped |
| `npm.cmd run test:unit -w @octafuse/admin` | 退出 0；418 tests / 84 suites；pretest 链通过 |
| `npm.cmd test -w @octafuse/proxy` | Core 提取后退出 0；1,766 tests / 135 suites；pretest 链通过 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | Core 提取后退出 0；1,391 tests / 50 suites，0 fail/cancelled/skipped |
| `npm.cmd run typecheck -w @octafuse/proxy` | Core 提取后退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | Core 提取后退出 0 |
| `git diff --check` | 退出 0；文档写入后再次复核 |

套件之间有重叠，不能相加。Core 完整主套件未独立重跑；Node 22、实际 workerd/OpenNext、托管 D1/PostgreSQL/MySQL 和远程 CI 未验收。

HEAD 为 `7eb59008f7d8e156e81fd18a57658fdef2553264`。本轮开始 151 个 dirty/untracked 文件；文档前比对只发现上述任务范围内 10 个非忽略的源码/配置路径变化或新增 dirty 状态，另有本地 gitignored 生成配置。未回退或覆盖其他既有改动。[135 文件 SHA-256 快照](./C02-admin-playground-lifecycle-snapshot.json)记录受测源码、配置、相关历史保护文件和迁移，不把文件数量当作测试覆盖率。历史证据文件不更新为本轮 hash。

Workers 最佳实践技能影响了流式读取、有界控制响应、异步所有权、配置模板持久化及本地/真实运行时证据分层；官方依据为 [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 和 [Request 取消信号](https://developers.cloudflare.com/workers/runtime-apis/request/)。最新 registry 获取失败时按技能 fallback 检查已安装 workers-types **5.20260829.1** 与 Wrangler schema，未更新依赖或手写新增绑定类型。配置 flag 不能证明 OpenNext 实际将客户端断连传递到所有分支。

## 4. 未完成、停止条件与唯一下一项

1. 本轮 deadline 从 `invokePlaygroundUpstream` 服务入口开始；Next/OpenNext 鉴权、请求上传、Hono JSON 解析之前尚无统一总时限。管理端 toolId/Realtime 分支不属于此次 HTTP 路由预览改动。
2. 数据库读取消为逻辑停止/晚到结果观察；已开始写入仍等待确认，数据库永久挂起的物理取消、确认恢复和进程退出不在本地 deadline 保证内。
3. headers、有效 TTFT、idle 与 multipart 总内存预算尚未统一。下载复用现有 URL/redirect 安全检查，不声称已补 DNS pinning 或 hostname allowlist。
4. [Realtime 已复现边界](./C02-realtime-fallback-recovery.md#3-已复现但未解决的发布边界)不变：零出站的 dispatch marker 丢确认仍可能被保守消费预算；Guardrail 零更新计数恢复未修复；unknown 预算消费不是已确定收费；共享音频买家预算结算而卖家收益为零的缺口仍阻断对应商用。
5. Google Cloud KMS project `cinatoken` 已确认；location、保护级别、承载/身份/IAM、审计和费用等门禁不因本轮 OAuth 测试而通过。不重复询问厂商/项目，不创建真实密钥。

**唯一下一项：C02.B2.2 — embeddings/rerank 入口、鉴权、选路及准备全过程时限。** 随后补图片/HTTP Audio 与 Admin 完整入口、分阶段时限和数据库确认恢复。C02.1–C02.7/C02.G 不勾选；C01、C03–C20 状态不变。

停止/回退：如真实预览取消链路无法验证，保持未验收而不扩大到生产；必要时停止受影响预览入口的新请求，保留正在确认的兼容写入，不通过禁用超时、启用凭据明文回退或重放模型请求掩盖问题。未新增生产禁用开关，也不声称线上入口已被关闭。
