# CinaToken：独立 Cloudflare staging

当前执行状态（Checklist v1.185，2026-09-21）：[准入阻塞审计 v288](../../developers/architecture/implementation-evidence/C02-byok-d1-blocker-audit-v288.md)将 C02.B2.2 当前路径记为 **BLOCKED**，等待权限 / 资源范围与供应方覆盖、累计预算等外部事实。已复核 v287 的 80 项、v285 的 7 项直接产物和八个守卫，真实执行预约仍不存在；未重跑测试、未访问云端。所有既有成果保留，但不以继续增加本地测试代替准入。累计 US$2、5/10/15 秒与生产隔离不变；完整目标和未通过项未删减。

最新接续（Checklist v1.184，2026-09-21）：[CPU 配置与回读 v287](../../developers/architecture/implementation-evidence/C02-byok-d1-cpu-setting-v287.md)将三份替代候选及上传 metadata 固定为 `cpu_ms=30000`，回读不符 / 后续依赖漂移即停止，旧指纹拒绝。最终 373 项、三份 dry-run / 绑定类型及 staging TypeScript 通过；Windows workerd 运行时类型生成崩溃被保留，采用项目既有绑定类型生成方式，不等于原生运行通过。官方允许偶发 CPU 超限，配置不提供严格费用封顶或 SQL 取消证明；完整费用 / 权限 / 排他 / 时序准入仍缺，执行前须重新冻结当前候选。无云管理 / 写入 / 部署 / SQL / 模型 / KMS，八个维护守卫、5/10/15 秒和累计 US$2 不变。

最新接续（Checklist v1.183，2026-09-21）：[累计预算计算 v286](../../developers/architecture/implementation-evidence/C02-byok-d1-budget-assessment-v286.md)使用精确微美元及逐项向上取整，覆盖历史 / 其他未结预留、执行 / 失败收尾 / 保留期；最终 310 项验证通过。算术足额不是可信成本上界或持久预算预留，不能进入操作器准入。发送前 D1 扫描 / 写入上界、全调用链 CPU / 日志和保留期成本仍须证明，旧零账单与 US$1.20 / US$0.80 预留不能顶替。无 Cloudflare 管理 / 云写入 / 部署 / SQL / 模型 / KMS，仅两次公开官方价格页抓取；八个维护守卫、5/10/15 秒和累计 US$2 不变。11 个 Zone / Pages / Dispatch、排他及原生时序仍缺，不部署。

权限补记（v285，2026-09-21）：响应新确认完成[路由只读复核](../../developers/architecture/implementation-evidence/C02-byok-d1-route-permission-v285.md)，19 次 GET 仍为 6/17 Zone 可读、11 个 403。拒绝消息为 `No access to the specified resource.`；已读 28 条路由无四个 staging 目标，不代表全路径已排除。需当前所修改 Token 的权限及 Zone 范围脱敏截图，不要提供 Token 或增加 Write 权限。无新事实不再重复失败查询；业务代码、八个守卫、5/10/15 秒及 US$2 上限未变，无云写入 / 部署 / SQL / 模型 / KMS，完整准入仍不放行。

最新接续（Checklist v1.182，2026-09-21）：[只读预检证据收集 v284](../../developers/architecture/implementation-evidence/C02-byok-d1-preflight-evidence-v284.md)绑定同次候选 / observer scope / 来源 / 实际预检 bundle，组合旧代码归档与套餐观察；最终 185 项本地验证通过，真实冻结实现接线为 19 次合成 GET，真实云调用 0。部分证据不能进入真实操作器放行，独立只读目录不消耗项目执行预约；本地 60 秒复查窗口不是云端新鲜度或原生维护资格。仍缺完整调用路径、排他、累计预算、原生时序及完整 preflight / assertReady 提供器；11 个 Zone / Pages / Dispatch 外部事实未补，不重复失败查询、不部署。八个维护守卫、5/10/15 秒与累计 US$2 不变，未刷新实际账单。

最新接续（Checklist v1.181，2026-09-21）：[候选来源固定 v283](../../developers/architecture/implementation-evidence/C02-byok-d1-source-freeze-v283.md)新增两阶段本地冻结组件，最终 314 项验证通过；三份 Worker 两轮 dry-run、操作器真实 bundle 和候选字节均已检查。固定 440 个已存在文件 / 270 个缺省配置路径、pnpm 工具别名与主机 / Worker 两份实际 esbuild；测试夹具的字符串换行规范化问题已修正，旧源码和失败记录保留。本机完整复查样本 356.247 ms，不代表时序资格；八个维护守卫、5/10/15 秒未变。仍需接通同一次候选身份的完整只读证明提供器，不能凭来源哈希或过期合成 grant 部署。11 个 Zone / Pages / Dispatch、独占 / 预算和原生验收未过；无管理 API / 云写入 / 部署 / SQL / 模型 / KMS，US$2 不重置。

最新接续（Checklist v1.180，2026-09-21）：[Zone 路由权限复核 v282](../../developers/architecture/implementation-evidence/C02-byok-d1-route-permission-v282.md)响应新的权限确认，逐一读取 17 个 Zone 并前后核对目录；19 次管理 GET，仍 6 个可读 / 11 个 HTTP 403。已读 28 条路由未指向四个 staging Worker，不能扩展到未知列表。当前进程与 Windows User / Machine Token 比较一致，仅保存布尔值；下一步需权限名称 / 资源范围脱敏截图及成员权限核对，不增加 Write 权限，不重复无新事实的失败请求。错误详情投影校验未通过，保留状态 / 哈希并披露限制；38 条操作日志链、六项本轮产物、v281 的 20 项直接产物及八个维护守卫核对通过。未改业务代码、未重跑业务 suite；无云写入 / 部署 / SQL / 公开 Worker / 模型 / KMS，5/10/15 秒与 US$2 不变，完整预检及原生验收继续不放行。可继续本地来源冻结与只读预检接线。

最新接续（Checklist v1.179，2026-09-21）：[实际套餐只读组件 v281](../../developers/architecture/implementation-evidence/C02-byok-d1-paid-plan-v281.md)以固定四次管理 GET 核对账户配置 / Workers Paid 订阅；216 项源码 / 打包 / 相关回归通过，真实 4/4 GET、6,989 ms。产品 ID、account scope、Paid 状态及有效期间双轮一致；只证明观察时点已有有效套餐，既不新增 US$5 订阅费用，也不证明预算余额或完整准入。完整操作器证明提供器仍未接通，11 个 Zone / Pages / Dispatch 及独占、预算、原生时序继续待补。无云写入 / 部署 / SQL / 公开 Worker / 模型 / KMS；原有八个维护守卫、5/10/15 秒及累计 US$2 不变。可继续同一 C02 的本地来源冻结和只读收集接线，不能以组件通过触发部署。

最新接续（Checklist v1.178，2026-09-21）：[Pages 定点核验 v280](../../developers/architecture/implementation-evidence/C02-byok-d1-pages-targeted-v280.md)完成 32/32 管理 GET，六个选定项目 production 目录前后稳定；五个新增版本及 cinaseek 两个旧版本详情未见 staging 目标绑定。旧 active 部署详情仍未给出终态；没有权威 Pages→Worker 版本映射，不把候选或局部目录升级为完整覆盖。供应方问题已整理为本地草稿、未外发；11 个 Zone 权限和 Pages / Dispatch 语义仍需解决。不得使用历史快照 / 合成布尔值顶替完整当次预检；先补外部事实并接入证明收集，再满足原生维护时序与 BYOK 验收。未改业务源码、未重跑业务 suite；无云写入 / 部署 / SQL / 公开 Worker / 模型 / KMS，5/10/15 秒及累计 US$2 不变。

