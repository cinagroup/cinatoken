# C03：BEGIN 归属与迟到 drain 隔离（v298）

日期：2026-09-21。状态：**LOCAL_CANDIDATE_PASS / INSTALLED_DRIVER_FAIL / ACTIVATION_BLOCKED**。前轮 v297 分类为 progress：实现和验证了断连 scope 退役，但未覆盖 BEGIN 准入。

本轮扩展同一版本/源码摘要限定的隔离候选，补齐已复现的 BEGIN pipeline / 背压短路及迟到 drain 问题。现用 postgres.js、两份锁文件、生产 factory/默认解析入口均未切换；没有部署。C03 DOING、C01.G / C02.G / C03.G、Workers 首发优先及 US$2 累计限制保持不变。

## 新证据与修复

### BEGIN 已写出，但 reservation 未登记

安装的 postgres.js 3.4.9 在 `execute()` 中先调用 `write(toBuffer(q))`，之后才在一串 `&&` 的末尾调用 `onexecute`。pipeline 到限或写入返回 false 会跳过登记；false 是接收字节后的背压信号，不是“没有派发”。v297 候选保留了这部分原实现，因此新测的 capacity 0/1/2 与两项接受字节后返回 false 的背压场景 **0 PASS / 5 FAIL**。

候选现在先保留 write 的返回值，再执行符合原 describe/cursor 条件的 hook，最后计算容量条件。hook 仍可返回 falsy，BEGIN 的 hook 正是如此；不能把它改为恒 true，否则普通查询会进入该事务连接的 pipeline。序列化/同步 write 抛错不进入 hook；本轮没有完整测试同步 write 抛错后的全部清理行为，不宣称该路径安全。

### 迟到 drain 不是释放事务连接的凭据

进一步发现：仅调整 hook 顺序时，连接已登记 reservation，但回调等待期间 `query` 为空。旧 `drain()` 只检查 `!query` 就调用 `onopen()`，会重新向根查询开放连接。

完整候选增加 `!connection.reserved` 检查。保留“只有 hook 修复、没有 drain 检查”的负对照构建；ESM/CJS 均实际失败，普通查询被提前送入仍处于事务状态的连接。该负对照已纳入可重复的测试命令，必须观察到指定失败原因及 exit 1 才算验证器通过；**不把负对照的失败记成业务通过**。

v297 的断连退役补丁继续生效：旧 callback/内部 COMMIT/ROLLBACK 不得借重连连接继续。资源状态仍独立记录，断连后仍为 unconfirmed；本轮没有凭这些检查自动释放保留容量，也没有重发推理。

## 夹具真实性与边界

真实 Node postgres.js 使用 loopback TCP 协议 peer；不执行 SQL、不验证 TLS/认证/Hyperdrive。为支撑 pipeline 检查，peer 在暂停 ReadyForQuery 后按 FIFO 保留所有后续协议帧，构造帧时固定当时的事务状态，不让 BEGIN 的完成帧越过之前查询的回复。保留原“CommandComplete 不足以释放 owner”检查。

背压用例通过驱动的实例级 socket 扩展点转发真实字节，并对大于 1 KiB 的 BEGIN **合成一次 false 返回值**；迟到 drain 由测试显式触发。这证明驱动对该合法事件顺序的隔离行为，**不是 OS 内核拥塞压力测试或 Workers TCP 验收**。没有修改全局 Socket 原型。参数描述最多 4 项、协议缓冲有界，所有数据库标识/参数为 synthetic。

## 验证结果

| 验证 | 结果 | 说明 |
| --- | --- | --- |
| v297 新边界负对照 | 0/5，exit 1 | 保留 undefined connection 等真实失败 |
| 完整候选 ESM / CJS | 各 26/26 | 每分支 23 种场景，原三项基线在两个文件中各运行一次 |
| 完整候选重复 | 两分支各 3 轮，156/156 次执行 | 不另算新场景 |
| hook-only 负对照 | 两分支各 0/1，exit 1 | 验证器按指定失败判定通过；不是可用驱动 |
| 构建/包装测试 | 5/5 | 包含父测试与子进程验证器，不是 5 项额外业务测试 |
| owner + PGlite runner | 35/35 | 本轮重跑；PGlite 串行模型，不是原生数据库 |
| runner TypeScript | exit 0 | 运行时代码未变 |
| 未修补现用驱动基线 | 2/3，exit 1 | 空 socket 反例仍真实失败，不能启用 |

