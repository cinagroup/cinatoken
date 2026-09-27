# C02 — SSE 快照发布包、只读预检与双入口收尾

2026-09-08；Checklist v1.94。状态：LOCAL_PASS，发布包 PREPARED、云端 READ_ONLY_PREFLIGHT_PASS。没有部署或执行新的线上快照故障矩阵，C02.G 不关闭。

## 已完成

冻结 v1.93 的专用快照 gateway 发布包，配置只将 v1.89 耐久 gateway 的 main 指向专用 staging 入口。固定 staging 账户/D1、私有 IMAGE_UPSTREAM、CPU 1,000 ms、关闭 workers.dev/preview、空 routes/crons 均保留。Wrangler 4.127.1 的版本核验、绑定类型生成、类型新鲜度检查、离线 dry-run、staging TypeScript 检查五步通过；生成 Env 字段与已有绑定合同一致。冻结 781 个真实打包输入、14 个虚拟 shim 输入及输出摘要。

候选 JavaScript 为 3,811,612 bytes，SHA-256 `19eaaa96fa23ea7714239e978d59704f2021dc6ce37e14751a0bce8d010dfcba`。这是离线产物，不是线上版本，也不是整个 Workers 实例的内存/CPU 容量证明。

只读 Cloudflare 预检确认：四个 staging Worker 的配置及版本保持不变，workers.dev/preview 关闭，custom domains/crons 为空；两个 Access app 为 deny-all、401 redirect 关闭，历史临时令牌不存在；三份生产 settings 指纹不变；staging D1 的 295 个 schema 对象及 56 张表计数保持基线。管理 SELECT 共读取 672 行、写入零行，未重放已应用的 SQL 草案。

核对了已保存的实际启用配置与独立恢复调用路径：控制 Worker 通过私有 `USAGE_RECOVERY` binding 调用无参数 `run()`；HTTPS POST `/_control/usage-recovery/run` 要求原生 `ctx.access.aud`、精确 command header 与空 body，不接受调用者提供的租户、SQL、次数或容量。消费者限定 staging，max items 5、并发 1、lease 30 秒、run budget 5 秒、逻辑保留/实例容量各 64 MiB。该数字是实验配置，不是实测容量。当前消费者带有旧 claim-delay/fencing 探针；下一次真正调用前仍须检查控制记录缺席、无其他待处理 job，不能仅凭全表行数推断。

## 新增双入口收尾

[收尾模块](../../../../scripts/deploy/staging-sse-recovery-access.mjs)在网关与恢复控制 app 共用一个精确归属的临时令牌时，补足原网关-only closer 的调用前置条件。它不负责开放入口、不发 HTTP 推理、不运行消费者，也不删除数据库记录。

1. 先尝试关闭两个固定 staging ingress；一个关闭调用失败/确认丢失时仍尝试关闭另一个。两边未确认关闭之前不修改 token 或策略。
2. 精确验证控制 app 的 ID、domain、audience、destination、单一策略 ID/名称及令牌归属；重复名称、重命名、外来令牌或策略漂移直接拒绝。
3. 禁用自己创建的共享令牌，关闭控制 app 的 service-auth redirect，再恢复其 deny-all；每一步保存非敏感检查点。
4. 调用既有 gateway closer，关闭其 redirect、恢复其 deny-all；只有两边策略都解除引用后才能删除共享令牌。
5. 再核验恢复控制 app/ingress；重复调用依据实时状态继续，不根据日志中的“已完成”标记跳过校验。不持有或输出 client secret，不自动重试写入。

新操作器必须先调用此模块，再调用 v1.93 混合快照数据收尾。数据侧仍需等待安全窗口、保存原始事实、pending job 先恢复、带精确数量/行值守卫执行一次原子 batch；本轮没有修改该算法。禁止用这个仅针对测试身份的流程推导真实客户退款或补造账目。

## 验证与保留的失败

最终新增 44/44 项本地检查通过，与原有 869 项合并为 913/913；失败、取消、跳过均零。本机 Node 24.14.1；新增 CI 指定 Node 22/24，但 Node 22 和远程 CI 尚未执行。

测试覆盖：8 个写入位置的写前失败/写后确认丢失、10 个持久检查点失败、两入口先关闭、两策略解除引用后再删除、精确 token-create ACK 丢失恢复、令牌已缺席、重复只读收尾、错误域名/audience/策略/令牌归属、无关令牌及设置保留、检查点不泄漏密钥。网关身份漂移时保留禁用的共享令牌，不贸然删除；不完整推理请求元数据不阻碍 Access 关闭。

第一次本地 43/43、合并 912/912 虽通过，但第一次只读实连在第 3 次 GET 暴露了测试夹具和实现共同使用错误策略名称的问题：控制策略实际是 `CinaToken recovery staging closed`，网关才是 `CinaToken staging closed`。只读适配器禁止一切写入，失败没有改动云端。随后修正两处控制策略常量，补一项“保留不同已部署名称”回归，重新执行最终 44/913 项测试。第一次测试报告标为 superseded，不能充当最终源码验证。

修正后的双入口 closer 再经只允许四条固定路径、最多 12 次 GET 的适配器实连，10 次只读 GET 通过：确认现有关闭状态不需要任何写入。这个观察不是开启状态下的云端写入/ACK-loss 测试；后者目前仍只有本地 API 状态机注入证据。

[机器证据](./C02-images-sse-snapshot-preparation-results.json)保留两次只读记录、最终测试、初始 superseded 测试、冻结发布输入与上轮依赖。按照 Wrangler 技能核验实际安装版本/schema/生成绑定，并按 Workers 最佳实践保持私有绑定和请求流所有权；没有放宽生产入口或把离线 dry-run 当线上验收。参考 [Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/)与 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

## 下一步与费用边界

下一步编写并审查有界六类故障操作器，整合双入口关闭与混合事实原子收尾，再重新检查云端状态/预算及恢复探针控制行；只部署冻结 gateway 候选并核对云端内容摘要。随后运行真实 Workers 的 INSERT 前失败/前后暂停、提交后 ACK 丢失、snapshot/job readback 失败及 15 秒交付确认，独立消费者只恢复已有快照并验证去重。不重新调用模型补账，不把 intent-only 当作可退款事实。

本轮 Cloudflare 管理 API 总计 42 次（预检 29、首次名称差异 3、修正后只读关闭核验 10），云端写入/部署/迁移/删除均零，公开 HTTP 新增零、首轮累计仍 292；模型/KMS 累计零。首轮 US$2 上限不重置。180 条账户级 billable usage 中，Workers/D1 可见记录 ContractedCost 为零，但记录有延迟且不等同于项目级最终增量账单；其他账户服务存在费用，不能据此宣称全账户或本轮实际花费为零。

最新实际部署仍为 v1.91；本轮只是重核现状。云端快照故障矩阵、提交中取消、原生平台终止、完整跨消费者恢复/物理容量与 C02.G 仍开放；本轮不改生产账务和 completed + 实际上游 DONE 的不可逆成功政策。