最新接续（Checklist v1.177，2026-09-21）：[Pages 生命周期 v279](../../developers/architecture/implementation-evidence/C02-byok-d1-pages-lifecycle-v279.md)完成 19 项目 / 1,565 部署双轮核对，182/182 GET，369 项本地验证通过。此前 149 条未跳过未知部署中 148 条记录为部署前失败 / 取消，1 条旧记录仍 deploy/active；4 条 skipped、2 条时间倒置和四个未匹配预览候选的两轮 404 均不能证明运行时不存在。相比 v277 新增 5 部署、1 条旧摘要变化，v278 的版本绑定快照不能替代当前完整覆盖。两次解析失败与源码均归档，本轮共 274 管理 GET 尝试（259 个 200、9 个 404、6 个无已记录状态）；无云写入 / 部署 / SQL / 公开 Worker / 模型 / KMS。11 个 Zone 路由、Pages 身份 / 缺省语义、当次完整预检及原生验收仍未过，不部署；5/10/15 秒及首轮 US$2 不变。本轮未重复查询已有路由 403。

最新接续（Checklist v1.176，2026-09-21）：[Pages 内部 Worker 版本清点 v278](../../developers/architecture/implementation-evidence/C02-byok-d1-pages-worker-v278.md)已读取 14 个可列内部名称的 365 版本绑定，全部 38 个名称前后核对，另 24 个名称 404 仍未知；不按当前 Functions 标志或预览开关过滤。445 次清点 GET、276 项本地验证通过；含探测本轮 455 GET，无云写入 / 部署 / SQL / 公开 Worker / 模型 / KMS。与 v277 目录有 361 条唯一候选关联，但 4 个预览版本无目录匹配，149 条未跳过且 Functions 未知的部署仍需核查；绑定 URL 不是权威身份契约。历史绑定完整性、11 个 Zone 路由、其他来源 / 全预检与原生验收未过，不放行部署；5/10/15 秒及 US$2 累计上限不变。

最新接续（Checklist v1.175，2026-09-21）：[Pages 历史清点 v277](../../developers/architecture/implementation-evidence/C02-byok-d1-pages-history-v277.md)完成 19 项目 / 1,560 部署双轮目录核对，182/182 GET 成功，244 项本地测试通过；历史绑定完整性仍未证明。51 个返回 D1 绑定未匹配 staging，服务 / DO 字段全部缺失且语义待核实，不能当作空绑定。旧部署 uses_functions:null 作为未知保留，首轮失败及针对性反例已归档；本轮共 227 次管理 GET 尝试，无部署 / 云写入 / SQL / 公开 Worker / 模型 / KMS，US$2 不重置。11 个 Zone 路由与其他调用来源、完整当次预检 / 新鲜关闭及原生验收仍缺；不得据目录完成直接部署，5/10/15 秒维护规则未改。

最新接续（Checklist v1.174，2026-09-21）：[版本绑定覆盖 v276](../../developers/architecture/implementation-evidence/C02-byok-d1-version-budget-v276.md)在只读发现预算内完成：879/879 GET、约 5 分 33 秒，69/69 台 Worker 默认环境、403 个所需版本详情及前后核对通过。发现总期限设为最多 10 分钟，但仍最多 1000 请求、4 并发、单请求 20 秒；八个原生 / 主机维护文件与 v273 摘要一致，5/10/15 秒新鲜度未改变。183 项本地验证通过，无部署 / 云写入 / SQL / 公开 Worker / 模型 / KMS。不得将版本覆盖完成解释为独占或完整预检通过：Pages 历史绑定、11 个 Zone 路由权限及其他准入项仍缺；本轮只为 Pages 查询官方文档，未读取账户历史部署。旧失败记录保留，US$2 不重置。

最新接续（Checklist v1.173，2026-09-21）：[版本绑定只读清点 v275](../../developers/architecture/implementation-evidence/C02-byok-d1-version-inventory-v275.md)本地 177 项通过，真实观察仍部分完成，未部署。当前部署必须包含 0% 流量版本；预览开启时按全部分页版本读取实际绑定，不能用当前 settings 或缺失 hasPreview 字段代替。68/69 台 Worker 完成前后核对；cinashop-api 的 168 个预览版本仅读完 154 个，5 分钟期限中止，最终根目录复核未执行。不得使用这份失败样本宣告完整版本覆盖、独占或部署准入。883 次管理 GET 尝试，无云写入 / SQL / 公开 Worker / 模型 / KMS；US$2 不重置。后续校准只读发现预算或调度，与原生 5/10/15 秒清理新鲜度分开；11 个 Zone 路由拒绝及 Pages 历史覆盖等缺口仍在。

权限复核补记（v274，2026-09-21）：[Zone 路由权限明细](../../developers/architecture/implementation-evidence/C02-byok-d1-route-permission-v274.md)确认 17 个 Zone 中 6 个可读、11 个仍 403；cinatoken.com 已成功，但不能把 china-electric.com 等拒绝项视为空路由。进程 / User / Machine Token 一致，全部 Zone active 且未暂停；需核对拒绝 Zone 的资源范围或其他授权限制，不增加 Write / Token 管理权限。仅 19 次管理 GET，无云修改；完整预检仍未通过，不部署、不重置 US$2 上限。此前各版本记录保持为历史证据。

最新接续（Checklist v1.172，2026-09-21）：[维护时序本地修正](../../developers/architecture/implementation-evidence/C02-byok-d1-maintenance-timing-v273.md)通过，未部署。controller 的 Access / workers.dev 在数据库围栏已封闭、gateway 关闭且尚无维护许可时预先准备；随后采用明确的 MAINTENANCE_READY 双轮观察，不称“所有入口关闭”，再签发许可 / 清理。原 5/10/15 秒限制不变，清理 HTTP 前且 PENDING 刷盘后重验准入；旧顺序 18 秒虚拟延迟反例成立，733 项源码 / 打包 / 回归及类型检查通过。首轮令牌名称投影缺失导致的 23 个集成失败及修正前产物保留。真实时序资格仍缺失，完整预检 / 路由 403 / 原生验收未过；禁止沿用旧冻结执行器直接部署。云调用 0、US$2 不重置。

最新接续（Checklist v1.171，2026-09-21）：[staging 调用关系清点](../../developers/architecture/implementation-evidence/C02-byok-d1-inventory-v272.md)取得 69 台 Worker / 19 个 Pages 当前配置及 Queue / Workflow 子集证据，未部署。两条 staging 内部服务关系、三条直接 staging D1 绑定；upstream 也是数据库访问来源，不能只检查三台待替换 Worker。Zone 路由 GET 返回 403，清点器停止并保留失败；用户确认补权后的第二轮仍 403，Token 自检有效且进程与持久值一致，但策略详情不可读；请核对当前 Token 的 Workers Routes Read 与 Zone 范围（包括 china-electric.com），无需 Write / Token 管理权限、不要发送 Token。Dispatch 提示产品不可访问，不自动购买或当作空清单。269 项本地测试 / 类型通过不替代全路径或原生验收；本轮管理 GET 尝试 308、云写入 / SQL / 模型 / KMS 0，US$2 不重置。完整预检、剩余入口覆盖、维护时序和原生验收仍未完成。

