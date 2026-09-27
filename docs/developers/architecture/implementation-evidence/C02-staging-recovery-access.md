# C02.B2.2 — 专用 Access、封闭 Workers 发布与失败冒烟

2026-09-07；Checklist v1.58。**隔离发布与访问保护已验证；合法无体 POST 被拒绝，恢复 RPC 尚未运行，C02.G 未通过。** 结果与失败过程见 [记录 JSON](./C02-staging-recovery-access-results.json)，前置基线见 [v1.57 schema / 实验容量](./C02-staging-recovery-schema.md)。本轮未修改恢复运行时代码、SQL 草案或源配置模板。

## 已发生的云端变化

只在账户 `7ea8e46d8210bad342fa7595f7935fea` 操作两台专用 staging Worker：

| Worker | 已上传版本 | 能力 |
| --- | --- | --- |
| `cinatoken-staging-usage-recovery` | `cde8d551-3aa1-4678-8202-374fef9ba722` | 仅 `RECOVERY_DB` → staging D1 `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`；命名 `UsageRecovery` RPC |
| `cinatoken-staging-recovery-control` | `f782eab1-8017-4d2c-b86f-8c9c21be8a56` | 仅 `USAGE_RECOVERY` → 上述接收端命名入口；无 DB / provider / KMS / assets |

两台 Worker 均在关闭 workers.dev / previews、无路由 / 自定义域名 / cron 的配置下上传。接收端 64 MiB 单消费者、每批最多 5 项为实验配置；**不代表 Workers 物理容量已通过**。源模板仍 disabled/0，生产未启用。

新建专用 Access 应用 `2ed1f9a7-7eb3-45ad-8cdc-392f7ae96bc0`，只覆盖 `cinatoken-staging-recovery-control.cinagroup.workers.dev`。应用、策略和服务令牌创建/更新/禁用/删除权限均已实测；不等于所有 Cloudflare 或 GCP 权限已验证。临时开放期间只有单一 `non_identity` 策略允许本轮一枚 1h 服务令牌。客户端密钥仅留内存，未写入证据/配置/输出。

## 真实 HTTP 结果

| 请求 | 结果 | 解释 |
| --- | --- | --- |
| 未认证就绪探针 2 次 | 404 → 401 | 首次路由尚未就绪；不把 404 当作访问保护证明 |
| 错误服务令牌 | 401 | Access 拒绝 |
| 正确身份，错误方法 / 路径 / query | 各 404 `not_found` | 固定路由拒绝；这些分支先于运行时 audience 校验 |
| 正确身份，缺命令 / 带 Origin / 非空正文 | 各 400 `invalid_command` | 已越过原生 Access audience 判断，到达命令形状检查 |
| 正确身份，合法无体 POST | **400 `invalid_command`** | 预期 200，实际不符；测试立即停止，未调用恢复 RPC |

共 10 次请求。后三个负例只证明组合校验拒绝，不能据此证明每个条件在线上都独立起效：合法对照也被拒绝。当前同一错误合并 Origin、命令头、body、Transfer-Encoding 和 Content-Length 条件，**尚未测出具体触发项**。“平台空正文呈现为非 null 流”只是待验证假设，不是已证实根因。不得删掉 body 校验或只信任 Content-Length=0 来制造通过。

代码依赖原生 `ctx.access.aud`；文档说明它只属于直接经过 Access 的调用，不会经 Service Binding 传播。本轮已验证控制端可越过该检查，但没有成功执行下游 RPC。[Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

## 收尾与保留的失败

首次收尾已关闭入口并禁用令牌，但恢复 deny-all 返回 12130、删除仍被引用的令牌返回 12139。检查确认没有未授权入口；随后仅修改专用应用，依次关闭 `service_auth_401_redirect`、恢复 deny-all、删除失去策略引用的令牌，回读成功。保留原始失败结果，不将它改写成 PASS。禁用和删除服务令牌是不同步骤，最终以列表中不存在本轮令牌为证。[服务令牌管理](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

最终独立只读核验通过：

- 四个相关 staging Worker 的 workers.dev / previews 均关闭；专用应用 deny-all，本轮令牌不存在。
- 三个生产 Worker 设置指纹、两个实验 Worker 设置指纹及其他 Access 应用指纹符合预期。只读生产设置，不读生产用户数据。
- 24 个恢复 schema 对象定义检查通过；原 52 张表及 4 张恢复表共 56 个行计数不变，恢复四表仍空。这不是全库内容散列或非空回填证明。
- 66 个基线源文件摘要保持；未重放 schema、未删除 Worker / D1 / 历史证据。

还保留四类操作失败：初始 Workers 列表 500/10013（非权限拒绝，强制进程退出另触发 Windows libuv 断言）；Wrangler 相对 outdir 按配置目录解析导致本地产物找不到；D1 binding 多返回同值 `database_id` 字段导致精确对象断言停止；可选关闭字段在 GET 中被省略导致首次最终校验停止。分别检查实际状态后修正操作脚本，没有盲目重复云端写入。接收端与控制端各上传一次；第二次上传后只复用确认过的接收端版本。

## 本地验证、费用与下一步

99 项既有控制 / host / Images 组合测试通过，staging 定向 TypeScript 检查退出 0。两份配置共同生成的命名 RPC 类型及 `types --check` 通过；接收端重打包 SHA 与 v1.57 完全相同。首个仅传控制配置的类型产物是通用 Service，不算命名 RPC 类型证明。完整 staging suite / 完整 Core 类型检查本轮未重跑；历史 Core 32 条诊断不宣称已修复。依据 Workers / Wrangler 技能采用独立绑定、源配置关闭、发布前打包和真实平台验证；Node 单测不能替代线上通过。[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

本轮记录 **126 次显式管理 API 请求**，不含 Wrangler 内部未计数请求；不能称为全部云端请求总数。10 次只读 SQL 查询的已返回元数据合计读 1,677 行、写 0 行；上传 2 个 Worker，公网 HTTP 新增 10、首轮累计 108，模型/KMS 0。US$0.02 是本次实验保守预留，不是实付；**首轮累计 US$2 不重置，最终增量账单未核验**。

下一项仍为 C02.B2.2：先在授权保护后的最小诊断中区分合法请求的正文/头部表示，不记录原始凭据；确认后补有界零字节校验及正文持有期、取消/超时/对抗测试，再重测空队列 RPC/D1。随后才进入合成非空恢复、重复结算、真实平台终止和物理工作集验收。线上漏日志事件、C02.G、C03–C20 不因本轮权限或发布成功而关闭。
