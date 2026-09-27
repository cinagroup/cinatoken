# C02 — 显式耐久 SSE staging 候选与精确收尾

2026-09-08；Checklist v1.89。状态：LOCAL_PASS / CANDIDATE_PREPARED，未部署，C02.G 不关闭。

承接 [v1.88 成功结算点修复](./C02-images-sse-settlement-window.md)：有效 completed 图片及真正上游 DONE 构成不可逆成功，之后取消不撤销费用。本轮不再修改运行时收费规则；增加独立 staging 入口，显式启用 `imageUsageRecovery: { settlementLeaseSeconds: 30, streaming: true }`，并准备相应测试数据收尾模块。

## 候选与隔离边界

新入口 `packages/proxy/scripts/staging/images-sse-durable-gateway.ts` 复用共同 Worker handler 和私有 Images service binding。旧 staging 入口、生产入口及默认 streaming=false 行为不变。

离线配置仅将已冻结 v1.85 gateway 配置的 main 指向新入口：固定 staging Worker、独立 staging D1、私有 upstream，workers.dev 与 preview 关闭、routes/Cron 为空、CPU 上限 1000 ms；没有新建云资源或写入真实密钥。Wrangler 4.127.1 的绑定类型生成、类型一致性检查、禁止自动配置/资源创建的 dry-run 及 staging 类型检查均通过。

首次准备脚本在上述五步成功后，因把 esbuild 相对路径误当仓库相对路径而收集失败。原 FAIL artifact 未覆盖；独立 finalizer 以候选配置目录解析路径，逐一校验 779 个文件输入的大小/摘要，另列 14 个虚拟内置模块，并校验输出大小、入口、配置及源码摘要。虚拟模块不是可散列的本地文件。机器记录见 [结果清单](./C02-images-sse-durable-candidate-results.json)。

## 精确收尾合同

`scripts/deploy/staging-sse-durable-reconciliation.mjs` 仅用于合成 staging fixture，不是账务数据保留策略或通用清库工具；自身不加载凭据、不实现网络调用、不重放推理。

1. 先复用既有 Access 状态化关闭流程，核对固定 D1 身份并撤销精确测试 key，再检查静默等待时间。等待时间不能替代结算完成证据。
2. 限定同一 run 的最多九个唯一请求及九类已知模式；同时按请求、用户和 key 查找额外记录。出站意图、快照、恢复任务、提交回执、日志及预算预留必须齐全；只接受已 committed 的任务。pending、blocked、只有 intent、缺失或多余记录均拒绝清理。
3. 核对快照摘要、上下文/认领身份、租约回执版本、日志状态/金额/图片数/尝试数和 fixture 预算。容量拒绝的日志费用为零，但预留预算保守消费 100,000 micros；两者分别断言，不把预留消费伪装成已定价日志费用。
4. 删除前必须持久保存观察证据。删除批次以计数和所观察字段的条件断言防止观察后变化；随后在同一原子事务内删除对应恢复记录、终态预留、探针和 fixture。中途失败全部回滚；提交后丢确认可从空状态续跑并核对命名对象消失。

调用方仍必须负责四个 Worker 的入口/自定义域名/Cron/版本检查、生产指纹、真实远端 schema/全表基线、持久证据存储和费用记录。该模块只直接管理 gateway 的固定 Access 范围，不能替代完整发布编排。当前九模式 journal 不支持重复模式或额外 DONE 后故障矩阵；扩展前需补对应精确观测和收尾合同。

按 [D1 batch 原子语义](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)设计事务；测试检查安全用例每条语句不超过 100 个绑定参数及 100 KB SQL，参见 [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。本地 SQLite 不能证明真实 D1 管理 API 的整批大小、耗时及返回行为已通过。

## 验证范围

- 新增 **30/30**：九类真实路由到耐久结算再到全表计数基线恢复；14 类坏观察拒绝及父测试；保存失败、观察后金额变化、删除回滚、丢确认重试、错误数据库和未静默六类安全检查。
- 与 v1.88 的 746 项合并运行，最终 **776/776**，失败/取消/跳过均零；真实共同 handler、本地 SQLite 和私有合成 transport，禁止外网 fetch。
- 保留两轮测试失败：SQLite 行对象原型差异导致首次 9 项失败；修正后容量拒绝预算字段误判导致 2 项失败。修正仅涉及新收尾模块断言；最终完整复测通过。
- 新增独立 CI 配置，计划在 Node 22/24 执行本地合同测试；本机仅 Node 24.14.1 实跑，远程 CI 与 Node 22 尚未验收。

Workers best-practices 技能用于保持流式交付与后台结算的边界，Wrangler 技能用于核对独立配置、生成绑定类型及离线构建。没有把离线打包或 Node 样本升级为 Workers 验收。

## 后续有限顺序

1. 只读重新核验实际云端隔离状态、当前版本、生产指纹、schema/全表基线及累计费用；最近云端观察仍是 v1.86，本轮未重新读取。
2. 将候选接入固定范围发布/证据编排，先运行九模式真实 Workers + D1 闭环，再关闭入口、回收临时凭据并精确恢复测试基线。不得直接用旧清理模块删除新耐久记录。
3. 扩展并验证 DONE 前持久化、DONE 后取消竞争、实际平台终止、恢复和去重故障矩阵；只有 dispatch intent、没有快照时仍须保留不明结果，不自动重放或编造费用。
4. 完成物理容量及其他 C02.G 项后才评估启用正式配置；本候选不代表完整 SSE 恢复或生产可发布。

本轮无部署、Cloudflare 管理写入或模型/KMS 调用；首轮公开 HTTP 累计仍为 275，模型/KMS 累计 0。新增费用累计上限 US$2 不重置，最终增量账单未核验，不能据此报告实际零费用或完整剩余预算。
