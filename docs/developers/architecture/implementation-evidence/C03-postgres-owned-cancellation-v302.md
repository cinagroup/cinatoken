# C03 v302：可拥有取消传输与目标会话隔离

2026-09-21；**LOCAL CANDIDATE PASS / DEFAULT DISABLED / C03 DOING**。本轮推进 DBL-04，不代表完整恢复生命周期或 C03 验收完成。C01.3 已按用户确认冻结于 [ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md)，不明不重发、同事实恢复和独立状态维度不变。

## 交付

[隔离候选构建器](../../../../scripts/db/diag/postgres-owned-cancellation.mjs)在 postgres.js 3.4.9 原始 index/connection/query 九份源码摘要全部匹配后，才构建 ESM、CJS、CF 三个实验包。依赖、锁文件、共享 dist、生产配置和既有采用插件未改；v302 不会被正常构建或恢复器自动选中。

仅显式 `owned_cancel: true` 的查询拥有新取消能力：

- 派发前独占连接，避免取消命中已排入同一会话的后继 SQL；未启用的查询保留原行为。
- `cancelOwned()` 返回缓存、冻结的结果/close/快照句柄；拒绝立即被观察，但原拒绝仍交给调用者。错误固定化，不在公共快照暴露 PID、取消 secret、SQL 或端点。
- 本地尚未派发的查询可从对应队列移除；已经完成的旧查询不会取消后来查询。
- 活跃取消复制身份并绑定当时的 socket 和端点；辅助连接建立后及实际写包前再次确认主目标。目标已结束则不发旧取消包。
- 接受取消后退役原主会话，当前查询仍可成功；主 ReadyForQuery 后请求关闭目标连接，不关闭共享池，也不向旧事务补发 COMMIT/ROLLBACK。后续工作使用新会话。
- 取消失败、取消连接关闭、主查询结果各自观察；取消写异常即使发生在字节已接受之后，也不重发该字节。