新增 11 种 reservation 场景：精确 capacity 0/1/2；BEGIN ACK 保留；接受字节后背压、迟到 drain；服务端拒绝 BEGIN；capacity 0/1 的两个排队事务；BEGIN ACK 前断连且不得重发；事务中参数 describe-first 的普通结果及 values 路径。原 12 种退役场景仍运行。

初始构建检查因 esbuild 将 `connection` 重命名为 `connection2` 而失败，未执行 wire；改为同一标识符的约束检查后通过。之后参数用例把驱动的 `Result(0)` 子类与原生空数组严格比较，双分支各 25/26；改为验证结果长度，并保留执行次数、协议顺序和事务状态断言后最终通过。两次夹具错误及中间结果保存在[机器摘要](./C03-postgres-driver-reservation-v298-results.json)。

v297 开始时 4 个文件摘要全部相同；本轮有意修改构建器、构建测试和共享 peer，新建 reservation 测试，原 retirement 场景文件未变。v296 的其余 7 个代码/测试/配置摘要也未变。其他 208 项财务回归本轮未重跑。

## 实现与复现

- [候选构建器](../../../../scripts/db/diag/postgres-transaction-retirement.mjs)：默认 `reservation: 'complete'` 只表示组合两个本轮局部修复，不表示完整生命周期已验收。`hook-only` / `none` 仅用于负对照。index/connection 均校验原摘要，ESM/CJS/CF 两次完整构建一致；其他输入摘要记录但未全部固定。
- [构建/负对照验证器](../../../../scripts/db/diag/postgres-transaction-retirement.test.mjs)。
- [新增协议场景](../../../../packages/core/src/storage/recovery/postgres-transaction-reservation.wire.test.mjs)。

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-transaction-retirement.test.mjs
```

本轮 10 个 `.wrangler/staging/postgres-reservation-v298-*` 本地可再生目录保留；没有调用 Cloudflare staging，也未删除用户或云端数据。测试 socket 与内存 PGlite 均由各自夹具收尾。

## 上游与技能依据

[Issue #1189](https://github.com/porsager/postgres/issues/1189) 报告 BEGIN 的 reservation 短路；新核对到 [PR #1218](https://github.com/porsager/postgres/pull/1218) 已提出 hook 与返回值方向的修复，但本轮读取时仍 Open。不能把上游提案或其评论中的生产报告当成本项目的验收。本轮独立本地证据还覆盖迟到 drain，未声称上游 PR 已处理它，也未向该 PR 写评论或提交代码。

PostgreSQL 最佳实践技能使事务归属与普通池容量分开核对；Workers 最佳实践技能要求 CF 分支同补丁、并保留真实运行门禁。重新读取[官方 Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)，本地类型按 fallback 检查 `@cloudflare/workers-types` 5.20260829.1；没有新增平台 API、Env 或绑定。Firecrawl CLI 不可调用，按技能备用路径只读官方来源，未安装。

## 下一有限步骤

1. 在现有构建体系内实现**默认禁用的候选采用与实际解析入口验证**，检查 Node / Workers 产物确实使用预期源码与补丁；不要直接修改 node_modules、仅靠临时 bundle 或提前全局替换依赖。保留未修补及 hook-only 对照，候选采用不等于激活业务。
2. 原生 PostgreSQL/真实 Workers 的业务事务、并发、锁等待、COMMIT ACK 故障与完整生命周期仍未验收；v292 系统运行库更新许可及复验条件不变，未获许可不安装、不重启、不重试 initdb、不自动接远端。
3. 服务端执行期限、可信资源释放、无损日志、角色最小权限、迁移/保留兼容和整体 C03 仍待完成。同步写入异常、正常结束后逃逸 tx handle、手工事务控制、COPY/cursor 等不是本轮的完整支持承诺。

无云管理/远端 SQL/部署/模型/KMS/系统更新/重启，US$2 不重置，C02 云端原阻塞不变。完整目标保持 active。