最新接续（Checklist v1.170，2026-09-21）：[完整旧代码归档与套餐取证](../../developers/architecture/implementation-evidence/C02-byok-d1-preflight-code-v271.md)通过只读云验证。官方 raw 下载接口的 name-only multipart 已改为精确字节解析，部署后验证同步修正；本地 690 项及类型检查通过。三台现有 staging Worker 的完整代码在 15/15 GET、10.432 秒内归档，前后版本/settings 匹配；已有 Workers Paid 订阅状态和有效期已取证。归档是旧实验代码，不是 BYOK 候选或自动恢复授权；完整预检收集器、全调用路径/预算/数据库基线及维护激活时序仍待接通，禁止直接部署。首轮语义失败与主动截断诊断保留，本轮管理 GET 21 次，云写入/部署/D1 SQL/公开 Worker/模型/KMS 为 0，US$2 不重置、实际增量账单未刷新。

最新接续（Checklist v1.169，2026-09-21）：[有界只读传输与真实关闭观察](../../developers/architecture/implementation-evidence/C02-byok-d1-observer-v270.md)已接入主机编排，未部署。固定 GET、独立 PENDING/ACK 刷盘日志、四通道并行与完整双轮屏障；兼容实际域名接口的成功 `errors: null`，不接受非空/错误类型错误字段。最终本地 600 项及类型检查通过；修复后的独立线上观察 55/55 GET 成功、耗时 21.028 秒，已知 staging 入口保持关闭、生产 settings 摘要未变。原失败观察 17 次加一次结构诊断均保留，累计管理 GET 73 次，云写入/部署/D1 SQL/公开 Worker/模型/KMS 为 0。该观察不证明全调用路径、SQL 静默、完整预检或随后 10/15 秒维护激活窗口；实际预检收集器和原生 D1 验收仍未完成，不凭本地绿灯部署或清理。US$2 不重置，独占部署阶段尚未执行。

最新接续（Checklist v1.168，2026-09-21）：[统一主机编排与最终独立核对](../../developers/architecture/implementation-evidence/C02-byok-d1-operator-v269.md)本地通过，未部署。原有组件已接成一次性固定顺序，成功路径 93 条日志；清理后独立核对全部 56 表、四类保留数据、关闭围栏与 finished 许可。源码/打包各 71、相关回归 355、类型检查通过。取消或未知结果仅作独立停止/封闭/入口关闭/令牌撤销，不重放、删除未知样本或自动恢复旧实验。实际预检收集器、计量传输及真实网络时序资格仍待接入，不提供可直接部署的 CLI，不把合成资格声明当作真实证明。默认保留关闭围栏和维护回执；云管理/部署/模型/KMS/生产写入 0，US$2 不重置，独占授权尚未线上行使。

最新接续（Checklist v1.167，2026-09-21）：[固定资源部署适配器](../../developers/architecture/implementation-evidence/C02-byok-d1-deployment-v268.md)本地通过，未部署。仅更新现有三台 staging Worker，固定顺序/绑定/候选摘要，上传前写日志、核验旧状态，上传后独立读完整代码和版本；无创建资源兜底、自动重发/回滚或入口开启。源码 53、打包 53、实际离线产物专项 54、相关回归 302、类型和三份 dry-run 通过。绝对 outdir 已修复产物落点不一致，失败材料保留。完整操作器与当次预检仍未完成，不以模块绿灯代替原生验收；云管理/部署/凭证创建/模型/KMS/生产写入 0，独占授权未线上行使，US$2 不重置。

最新接续（Checklist v1.166，2026-09-21）：[固定 Access/入口与失败收尾适配器](../../developers/architecture/implementation-evidence/C02-byok-d1-access-v267.md)本地实现，未部署。原账户/两入口/两策略固定，临时令牌和每次开启写入都先记单次日志、重验准入、独立读回；失败后分别关闭，未知创建的当前缺席不等于已撤销。最终源码/打包各 59、相关回归 243、类型检查通过；首轮安装回归异常在两次复测未复现，原因未确认，失败记录保留。完整部署/操作器、关闭观察时延与维护许可窗口、受控恢复仍待接线；不凭此执行散装云操作。实际凭证创建/部署/云管理/公开 Worker/模型/KMS/生产写入 0，US$2 不重置，独占授权尚未线上行使。

最新接续（Checklist v1.165，2026-09-20）：[原生围栏安装与主机单次调用](../../developers/architecture/implementation-evidence/C02-byok-d1-install-v266.md)本地通过，未部署。复用现有 gateway、原生 Access 和独立短期安装凭据摘要，默认空 grant 禁用；一个 17 条原生批次安装十五个固定触发器与关闭标记，前后 schema/上限验证，未知结果不自动重发或拆除。52 项新增、52 项打包复测、589 项回归及类型/绑定/dry-run 通过。完整部署/Access/入口适配器与最终操作器、受控恢复仍待接线；本轮未切换 staging，未新增资源或重复代码下载。云管理/公开 Worker/模型/KMS/生产写入 0；公开累计 422、US$2 不重置，最后完整云观察仍 v257，v264 完整预检失败结论保留。

最新接续（Checklist v1.164，2026-09-20）：[固定 staging D1 管理适配器](../../developers/architecture/implementation-evidence/C02-byok-d1-management-v265.md)本地通过，未部署。40 项新增、40 项打包复测、432 项回归及类型检查通过；固定 D1 基线/控制/围栏开关/用例读回/maintenance 许可已接线，每项先刷盘，单条 SQL RETURNING 后独立核对，不重放未知结果。17 条原生围栏安装入口、Access/部署/完整操作器及受控恢复仍待完成；不能假定 REST batch 的事务性。独占授权尚未在线行使，本轮无云管理调用/模型/KMS/生产写入，未重复上轮代码下载；最后完整观察仍 v257，v264 部分观察及完整预检失败结论保留。公开累计 422、US$2 不重置、最终账单未确认。

最新接续（Checklist v1.163，2026-09-20）：[BYOK 主机单次用例与停止收尾](../../developers/architecture/implementation-evidence/C02-byok-d1-case-dispatch-v264.md)本地通过，未部署。新增 42 项、打包复测 42 项、390 项回归及类型检查通过；主机先刷盘再按序发送，STOP/封闭为独立一次性收尾，未知状态不重放/自动清理。固定资源完整操作器和受控恢复仍待完成。只读云观察共 93 次尝试/88 个完整 ACK、D1 读 2,022/写 0；首轮隔离检查匹配，但原 60 秒及独立 120 秒代码下载均未完整，完整预检不通过，最后完整观察仍 v257。可见账单截至 2026-09-20T00:00:00Z 为 USD 0，不是最终费用或套餐证明。公开累计 422、模型/KMS 0/0、生产未写、US$2 不重置；禁止跳过代码/版本/隔离/套餐/预算门禁。

最新接续（Checklist v1.162，2026-09-20）：[BYOK 专用用例入口](../../developers/architecture/implementation-evidence/C02-byok-d1-gateway-v263.md)本地通过，未部署。固定 staging D1、原生 Access、短期 bearer 和有界空正文验证；用例与 STOP 独立负载槽，停止新准入不代表 SQL 取消。新增 41 项、打包复测 41 项、相关回归 517 项及类型/绑定/dry-run 通过；十用例至独立清理在 SQLite 连通。尚缺主机用例单次发送与完整固定资源操作器、独占结束受控恢复及当次套餐/隔离/预算预检，禁止把候选直接当执行命令。用户允许独占 staging 的授权未在云端行使；未新增资源，云调用/部署/模型/KMS 0，最后观察仍 v257、公开累计 422、US$2 不重置，C02.G / C01 仍开放。