接口状态和限制见[生命周期合同第三节](../postgres-recovery-lifecycle-contract.md#三v302-的取消传输实验边界)。公共 `cancel()` 对显式 opt-in 返回同一结果 Promise；普通查询仍保留安装驱动的旧语义，这不是一个通用兼容替代包。

## 本地证据及边界

使用真实 postgres.js 驱动与有界 loopback 合成协议 peer；后者不执行 SQL，不验证真实后端身份、认证、TLS、WAL、pooler 或 Hyperdrive。25 种新增场景包括本地未派发/排队/连接准备、暖连接独占、旧查询与旧会话、同步及异步 factory 失败、取消连接挂起/超时、写异常前后、异常回包、端点选项变更、参数 Describe 后禁止迟到 Bind/Execute、模式拒绝、事务内部收尾和主断连后迟到辅助连接。另导入三项已有基线，因此每分支显示 28 项。

| 最终验证 | 结果 |
| --- | --- |
| v302 完整 harness | **16/16**，49246.9766 ms（含父测试） |
| ESM / CJS 新取消 wire | **各 28/28**，2438.472 / 2396.1413 ms |
| ESM / CJS 既有事务 wire | **各 60/60**，4302.9738 / 4033.4115 ms；仍为 51 种既有场景 |
| 暖连接旧 v300 候选负对照 | **各 0 PASS / 1 FAIL，预期失败**，856.8928 / 932.2436 ms；真实提前发送 successor，不是缺少新方法的失败 |
| 普通 cancel 旧语义 | 安装驱动、ESM、CJS **各 2/2**；跨分支重复，不算六种新场景 |
| 安装驱动 onclose 负例 | **2 PASS / 1 FAIL**，1086.0292 ms；原空 socket.write 失败保留 |
| owner / supervisor / 原资金 SQL | **62/62**，20007.2635 ms；已有本地 PGlite，非原生 PostgreSQL |
| 恢复器 TypeScript / 四个 JS 语法检查 | 退出 **0** |
| 三入口独立重复构建 | 产物及输入摘要一致；CF **只编译，未执行** |
| 保护输入与历史源码 | 16 个保护输入不变；v301 九项不变；v300 七项中六项不变，一项共享 wire fixture 有意扩展 |

最终报告及各组 TAP：`.wrangler/staging/postgres-owned-cancel-v302-run-UoF6E6/`。[持久机器摘要](./C03-postgres-owned-cancellation-v302-results.json)记录来源和产物摘要。Node 24.14.1 / postgres.js 3.4.9 / esbuild 0.27.3；没有运行完整工厂采用 harness、编译观察入口或 Wrangler dry-run，不能把前几轮证据计为本轮执行结果。

最终三入口 SHA-256：

- ESM：`9435652844ec71ed35ed07ac2d0bffa0ded5a667b72797c63f9189949e447f59`
- CJS：`d15789a995a68f8e72dd4e6f3dde2c8ccab63d5764df6e43665d412b7c984180`
- CF：`cb513cd0645f0690f6001ce7d7aa779d333c9e7c3585f20c600302735b066ce1`

复跑（只使用现有本地依赖，测试自行建 loopback peer）：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-owned-cancellation.test.mjs
```

需要已有 PGlite 缓存，或通过 `GATEWAY_PGLITE_MODULE` 提供已有本地路径。不会安装、启动原生数据库或自动连接远端。测试父级 120 秒、子进程 45 秒、类型检查 20 秒仅是有限本地验证预算，不是生产 SQL 时限。

## 保留的失败与修正

1. 两次初始构建因 Query 的 reject 源码锚点不唯一而拒绝输出；收紧到构造器上下文后构建通过。
2. 初始 15 项通过；扩展到 28 项时出现 **23 PASS / 5 CANCELLED**：四个不支持的模式在占用连接后拒绝，后续查询被卡住；移到准入前校验。另一个 reserve 用例从冷连接开始，改为先建立普通会话后验证保留句柄，未宣称修复原驱动所有 reserve 行为。
3. 第一轮完整 harness `...-5vlFwf` 为 **11 PASS / 3 FAIL / 2 CANCELLED**。负对照使用冷连接，未能制造真实 pipeline；改为暖连接。SQL 子进程的 25 秒期限被触及，父级 60 秒随后在类型检查阶段到期；没有将截断结果计为通过。
4. 修正后 `...-lheFD3` **16/16**，49286.9965 ms。随后仅增加本地测试预算余量，最终 `...-UoF6E6` 再次 **16/16**；旧日志与候选目录保留。

## 不可越过的门禁与下一步

PostgreSQL 取消没有直接成功回应，主查询仍可能成功；取消连接关闭不证明原 SQL 停止，断开连接也不保证非 SELECT 没有提交。[官方协议](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS)

按 Workers 最佳实践技能分开异步工作拥有权与运行时验收，并读取已安装类型和 CF polyfill。发现 CF 的 error 路径会合成 close，destroy 丢弃原始 close Promise；因此本轮只称 `close_observed`，不把它当作真实物理释放。Workers 测试为 **0**，原生 PostgreSQL 测试为 **0**。[Workers 官方异步生命周期要求](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

应用 operation owner/观察器尚未登记取消辅助资源，采用插件仍使用 v300；任意 SQL/COPY、Query 派发后变更、不受控 factory、多端点/TLS/认证/Hyperdrive 均不在已验证范围。DBL-04 下一步先落实受控模式合同、默认禁用接线与独立取消资源登记，再推进 DBL-05 全路径服务端时限、DBL-06 可信资源解除，最后取得 DBL-08 真实运行时证据。不能让 holds 永久占满却宣称恢复服务完成。

v292 Windows 系统运行库升级许可仍未取得：本轮不安装、不重启、不重试 initdb、不以远端数据库代替。无损日志、最小角色、迁移/保留期、资金/授权政策、完整容量、C01.G / C02.G / C03.G 与既有云端解阻条件均保留。

Firecrawl CLI 未发现，未重新安装；公开资料采用官方网页回退。云管理、远端 SQL、部署、模型、KMS、资源增删、系统更新均 **0**；首轮累计 **US$2** 不重置。完整目标仍在进行。
