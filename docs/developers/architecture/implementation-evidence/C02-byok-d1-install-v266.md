# C02 v266：原生围栏安装入口与主机单次调用

2026-09-20，Checklist v1.165。LOCAL_PASS / STAGING_PARTIAL。实现及离线验证完成，未部署、未在云端安装围栏或开启独占阶段；C02.G / C01 未通过。

## 固定安装链

已有 staging gateway 增加唯一 `install-fence` 命令，复用既有原生 Access audience 校验、固定 origin、空正文检查和 waitUntil 生命周期登记，不新增 Worker、数据库或服务绑定。安装命令共享用例负载槽，STOP 保持独立；既有十用例的持久控制合同不变。

新增 `BYOK_GATEWAY_INSTALL_GRANT` 部署变量，默认空值禁用安装，整个 gateway 仍默认 disabled / workers.dev 与 preview 关闭 / 无 route 或 cron。短期 grant 只含本次 run、独立高熵 bearer 的 SHA-256、安装前后 schema 摘要及最长 900 秒时限，不含明文 bearer。安装请求不能传 SQL、目标数据库、schema 正文或新 grant。主机冻结的云候选须使用实际云 schema 计算前后摘要，不能复制本地 SQLite 摘要。

原生模块先登记生命周期，再校验 bearer 摘要，按数据库时钟校验 grant，复用原 56 表完整基线捕获并确认历史管理凭据已撤销。读取 schema 的 SQL 定义与总量有界；写前独立推导仅增加固定十五个触发器后的 schema，验证摘要及 512 对象 / 256 KiB 读取上限。

实际安装仍为 **一个原生 D1 batch、17 条语句**：原有第一条精确 schema / 五表为空 / 无旧控制和围栏的 guard 加入数据库时间有效期条件，随后十五条固定 CREATE TRIGGER 和关闭标记 INSERT。没有 REST DDL，没有 drop/reset/repair/重开动作。原生 promise 不做超时竞争；提交后客户端断开仍继续读回 schema 和关闭标记。成功路径共 41 次 SQL、9 次原生调用，行元数据经过现有预算 guard 验证。此计数是实际本地链路证据，不是云端套餐资格证明。

数据库 guard 最多允许成功安装一次；它不提供安装前失败尝试的持久 claim。**失败或不明结果禁止重发由固定主机排他日志和完整操作器承担**，不能把“没有围栏”理解为可安全重试。已经提交但 ACK/读回失败时保留关闭围栏，不自动拆除或修复。

主机新 `byok-d1-install-dispatch.mjs` 只发送固定空 POST。要求 preflight、closure-before、Access/入口开启 ACK 与可信准入守卫，禁止在 baseline/arm/STOP/seal 后调用；发送前 `install-fence` PENDING 刷盘。响应最多 2 KiB / 128 次读取 / 30 秒，校验完整回执、前后 schema 摘要及固定计数；HTTP、正文、回执或日志不明都不可跨对象重发，迟到响应只释放。HTTP 成功后仍须由上一轮管理适配器独立捕获关闭围栏基线，不单凭 HTTP 回执认定安装完成。

## 验证

- 最终新增源码 **52/52**，安装入口及主机打包复测 **52/52**。
- 相关回归 **589/589**：gateway 源码/打包各 41，管理适配器 40、主机用例 42、日志 18、maintenance 调用 22、关闭观察 28、管理传输/时钟 63、清理控制链 72、一次性处理器 29、围栏 36、清理 40、空正文 76、Images SSE 41。
- staging TypeScript、Wrangler 绑定生成/校验、模块隔离及实际离线 dry-run 通过。使用 Wrangler 4.127.1，固定原账户/Worker/D1，未 provision。
- 覆盖鉴权和空命令拒绝、生命周期登记失败零 SQL、无效时限/基线、批次开始前到期和数据漂移、DDL/标记插入失败全回滚、批次提交后丢 ACK、提交后读回失败、断开前后边界、两个 gateway 对象竞争，以及主机 journal → gateway → 固定管理适配器 → 首个原用例的本地贯通。
- 安装后 schema 超界在发送 DDL 前拒绝。局部负载槽、Node/SQLite 竞争、模拟 REST/Access 均不是原生 Workers/D1 并发或隔离证明；本轮没有执行原生用例或证明批次中途到期。

初次直接预检查 51 项中 48 通过、3 失败，均为测试夹具错误（两处用户缺少必填 email，一处 unixepoch mock 参数个数错误）。原测试源码与说明保留，完整输出在任务工具记录，没有伪造本地 TAP。修正夹具后源码/打包各 51 与全部回归/类型/dry-run 通过；随后补安装后 schema 上限，最终各 52 项与完整回归重新验证。各正式运行目录和旧源文件均保留，不覆盖旧结果。

机器证据：[v266 清单](./C02-byok-d1-install-v266-results.json)。最终回执 `.wrangler/staging/byok-install-v266-local-final/result.json`。实际 Node 24.14.1；离线 es2022 bundle 不是 Node 22 运行验证。历史 11,469 条普通摘要及六条链接记录核验，变更前五个已冻结文件归档，新清单映射旧路径，不重写旧 manifest。实际工作区 BYOK 执行占位未创建。

## 技能与证据边界

按 Cloudflare / Workers best practices 使用原生 binding 和提前 waitUntil 登记，按 Wrangler 技能重新生成 Env 并做默认关闭的离线构建。核验了[官方 Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[原生 D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)及[原生 Access 上下文](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。Firecrawl CLI 不可用，直接查官方文档；类型校验使用本地 Wrangler 生成绑定和已归档 5.20260916.1 类型参考，不声称取得本日最新类型包。未采用参考文件中的自动创建资源建议或不可靠的 session timeout/close 示例。

本轮云管理请求、部署、生产写入、模型/KMS 均 0；未重复 v264 的代码下载。最后完整云观察仍 v257（2026-09-16T04:43:08.731Z），v264 的部分观察不升级为完整准入。公开 HTTP 累计 422，首轮累计 US$2 不重置，US$1.20 历史/延迟预留及 US$0.80 未分配预留保持，最终账单及实际套餐资格尚未确认。

## 后续有限顺序

1. 接固定资源部署与 Access/入口启闭适配器，将安装、基线、用例、STOP/封闭、许可、清理和最终独立核对组成完整一次性操作器。
2. 处理关闭观察的 55 次顺序请求时限及独占结束后的受控恢复；不自动拆围栏、恢复其他实验或清理未知/失败样本。
3. 冻结完整候选并取得当次完整代码/版本/隔离/实际套餐/预算预检，才在已授权的独占 staging 阶段执行一次原生验收。不跳过 v264 的完整代码读取失败，不自动升级套餐。