最新接续（Checklist v1.161，2026-09-20）：[BYOK 独立清理控制链与主机单次调用](../../developers/architecture/implementation-evidence/C02-byok-d1-maintenance-control-v262.md)本地通过，未部署。新增控制链 72、主机调用 22 项、69 项打包复测和相关回归/类型/两份 dry-run 通过；主机刷盘 PENDING 后才发一次 HTTP，认领前失败、迟到响应和丢 ACK 均不重放。完整接收端本地 190 次 SQL，删除事务 143 条/664 行，清理后保留围栏与 maintenance 回执。用户已允许临时独占现有 staging 并切换两台恢复 Worker；完整安装/封闭/基线/许可/Access/收尾操作器及独占结束后的受控恢复仍须完成，再冻结候选与预检套餐/预算。原有恢复 run() 与新候选 run(token) 不兼容，禁止混用。云调用/部署/模型/KMS 0，最后云观察仍 v257、公开累计 422，US$2 不重置，C02.G / C01 继续开放。

最新接续（Checklist v1.160，2026-09-16）：[BYOK staging 持久写入围栏](../../developers/architecture/implementation-evidence/C02-byok-d1-write-fence-v261.md)本地通过，未安装或部署。新增 36 项源码/打包版测试含双连接 SQLite 隔离；旧清理 40、处理器 29、验收 19、BYOK 204、Images SSE 41 与类型检查通过。15 个触发器/关闭标记常驻，143 条事务语句清除十用例 664 条记录，回滚或丢 ACK 不解除保护、不重放。保护模式本地基线 307 个对象/13 条配置，不替代当前云端 295/12；闭锁覆盖五张表，安装前必须确定 BYOK 专用期间及后续基线切换。独立受保护清理 service binding、授权/生命周期、完整操作器和原生门禁仍待完成。云请求/部署/模型/KMS 0，最后云观察仍 v257，公开累计 422、US$2 不重置，C02.G / C01 继续开放。

最新接续（Checklist v1.159，2026-09-16）：[BYOK 主机独占日志与入口关闭观察](../../developers/architecture/implementation-evidence/C02-byok-d1-operator-boundaries-v260.md)本地通过，未部署。新增 46 项含真实六进程竞争/两次强制终止；传输/时钟 63、清理 40、处理器 29、Images SSE 41 和 staging 类型检查通过。同工作区固定排他目录不自动释放，普通调用前刷盘；未知结果停止，不重放。关闭观察仅覆盖已知入口，明确不授权数据库清理；完整操作器、数据库停写边界和原生清理通路尚待连接。现有 recovery-control 无 D1，usage-recovery 有固定 staging D1，本轮未改绑定。下一步完成这些边界再冻结/预检，不自动新增资源或升级。云请求/部署/模型/KMS 0，最后云观察仍 v257、公开累计 422、US$2 不重置、C02.G / C01 继续开放。

最新接续（Checklist v1.158，2026-09-16）：[BYOK D1 全表归属与原子清理保护](../../developers/architecture/implementation-evidence/C02-byok-d1-cleanup-v259.md)本地通过，未挂接/部署。新增 40 项清理测试、既有一次性处理器 29 项、验收 19 项、BYOK 204 项、Images SSE 41 项及 staging 类型检查通过。固定 56 表、schema/完整行/计数守卫及六条明确 ID 删除同批；未决、失败或未知写入留存隔离，ACK 丢失不重试。独立关闭证明、跨进程独占日志、清理入口及生命周期仍未接入，禁止直接上线辅助模块或使用旧简化测试清理函数。139 条仅为删除事务，不含前后读取，仍须核验现有套餐和完整预算。本轮没有云管理/公开请求、部署或模型/KMS 调用；最后云观察沿用 v257 的 2026-09-16T04:43:08.731Z，公开累计 422、US$2 不重置、最终增量账单未确认。下一步接操作边界，再冻结和预检；C02.G / C01 仍开放。

最新接续（Checklist v1.157，2026-09-16）：[BYOK D1 一次性处理器与调用守卫](../../developers/architecture/implementation-evidence/C02-byok-d1-one-shot-v258.md)本地通过，尚未挂接/部署。新增 29 项保护层测试、既有验收 19 项、BYOK 204 项、Images SSE 41 项及 staging 类型检查通过。新处理器先留存 PENDING、后持久化结果，未知结果不重放；stop 仅封住后续准入，不证明原生停写，不触发清理。全 56 表归属/原子清理、完整独占操作器和独立关闭仍待补齐，禁止直接上线模块。最重用例共 125 条 SQL，后续需确认现有套餐满足，不能直接用于 D1 Free 每次 50 条限制，不自动升级。当前没有云管理/公开请求、部署或模型/KMS 调用，最后真实观察沿用 v257 的 2026-09-16T04:43:08.731Z，远端 v232、公开累计 422、首轮 US$2 不重置；C02.G / C01 仍开放。

最新接续（Checklist v1.156，2026-09-16）：[BYOK D1 验收准备与关闭复核](../../developers/architecture/implementation-evidence/C02-byok-d1-acceptance-v257.md)。只读预检 42 次 ACK、674 行读取 / 0 写入；四个 staging Worker、两个 Access deny-all、56 表计数/schema 和三个生产配置与基线一致，最后观察更新至 2026-09-16T04:43:08.731Z。另保留首次无 HTTP 响应的沙箱失败尝试；不是权限不足结论。远端仍为 v232 候选，未上传或执行新用例。新增测试程序 19 项、BYOK 回归 204 项、Images SSE 41 项和类型检查通过，但没有受保护单次入口或完整云端操作器；禁止直接将本地 PASS 视为原生验收。下一步先补一次性授权/留证、全表归属/清理守卫和关闭路径，再冻结新候选并重做当次预检。公开 HTTP 累计 422、模型/KMS 0/0、首轮 US$2 不重置，最终增量账单未确认；C02.G / C01 保持开放。

最新接续（Checklist v1.146，2026-09-16）：[文本 JSON 分页上传与独立资源完成](../../developers/architecture/implementation-evidence/C02-text-upload-v247.md)为 LOCAL_PASS，未部署。四协议在认证／准入前冻结上传快照，上传与响应分别跟踪；响应成功不释放未读 EOF 的上传，保持 Images 成功规则。新增 176 项、专项 833/833、完整回归 3,890/3,890、两项类型检查和 2,431 条摘要核验通过；四项 loopback HTTP 不是 Workers 原生或物理容量证据。下一项为数据库自身时限／初始化，随后全工作集及新冻结候选原生验收；C02.G / C01 / 后续依赖仍未通过，生产容量不开启。本轮 staging 调用／部署 0、模型/KMS 0/0、首轮 US$2 不重置；最后云观察仍 v232，本轮没有重验远端。[机器证据](../../developers/architecture/implementation-evidence/C02-text-upload-v247-results.json)

最新接续（Checklist v1.145，2026-09-16）：[文本 JSON／错误响应资源完成](../../developers/architecture/implementation-evidence/C02-text-json-resource-v246.md)为 LOCAL_PASS，未部署。四协议非 SSE 响应及迟到正文接入资源任务，清理 ACK 与记账分离，保持原 SSE 和 Images 成功规则。新增 160 项、完整回归 3,714/3,714、两项类型检查和 2,395 条摘要核验通过；公开测试是合成 SQL／逻辑容量证据，不是 Workers 原生或真实资金验收。下一项为文本上传，随后数据库自身时限／初始化及新冻结候选原生验收。C02.G / C01 / 后续依赖仍未通过，生产容量不开启。本轮 staging 调用／部署 0、模型/KMS 0/0、首轮 US$2 不重置；最后云观察仍 v232，本轮没有重验远端。[机器证据](../../developers/architecture/implementation-evidence/C02-text-json-resource-v246-results.json)

