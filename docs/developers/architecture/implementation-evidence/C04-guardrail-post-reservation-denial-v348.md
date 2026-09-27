# C04 v348：普通预约后的 Guardrail 拒绝

状态：**review-only / 默认关闭**。本提案没有部署，也没有给生产角色新增授权。原生证据见 [结果 JSON](./C04-guardrail-post-reservation-denial-v348-results.json)。

## 范围与结论

已有 v346/v347 路径先建立 shared-key quote claim，再尝试普通用户预算预约和 Guardrail admission。若普通预约成功，而 Guardrail policy 返回拒绝，Chat 会在首次上游 fetch 前释放普通预约。本提案只为这个精确结果提供零买家扣款的 buyer log / v2 event 闭环。事件使用 `buyer_charge_basis=none`、`buyer_usage_certainty=unknown`、`buyer_debit_micros=0`；买家 log 的 token 数必须为零，每个 attempt 的 usage/provider cost 必须为 unknown 且数量为 null，不记为 actual，不产生 seller earning。

`released` 本身不代表零上游发送。数据库仅在同一个可信 buyer LOGIN 的普通预约释放事务中，看到 `reserved → released`、前后 `dispatched_at IS NULL`、前后 `settled_micros=0`、精确 terminal reason、已存在 quote claim、没有 Guardrail 预约，才写入私有且不可修改的 pre-send denial receipt。v2 producer、buyer debit verifier、buyer receipt verifier 都需重新验证 receipt 与当前 released/0 行。release 失败留下 `reserved`，无 receipt、无 buyer log/v2 event，继续待查。普通预算在预约之前拒绝时根本没有该行，本提案不处理它。

Guardrail reservation 的 `BEFORE INSERT OR UPDATE` 触发器与普通释放的 `AFTER UPDATE` 触发器按 request ID 取同一事务 advisory lock。已提交的零发送证明阻止同一请求晚插 Guardrail 预约；先开始、未提交的 Guardrail 插入会使普通释放等待，提交后释放不生成证明。现行 Guardrail 表仅 FK 到自身 window 与 workspace，没有 FK 到普通预约行，因此这两条已测路径没有普通行锁的反向依赖；未证明整个部署中任意其他锁顺序均无死锁。

## 激活与权限边界

提案文件为 `packages/core/migrations-proposals/postgres/shared-key-guardrail-post-reservation-denial-v348.sql`，构造器为 `scripts/db/cutover/build-shared-key-guardrail-denial-v348.mjs`。仅在 PG73、v346 buyer privilege split、v347 buyer LOGIN producer 及此前 v2 依赖满足时，由直接 migrator LOGIN 在单一事务设置 `cinatoken.shared_key_guardrail_denial_v348_activation=reviewed-v1` 后运行。preflight 校验原函数定义及角色；postflight 校验三个替换后的函数、私表 ACL 和四个触发器的绑定及启用状态。

原生测试先证明现有 v346/v347 buyer LOGIN 对普通预约 `INSERT` 返回 `42501`。随后才在**隔离测试库**临时授予 buyer LOGIN 该 `INSERT`，以及 Chat 所需的 `workspace_budgets`、`system_config` SELECT。此额外 grant 只为跑通真实路径；它不是生产准入授权。生产仍需单独设计可信 admission 身份与最小权限。buyer LOGIN 本身是可信财务能力，并非可交给任意调用者的通用凭据。

## 验证

- PostgreSQL 18.6 原生测试：**1/1 PASS，26/26 阶段 PASS，隔离集群 cleanup PASS**。`node --import tsx --test scripts/db/cutover/postgres-shared-key-guardrail-post-reservation-denial-v348.native.test.mjs`，设置 `GATEWAY_NATIVE_PG_BIN` 为本地 PG18.6 bin。覆盖默认关闭、catalog/source pin、ACL 负例、精确 released/0、伪造 actual buyer/attempt 用量、晚插与并发插入、其他 release、曾标记 dispatch 后强制 release、仍 reserved、v2 幂等与旧 financial 路径。
- 真实 Hono Chat 路径：Guardrail 403 时上游 fetch 计数为 0，普通预约 released/0，quote claim、buyer log、v2 event 各一，买家扣款 0；模拟补偿释放失败时 HTTP 500，预约仍 reserved，quote claim 保留，buyer log 与 event 均不存在。
- Node admission 边界：**3/3 PASS**，分别验证 Guardrail 拒绝后释放、释放失败保留 owned reserved lease、普通预算拒绝时无预约可释放。`npm run typecheck -w @octafuse/proxy` PASS。

本次原生证据绑定的 SHA-256：v348 SQL `d679aecdef28a66bbc82b1e2afebface4d140ec2c7b7b38380133d64d960affb`；SQL builder `6b73b24b26a91348df6ccc3c15656244daabb8021ccf856679bf6ed52afec034`；native fixture `603646803c82d3209987260ad682a34169b4e53ca7b03b672d818e3a28d7cc13`；Node fixture `d0304c7165c8a22ba9558714b3f756d12983e90219c9a8d640e9d6d7f9d3eee1`。核心 critical writer、Chat、admission 和所有先前 SQL 的 SHA 记录在结果 JSON 中。被替换函数的 PostgreSQL `prosrc` MD5 分别为 producer `60a5e195951633119537e913169abb5e`、debit verifier `4fad800586f0f75bf00f254c79fd392d`、receipt verifier `84ae6d785faee4b5ea334f5d3ba29a7e`。

## 尚未闭环

私有 receipt 信任 buyer LOGIN 传入的 release reason 与现有 mark-before-fetch 协议；数据库没有独立的 Guardrail 拒绝事实来源。Guardrail admission 抛异常或其他释放原因没有精确证明，仍保持待查。release 失败后的 reserved orphan 也没有推断买家或 provider 成本。本测试未覆盖 seller consumer、release/adjustment、management、payout、C03 recovery、D1/MySQL、Linux CI。

本夹具只运行 v346/v347 buyer split，**未激活**独立的 v348 buyer-split marker。因此夹具末尾重跑旧 grant routine 会恢复普通 runtime 对 gateway 财务表的写权限；独立 marker 激活后会阻断这个旧 routine。当前独立 v348 buyer-split marker/grant reconciler 都钉住 v347 producer 的旧 `prosrc` MD5；若在 Guardrail v348 SQL **之后首次运行**，会因 producer hash 不符而 fail-closed。反向组合顺序尚未在本夹具验证，需单独兼容提案与组合测试。v1 producer 对普通 runtime 已关闭，旧调用者在迁移前仍需单独审查。
