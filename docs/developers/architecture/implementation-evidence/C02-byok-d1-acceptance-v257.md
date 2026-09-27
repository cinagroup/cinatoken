# C02 v257：D1 验收程序与关闭状态复核

2026-09-16，Checklist v1.156。状态：**本地验收程序通过，真实 D1 BYOK 验收尚未执行**。没有修改产品逻辑、迁移、依赖或云端部署；C02.G / C01 保持开放。

## 本轮结果

新增 `packages/proxy/scripts/staging/byok-d1-acceptance.ts`，直接调用当前 `createByokKeysRepository(createD1DatabaseClient(db))`。记录 batch 元数据的包装只转发原语句，不改 SQL、不拆事务、不插入时钟语句。它没有 HTTP handler、自动部署、远程连接或导入副作用，不能直接作为线上验收入口。

10 个固定场景：

| 场景 | 验收条件 |
| --- | --- |
| changes-contract | 同 batch 写入一行后 `changes()=1`，零写入后为 0 |
| compact-management / compact-portal | 100 槽删除第 49 项后补位，99 个旧项顺序与元数据保留，墓碑不变，恰好两条审计 |
| full-old-id | 满额时使用旧 ID 和相同时间戳，零写入、零新增审计 |
| expired-first | 数据库时钟下已到期的管理 Key，增改删排全部拒绝 |
| insert-rollback / audit-rollback | 分别触发 label CHECK 和审计外键错误，补位前状态完整保留 |
| crud-management / crud-portal | 增改排删返回值、顺序、密文清除、审计事件及主体完全核对 |
| concurrent-last-slot | 两次仓储调用争用最后一槽，恰好一个成功；两次操作都结束后才返回 |

每场景最多 100 条初始凭证；seed 为普通 INSERT，不覆盖已有测试实例。测试只用无效合成密文，不发放可用的管理凭证。输出不包含密文或 SQL 参数。网络异常不能冒充预期约束回滚。清理函数只面向固定命名的合成对象，仍要求外层操作器先证明停写、完整数据归属和安全窗口；它不是通用删除工具，也尚未获线上执行验收。

## 证据范围

新增 19 项本地测试，以原始 68 个 D1 迁移建立 SQLite 数据库，验证全部场景、跨场景隔离、重复执行拒绝，以及 `changes()` 错误、漏审计、元数据破坏、并发迟到操作等反例。源码版和浏览器 ESM 打包版分别执行同一套 19 项；这两组不累计为独立覆盖。打包模块约 330 KB、没有外部导入，没有 HTTP 入口。它不是 Wrangler 发布 dry-run，也不是 workerd 执行证明。

另重跑 BYOK 专项 204 项及 Images SSE 成功结算/交付 41 项；staging TypeScript 检查通过。没有重跑完整 npm hooks、全部 dispatch 或远程 CI。各套件重叠，不相加宣称独立覆盖。

最初有相对导入路径错误和泛型转发类型错误，已修正。首次浏览器打包因 esbuild 解析最终未使用的 PostgreSQL/MySQL 工厂中的 Node 内置模块而失败；保留 `local-final/browser-module-build.log`。随后允许构建期解析内置模块名称，并严格要求最终输出外部导入为空；不是把无法运行的依赖留给 Workers。最终以 `local-recheck/result.json` 为准。

## 真实云端只读复核

首次沙箱 GET 在 HTTP 响应前失败，无状态码，不能据此断言云权限缺失。限定范围的只读网络重试成功：42 次管理请求 ACK，D1 读取 674 行、写入 0 行。两次共计 43 次已记录请求尝试；没有公开 Worker 请求、部署、模型或 KMS 调用。

2026-09-16T04:43:08.731Z 复核：四个 staging Worker 版本/配置与基线相同，workers.dev 与预览关闭、无域名/cron；两个 Access 应用 deny-all；既有临时令牌和 tail 均不存在；D1 56 表计数、295 schema 对象摘要匹配；三个生产 Worker settings 摘要未变。Gateway 仍是 v232 历史部署，不含后续本地修复。

账单响应包含截至 2026-09-16T00:00:00Z 的 Workers/D1 记录，所选 `ContractedCost` 均为 USD 0；**不是最终增量账单或实时费用证明**。首轮累计 US$2 不重置，原有 US$1.20 历史/延迟用量预留与 US$0.80 未分配预留保持，未创建新资源或订阅。公开 HTTP 累计仍 422。

## 后续有限顺序

1. 接入既有 staging Worker 的受保护、一次性入口及操作器：固定 case/run 范围、短期授权、先留存 PENDING、未知结果不重放、并发操作全部收尾、调用/读写/费用上限。
2. 接入全 56 表基线、实际行归属、原子清理和不确定写入隔离；验证所有故障路径后，冻结新的构建、配置、绑定类型与回滚/关闭计划。不得重用 v231/v232 已消费的执行目录。
3. 再做当次隔离/账单预检，仅复用独立 staging Worker/D1；在 US$2 原上限内明确分配测试及收尾预留后，执行原生用例并核对部署字节与 D1 回执。
4. 独立关闭入口、回收临时授权、确认无进行中操作、精确清理并复读生产指纹/表计数。原生结果单独记录，不能把 REST 或本地 SQLite 结果填进 Worker binding 验收。

**批处理中途真实时钟到期仍未证明**。`expired-first` 只测第一条实际写入前已到期；v256 的语句间到期测试使用模拟 SQL 时钟。不得用额外 DML 插入故障注入改变 `changes()` 再声称原始 batch 通过。真实 MySQL/PostgreSQL/Hyperdrive、跨会话/请求竞争、Workers 容量及 C02 其余门禁继续开放。

Images 结算规则未变：有效 completed 图片和真实上游 `[DONE]` 是不可逆成功点，先持久化结算事实再交付成功 DONE，之后客户端取消不撤销费用。仅 completed、尚无上游 DONE 不按成功处理。

[机器证据](./C02-byok-d1-acceptance-v257-results.json)。本地复测：`node --import tsx --test packages/proxy/scripts/staging/byok-d1-acceptance.test.mjs`；此命令不访问云端。

参考：[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)与 [D1 batch 官方语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)。使用原生 binding、完整等待操作、保持原子批次；文档语义本身不代替本项目的线上验收。