最新接续（Checklist v1.144）：[向量 JSON 上传分页与资源所有权](../../developers/architecture/implementation-evidence/C02-vector-upload-v245.md)为 LOCAL_PASS，未部署。上传与响应分别持有资源，已读末页不等于消费 EOF；新增 52 项、完整回归 3,554/3,554 与两项类型检查通过，2,360 条摘要核验。两项本机 HTTP 验证不是 Workers 原生定长／取消或容量证明；向量全工作集、文本 JSON／错误正文消费者、数据库自身时限继续待办。下一次云验仍须新冻结构建，生产容量不开启。本轮 staging 调用／部署 0、模型/KMS 0/0，首轮 US$2 不重置，最后云观察仍 v232。[机器证据](../../developers/architecture/implementation-evidence/C02-vector-upload-v245-results.json)

最新接续（Checklist v1.143）：[向量响应资源所有权](../../developers/architecture/implementation-evidence/C02-vector-response-v244.md)为 LOCAL_PASS，未部署。四个公开向量入口将响应源 EOF／取消 ACK 传至容量层，迟到响应不漏跟踪，记账不等 ACK。新增 63 项、完整回归 3,502/3,502 和两项类型检查通过，2,336 条摘要核验；这些 Node 数值池测试不是 Workers 原生或物理容量验收。向量上传分页、其他 JSON 消费者和数据库自身时限继续待办；下一次云端验收仍须新冻结构建，生产容量不开启。本轮 staging 调用／部署 0、模型/KMS 0/0，首轮累计 US$2 不重置，最后云观察仍 v232。[机器证据](../../developers/architecture/implementation-evidence/C02-vector-response-v244-results.json)

最新接续（Checklist v1.142）：[DashScope JSON 上传与 ASR 长度声明](../../developers/architecture/implementation-evidence/C02-asr-framing-v243.md)的 Node 本地回归通过，原生 workerd 尚未验收，未部署。五路径独立持有上传，分页 Base64／流式 JSON；multipart 与 JSON 声明 `expectedLength`。新增 88 项、完整回归 3,439/3,439 和两项类型检查通过，2,312 条摘要核验。Windows workerd 启动访问异常，未执行原生请求、未改系统运行库，不得用 Node 或源码依据代替线上定长／取消及原实例容量验收。下一次云端验收仍须新冻结构建；其余 JSON／错误正文消费者和数据库自身时限继续待办，生产容量不开启。最后云端观察仍 v232，本轮 staging 调用／部署 0、模型/KMS 0/0，US$2 不重置。[机器证据](../../developers/architecture/implementation-evidence/C02-asr-framing-v243-results.json)

最新接续（Checklist v1.141）：[OpenAI 兼容 ASR multipart 上传资源所有权](../../developers/architecture/implementation-evidence/C02-asr-upload-v242.md)为 LOCAL_PASS，未部署。新增 41 项、完整回归 3,351/3,351 和两项类型检查通过，2,283 条摘要核验；上传源强制停止不代替消费完成，响应 ACK 不覆盖未完成上传。原生 Node HTTP 已验证，但 Workers 普通流的手工 Content-Length 不保证定长传输，目标分块兼容性／定长流所有权需在下一次冻结与部署前处理。其余 ASR JSON 上传、其他消费者、数据库自身时限及 Workers 原实例容量仍待验收，生产容量不开启。最后云端观察仍 v232，本轮 staging 调用／部署 0、模型/KMS 0/0，首轮 US$2 不重置。[机器证据](../../developers/architecture/implementation-evidence/C02-asr-upload-v242-results.json)

最新接续（Checklist v1.140）：[ASR 响应与异步下载资源所有权](../../developers/architecture/implementation-evidence/C02-asr-resource-v241.md)为 LOCAL_PASS，未部署。公开入口登记六种驱动的响应清理，异步重定向 ACK 独立持有，取消／deadline 后不追加下载或重提交；新增 118 项、完整回归 3,310/3,310 与两项类型检查通过，2,259 条摘要核验。ASR 上传、其他 JSON 消费者、数据库自身时限和原实例容量继续未通过，生产容量不开启，下一次部署须新冻结构建。最后云端观察仍 v232，本轮未重验；新增 staging 调用／部署 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置。[机器证据](../../developers/architecture/implementation-evidence/C02-asr-resource-v241-results.json)

最新接续（Checklist v1.139）：[语音克隆上传资源所有权](../../developers/architecture/implementation-evidence/C02-tts-upload-v240.md)为 LOCAL_PASS，未部署。修复部分上传被错误计为清理成功的问题，按需编码、清空生产者引用，强制停止仍锁定／未完整消费的源保持未确认；24 项同测试对照由 19 PASS / 5 FAIL 到全部通过，最终新增 30 项、完整回归 3,187/3,187、两项类型检查通过，2,226 条摘要核验。Node 原生 HTTP 上传通过，但 Workers 上传／原实例容量、其余消费者与数据库时限仍待验收；生产容量不启用，下一次部署须新冻结构建。云端最后观察仍 v232，本轮未重验；staging 新调用／部署 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置。[机器证据](../../developers/architecture/implementation-evidence/C02-tts-upload-v240-results.json)

最新接续（Checklist v1.138）：[TTS 响应独立资源完成](../../developers/architecture/implementation-evidence/C02-tts-resource-v239.md)为 LOCAL_PASS，未部署。响应清理接入独立资源通道，记账不等待清理 ACK，未确认清理不释放逻辑容量；新增 180 项、完整回归 3,157/3,157、两项类型检查通过，2,204 条摘要核验。语音克隆上传、其余 JSON / ASR 消费者、数据库自身时限及原实例容量仍待验收，生产容量不启用；下一次部署须新冻结构建。云端最后观察仍为 v232 候选，本轮未重验，staging 新调用／部署 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置。[机器证据](../../developers/architecture/implementation-evidence/C02-tts-resource-v239-results.json)

最新接续（Checklist v1.137）：[四类文本 SSE 独立资源完成](../../developers/architecture/implementation-evidence/C02-text-resource-v238.md)为 LOCAL_PASS，未部署。dispatch 前登记资源 owner，取消事实／记账与清理 ACK 分离，未确认清理不释放逻辑容量；新增 74 项、完整回归 2,977/2,977、两项类型检查通过，2,175 条摘要核验。TTS、上传／JSON／错误正文、数据库自身时限和原实例容量仍待验收，生产容量不启用；下一次部署须新冻结构建。云端仍为 v232 候选，本轮未重新核验，staging 新调用／部署 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置。[机器证据](../../developers/architecture/implementation-evidence/C02-text-resource-v238-results.json)

最新接续（Checklist v1.136）：[Gemini 入口 deadline 与错误状态](../../developers/architecture/implementation-evidence/C02-gemini-ingress-v237.md)为 LOCAL_PASS，未部署。33 项专项、完整 dispatch 回归 2,903/2,903 和两项类型检查通过，2,126 条摘要核验；初始化／迁移和已开始写入仍须收尾，不把 300 秒执行截止说成数据库硬中断保证。清理资源独立所有权、数据库自身时限、原实例容量与 C02.G 仍待验收；下一次部署必须新冻结构建。云端仍为 v232 候选，本轮未重新核验，新增 staging 调用／部署 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置。[机器证据](../../developers/architecture/implementation-evidence/C02-gemini-ingress-v237-results.json)

最新接续（Checklist v1.135）：[Gemini 取消事实与清理分离](../../developers/architecture/implementation-evidence/C02-gemini-settlement-v236.md)为 LOCAL_PASS，未部署。公开记账不再等待不可信取消 ACK；保留 unknown 预算与独立 reader 清理，不重放。完整 dispatch 回归 2,870/2,870、两项类型检查 PASS，2,093 条摘要核验。Gemini 入口 deadline、流错误日志状态以及跨驱动资源完成合同仍待补；原实例容量与 C02.G 未放行。云端仍为 v232 候选，本轮未重新核验；新增 staging 调用／部署 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置。[机器证据](../../developers/architecture/implementation-evidence/C02-gemini-settlement-v236-results.json)

最新接续（Checklist v1.134）：[三类文本 SSE 取消与清理分离](../../developers/architecture/implementation-evidence/C02-text-sse-cancellation-v235.md)为 LOCAL_PASS，未部署。最终专项 39/39、完整 dispatch 回归 2,854/2,854 及两项类型检查通过；三次回归超时和中间版本保留，2,069 条摘要核验。取消账务不等清理 ACK，pump 独立等待取消 reader；该清理尚未独立接入全部容量 / Workers 生命周期，原实例容量与 C02.G 不放行。当前云端仍为 v232 候选，不包含本轮修复；新增 staging 调用/部署 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置，远端未新复核。[机器证据](../../developers/architecture/implementation-evidence/C02-text-sse-cancellation-v235-results.json)

最新接续（Checklist v1.133）：[Gemini 取消修复](../../developers/architecture/implementation-evidence/C02-gemini-cancellation-v234.md)为 LOCAL_PASS，未部署。专项 16/16、完整 dispatch 回归 2,815/2,815 及两项类型检查 PASS；2,018 条证据摘要核验。接入 fetch / JSON signal，取消时停止 SSE 读取并解除阻塞写入，不改变 Images 成功结算点。当前云端仍为 v232 诊断候选，不包含本修复；后续部署须新冻结构建。本轮 staging 调用 / 部署为 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置，最后关闭观察仍 v232，本轮未重新核验。Workers 原实例容量与 C02.G 仍未通过。[机器证据](../../developers/architecture/implementation-evidence/C02-gemini-cancellation-v234-results.json)

最新接续（Checklist v1.132）：v1.132 记录[文本驱动重定向止损](../../developers/architecture/implementation-evidence/C02-text-redirect-v233.md)（LOCAL_PASS，未部署）：真实回环复现四个文本驱动一次许可发出两次 HTTP；修复仅增加 redirect:error，保留 unknown / 禁止重放。112 项同源码对照由 16 PASS / 96 FAIL 变为 112 PASS，较大范围 2,799/2,799 回归及两项类型检查通过。历史源码四份按字节归档，新旧摘要明确区分，共 1,997 条记录；旧 CLI 应拒绝当前源码漂移，部署须新冻结构建。停止同实例碰撞式发现；ctx.exports / RPC 没有足够证据作为原生取消后的等价观察替代。先推进同一 C02 内可独立核验的发送/取消合同，不替代容量门禁、不跳过后续依赖。本轮 staging 调用 / 部署为 0，累计公开 HTTP 422、模型/KMS 0/0、US$2 不重置；最后关闭观察仍 v232，本轮未重验远端。 [机器证据](../../developers/architecture/implementation-evidence/C02-text-redirect-v233-results.json)

最新接续（Checklist v1.131）：v1.131 记录[Peer 实例诊断真实试验与关闭复核](../../developers/architecture/implementation-evidence/C02-images-sse-peer-diagnostic-live-v232.md)（STAGING_PARTIAL）：新诊断候选仅部署一次；唯一合成推理后 8 次原始 409 均证明观察请求来自其他逻辑实例，零匹配 / 容量帧，容量试验仍 FAILED。原生取消、一次账务恢复、严格清理与独立只读复核分别通过；56 表回到基线，临时 token/tail 撤销、生产未变。保留 v231 直接 Node 加载失败（云端调用 0），v232 用 tsx 在新目录执行，未重放推理或上传。v231 阶段实际 2,439/2,439 联合回归通过，最终 1,975 条摘要核验；管理 HTTP 285，公开新增 16 / 累计 422，模型/KMS 0/0，US$2 不重置、最终增量账单未核验。最新关闭观察 2026-09-09T06:45:06.937Z。下一步停止碰撞式发现，先评估确定性同池观察；不自动新增云资源，完整容量、unknown/幂等、C02.G 及后续工作包仍开放。 [机器证据](../../developers/architecture/implementation-evidence/C02-images-sse-peer-diagnostic-live-v232-results.json)

最新接续（Checklist v1.129）：v1.129 记录[Peer 诊断传输与封闭构建](../../developers/architecture/implementation-evidence/C02-images-sse-peer-diagnostic-transport-v230.md)（STAGING_PARTIAL / LOCAL_PASS）：诊断复用原拒绝正文读取和时钟，有界保存同次原始证据；journal 失败停止发现，迟到确认不能改写封存事实。新协调器已接入原窗口 / finalizer，原联合验收输入不变。80 项新增运行检查、2,392/2,392 联合回归及类型检查通过；真实 Wrangler dry-run 与绑定核对通过，1,947 条摘要核验。未上传，新候选尚待接入新的单次资源操作器 / CLI。新增 staging 云端调用 0，累计公开 HTTP 406、模型/KMS 0/0、US$2 不重置；最后关闭读回仍 v228，容量验收失败结论保留。 [机器证据](../../developers/architecture/implementation-evidence/C02-images-sse-peer-diagnostic-transport-v230-results.json)

最新接续（Checklist v1.128）：v1.128 记录[Peer 不匹配只读诊断](../../developers/architecture/implementation-evidence/C02-images-sse-peer-diagnostic-v229.md)（STAGING_PARTIAL / LOCAL_PASS）：保持原 V3 拒绝正文和成功交付不变，附加同 handler 实例 UUID，纯分类器区分实例 / epoch 不匹配。38 项新增检查及 2,312/2,312 联合回归、类型检查通过，1,928 条摘要核验。尚未接入线上原始头采集、构建或部署，不改变结算规则或重试权限。新增云端调用 0；累计公开 HTTP 406、模型/KMS 0/0、US$2 不重置。最新关闭读回仍 v228；其容量验收失败结论保留。下一步冻结新的有界采集与候选执行链，禁止重放 v227。 [机器证据](../../developers/architecture/implementation-evidence/C02-images-sse-peer-diagnostic-v229-results.json)

2026-09-07。用户已确认独立 staging、生产资源隔离和首轮累计新增费用 **US$2**（含 Cloudflare、真实模型及 Google Cloud KMS）。此前提交边界故障观察 **9/9 符合预期，但恢复门禁未通过**：5 次成功响应仅 4 条用量日志 / 尝试事实，提交前失败留下记录缺口；不把故障复现称作恢复完成。本批 9 次 HTTP、首轮累计 98 次，模型/KMS 0；最终增量账单未核验，预算不重置。只更新独立 staging Gateway，未修改生产结算算法、schema 或依赖；私有上游版本不变。已关闭入口、恢复 Access deny-all、删除临时令牌并精确清理测试数据，生产设置指纹未变。C02.G 与完整容量门禁仍未通过，生产容量池未启用。详见 [最新提交边界证据](../../developers/architecture/implementation-evidence/C02-staging-image-storage.md)、[恢复合同草案](../../developers/architecture/image-usage-recovery-boundary.md)、[前轮取消修复](../../developers/architecture/implementation-evidence/C02-staging-image-cancellation.md) 与 [基础冒烟](../../developers/architecture/implementation-evidence/C02-staging-access-smoke.md)。不自动升级套餐、充值或开展真实支付 / 链上交易。

最新接续（Checklist v1.127）：[V3 真实 Workers 试验与关闭读回](../../developers/architecture/implementation-evidence/C02-images-sse-peer-live-v228.md)（v1.127，STAGING_PARTIAL）：V3 已封闭部署并执行一次真实 Workers 试验；唯一推理后 8 次观察 Upgrade 均明确 mismatch，零样本 / 标记，试验保持 FAILED。原生取消、一次账务恢复和原 350 秒安全期后的严格清理通过；56 表回到基线、入口关闭、自有 token/tail 撤销、生产配置未漂移。最终只读复核 PASS，保留 Access updated_at 导致的首次严格复核失败及离线校验器修正；1,918 条摘要核验。历史 2,274 项回归本轮未重跑。新增公开 HTTP 16、累计 406，模型/KMS 0/0、US$2 不重置。下一步定位实例 / epoch 不匹配及可靠观察方式，禁止重放已消费 v227 尝试；完整容量、unknown/幂等、C02.G、C01 和 C03–C20 仍开放。 [机器证据](../../developers/architecture/implementation-evidence/C02-images-sse-peer-live-v228-results.json)

## 1. 固定边界

| 项目 | staging 首轮配置 | 与生产的隔离方式 |
| --- | --- | --- |
| 账户 | 已只读确认的 CinaGroup | 同账号逻辑隔离，不宣称账户、账单或管理权限独立 |
| Proxy | `cinatoken-proxy-staging`，最近核验版本 `0c75c8b9-527d-4b3f-882f-fc2b1c3e0bb3` | 独立 Worker；当前部署 `scripts/staging/images-sse-capacity-peer-diagnostic-gateway.ts`，保留原 V3 handler / 单请求逻辑池，仅为拒绝响应增加有界实例诊断。v1.131 最终只读复核确认入口关闭；8 次观察均为其他逻辑实例，原生取消 / 单次恢复已验证，原池容量状态未证实，生产容量未启用 |
| 恢复消费者 | `cinatoken-staging-usage-recovery`，当前版本 `b45d752e-361e-45d8-aca7-f24feca4afec` | `scripts/staging/usage-recovery-fencing-worker.ts`；无参命名 RPC、仅 staging D1、30 秒租约/20 次有界轮询；控制行已清理，HTTP 404、无公共触发器；64 MiB 仅实验分配 |
| 私有模拟上游 | `cinatoken-staging-images-upstream`，版本 `c6939802-a8a9-4f09-9d51-4a772cbce8b2` | 只通过 IMAGE_UPSTREAM service binding；无公网 / 预览 / 路由 / Cron。唯一 PROBE_DB 指向同一 staging D1，只更新本轮已 armed 的探针键，不调用模型或 KMS |
| 数据库 | 已建 `cinatoken-staging` D1，`6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`（APAC） | 不克隆生产数据；准备工具按账户、UUID 和实际数据库名称校验；不要重复创建 |
| 入口 | `workers_dev=false`、`preview_urls=false`、空 routes；Access 应用保留为 deny-all | 已验证受保护冒烟并关闭入口；后续测试仍须先核验策略，不绑定 `api.cinatoken.com` |
| 凭据 | 已注入全新 staging 专用 `SHARED_KEY_ENCRYPTION_SECRET` | 不复制生产密钥，不绑定生产 Secrets Store；真实模型/KMS 测试须另行准备 staging 专用凭据和最小权限身份，不在文档或日志中保存秘密 |
| 限流 | 独立的 `60002001` / `60002002` / `60002003` namespace | 保持三个限流器的业务规则，不复用生产模板的 `2001` / `2002` / `2003`；发布前还须检查远端实际绑定 |
| 后台消费者 | 无 Cron、Queues、R2、Chain Worker、Admin service binding | 不是仅设置 Batch API=false；首轮确实不配置这些资源和触发器 |
| 日志 | 开启结构化可观测性，正文日志 off | 测试日志与生产 Worker 分开；不记录凭据或完整请求正文 |

这里选择 D1 是首轮 staging 的验证范围，不替代 C01 对正式发行数据库、区域、模态和服务目标的剩余决定。未部署的消费者不是已完成验收；原有 50 MiB 请求 / 20 MiB 文件 / 32 MiB 普通上游及批准的字段限额不变。

已有 `cinatoken-rust-api-staging` / `cinatoken-rust-db-staging` 属于其他实现，不复用、覆盖或删除。`cinatoken-mock-upstream` 也未经隔离核验，不因名字像测试资源就接入。

## 2. 本地准备与验证

配置源为 [独立 staging 模板](../../../packages/proxy/wrangler.staging.base.jsonc)，由 [准备工具](../../../scripts/deploy/prepare-proxy-staging.mjs) 生成 `.wrangler/staging/proxy/wrangler.jsonc`。该目录已被 Git 忽略；不会写入原有 Proxy/Admin/Chain/D1 的生成配置。

最新 Images 私有链路使用 [单独组合准备工具](../../../scripts/deploy/prepare-proxy-staging-images.mjs)，先调用同一隔离校验，仅增加专用 main 与固定 service binding，生成 `.wrangler/staging/images-proxy/wrangler.jsonc`。有 `STAGING_D1_DATABASE_ID` 时只读验证精确 UUID / 名称；无 ID 的离线配置不具备发布资格。当前部署保留原 staging 加密 secret，不重新生成或取回密钥。基础准备工具仍保留原 `src/index.ts` 合同；不要把两个生成配置当作同一发布包。

v1.63 恢复实验另用同一工具导出的 `imagesRecoveryStagingConfig`，显式选择 `scripts/staging/images-recovery-gateway.ts`；生成配置为 `.wrangler/staging/images-recovery-v162/wrangler.jsonc`，已核验并发布，入口已重新关闭。原 CLI 仍生成 legacy 入口，不能把它当成恢复版本。配置本身不授予发布或开门权限；下一次使用前继续按当前资源/源码摘要和 Access 门禁复验，不重放一次性实验脚本或已有 ALTER。

本地专项：`npm run test:images:staging -w @octafuse/proxy`、`npm run typecheck:images:staging -w @octafuse/proxy`。绑定声明由 Wrangler 生成，类型检查还覆盖专用入口；使用共同 handler 工厂避免组合入口额外创建一份默认 app。通用生产入口仍不注入 Images 传输或容量池。部署及开放 Access 属于另外的云端步骤，不由这些测试命令触发。

不要用旧 `gen:wrangler` / `deploy:cloudflare` 流程仅改实例名来创建本次 staging：原生成器可能继续继承生产域名和 retention Cron。

在仓库根执行以下命令，只进行本地准备、校验与打包：

```powershell
node --test scripts/deploy/prepare-proxy-staging.test.mjs
node --test scripts/deploy/staging-d1-bootstrap.test.mjs
node scripts/ci/verify-d1-portal-ledger.mjs
node scripts/deploy/prepare-proxy-staging.mjs
node node_modules/wrangler/wrangler-dist/cli.js deploy --dry-run --experimental-provision=false --cwd .wrangler/staging/proxy --config wrangler.jsonc --outdir bundle --metafile bundle-meta.json
node node_modules/wrangler/wrangler-dist/cli.js types staging-env.d.ts --include-runtime=false --cwd .wrangler/staging/proxy --config wrangler.jsonc
```

未设置 `STAGING_D1_DATABASE_ID` 时，准备工具明确输出 `OFFLINE_CONFIG_ONLY_DATABASE_NOT_PROVISIONED`，**不是可发布环境或数据库验证通过**。当独立 D1 已创建后，以该变量提供其 UUID；工具只读查询已固定账户的 D1 元数据，实际名称必须为 `cinatoken-staging` 才写入配置。不要传生产 `D1_DATABASE_ID`，不要把 UUID、Secret 名称或打包成功当成凭据、权限、迁移已就绪。

准备工具不是发布授权器；直接绕过它调用 Wrangler 仍可能创建资源。尚未通过下一节门禁时保留 `--dry-run`，并关闭自动 provisioning。发布前生成配置必须再次检查，不能复用过期的本地文件。

`--include-runtime=false` 仅生成绑定类型，避免依赖当前故障的本地 workerd；它不生成或验证最新平台运行时定义，也不取代现有项目类型检查或线上执行。

### 新库的演示管理员 Key

完整历史迁移会将演示 `MASTER_KEY` 搬到 `admin_api_keys.legacy-master`；后续删除旧配置项并不会撤销这把 Key。新 staging 在全部迁移完成后、开放任何入口前，还必须执行 [staging 专用初始化 SQL](../../../scripts/deploy/staging-post-migrate.sql)，并确认默认演示 Key 已撤销、当前没有意外的启用管理员凭据。

这个 SQL 不是新生产迁移，不加入 `packages/core/migrations-d1`；它只匹配固定演示 Key，已轮换的 legacy Key 和自建 Key 不受影响。执行前必须重新验证账户、UUID 和实际数据库名 `cinatoken-staging`，不能只凭绑定名 `DB` 操作，也不能把该脚本指向生产库。首轮只有 Proxy，不提供 Admin 管理路由；这里修复的是新库初始凭据状态，不宣称发现或修复了生产可利用漏洞。

2026-09-06 本地验证：68 份迁移在 SQLite 内存空库按文件事务顺序完成，51 张业务表、外键零违规、完整性检查通过；非空数据仅为 12 条配置、1 条数据库标识和 1 条演示管理员 Key。专用初始化后该 Key 被撤销；重复执行和保留已轮换/自建 Key 的测试通过。这不是 Cloudflare D1 远端执行或运行时性能证明。D1 的事务/外键要求另见 [官方说明](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)，远端仍须验收实际迁移记录与初始数据状态。

## 3. 云端有限顺序

1. **遵守已确认的本轮累计 US$2 上限**（包含 Cloudflare、真实模型和 Google Cloud KMS）。账号已有 Workers Paid / Teams Free，不新增付费订阅；原有 US$5/月账号订阅不是本轮新开通费用。执行前估算并预留余量，不依赖未经核验的共享额度余额；限制测试请求次数、并发和持续时间，不因失败无限重试。CPU 上限或延迟的费用统计都不是账单硬上限。
2. **重新核验目标**：首次创建前确认名称未占用；本轮资源已创建，后续按上表 UUID 和发布记录核验后复用，不能覆盖未知同名资源。核对生产实际绑定及部署标识作前后对照。Access 写权限已实测通过，现有应用 `ed5fd912-d6f1-4662-9575-02e0d6877af4` 仅保护本次 staging 主机名；按记录复用，不重新创建同名应用或改变生产访问策略。权限或身份核验失败时不得直接公开入口。
3. **创建隔离资源**：仅 staging D1 和 Proxy；生成全新测试加密材料并安全注入。只对新库应用已检查的全部迁移及上述 staging 专用初始化，验证演示 Key 已撤销、业务表为空；不从生产复制正文、用户、余额、供应商 Key 或配置。
4. **先保护、再开放**：部署时先保持全部入口关闭，配置并核验仅允许测试身份的 Access 策略后再开放一个测试入口。预览 URL 继续关闭。验证无凭据 / 错误凭据被拒绝、获准身份可访问；不能用绕开保护的地址完成验收。
5. **真实 Worker 冒烟**：先执行有限的健康、无效鉴权和空目录检查。`/health` 不做数据库读写探测，因此健康通过不是迁移或账务通过；另做受控的新库读写 / 幂等验证。
6. **C02 正式执行证据**：接入经过隔离核验的模拟上游，按现有 Images/OAuth/取消/后台持有用例开展真实 Workers 验证，再测试 50 / 20 / 32 MiB 边界、编码膨胀、慢读、并发、错误和恢复。模拟上游与缺省关闭消费者的结果不能代表真实供应商、KMS、全部模态或整个生产实例容量通过。
   - 2026-09-07 首个 Images 阶段完成真实 Worker/D1 的 50 MiB 总请求、20 MiB 单文件及控制字段入站子集。只使用零消费额度、哈希存储的临时 Key，无 model/provider；以 `gateway.model_not_found` 证明解析可进入模型查找，不代表推理成功。该阶段尚无上游响应或后台结算证据；后续私有接入结果见下一条。
   - 随后的私有链路阶段已完成串行成功 / 响应边界 / D1 后台落库子集，见前一批链路证据。50 MiB JSON 的 padding 未转发，上游实收 61 字节；20 MiB 文件完整到达私有上游。真实付费结算、容量 lease、慢读 / 取消 / 并发 / 恢复仍未验收。不要将合成 standard endpoint 的直接测试建档当作管理端证据审批验收。
   - 大包转发接续阶段已完成 10/10 检查：实际 image 字段出站、完整 50 MiB multipart 与大响应组合、客户端分段暂停读取及读后取消；上游 SHA-256 通过真实 D1 request-id 核对。取消发生在上游处理完成之后，不是上游在途终止证明；容量池仍关闭。下一步慢上传 / 在途取消、后台延迟 / 恢复，再补并发和完整工作集。18 项本地专项和 2,678 项调度安全回归通过，不取代这些余下门禁。
   - 前一批在途取消阶段最终 9/9 通过：D1 握手确认上游开始后才取消，头部前 / 正文中取消均有终态与零价日志；四条尝试事实正确分类。先前两次 FAIL 保留，分别定位入口持有过晚及 Images 取消事实遗漏。每次仅使用 27 条种子与 5 个探针键，清理后恢复基线；32 项本地专项 / 2,686 项调度安全通过。后续提交边界结果见下一条；大包、edits/SSE 在途取消、超时和完整容量矩阵仍待补。普通成功对照不是重启恢复，waitUntil 不替代持久化。
   - 最新提交边界阶段 9/9 故障观察通过，恢复门禁 NOT_PASSED：提交前失败造成 5 次成功仅 4 条日志。暂停由响应结束后的独立 CAS 释放；提交后丢 ACK 保留真实事务。Gateway 通过严格 x-c02-d1-fault header 及精确租户/armed 行匹配控制一次真实 batch 的返回边界，不接受任意 SQL/延迟，也不属于生产入口；无 header 时走原链路。仅 27 条种子 + 4 个探针键及关联数据，清理后基线恢复。新增 10 项测试、专项 42/42 与类型检查通过。下一步先本地恢复合同，再按依赖补最小耐久机制；探针不是云端宕机/重启实验，未测试完整容量。
   - 用户已允许真实付费模型/KMS 测试；累计费用上限及各自测试目标、专用凭据/身份就绪后，可追加小规模真实服务验证，分别记录费用和结果。不能将大请求/并发压力样本直接转发到付费模型，也不能以 gcloud 已登录代替 Workers 的 KMS 服务身份配置。
7. **收尾**：记录远端版本、兼容配置、资源 ID、测试输入与结果、费用统计，并核对生产部署和绑定未变。关闭测试入口；先禁用临时令牌，再把本次应用的 `service_auth_401_redirect` 关闭、策略改为 deny-all，解除引用后删除令牌并核验。不能把令牌到期或删除失败当成已撤销。资源是否保留或删除按用户确认执行，不能默认永久开放。

本机 Windows C++ 运行库修复是可选的本地开发恢复分支，仍需系统变更授权；**不再是云端 staging 验收的必经门禁**。Workers 首发、Node 备选不变。

依据 [Workers 环境隔离最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[Wrangler dry-run](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy) 和 [预览 URL 访问保护](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/) 区分“本地打包”“配置准备”“受保护的线上执行”和“生产验收”。本轮证据见 [C02 staging 准备](../../developers/architecture/implementation-evidence/C02-staging-preparation.md)。
