# C03 v292：原生验收入口与 Windows 运行库阻塞

2026-09-21，Checklist v1.189。**原生验收未通过：NATIVE_STARTUP_BLOCKED。** 上一轮属于实质进展；本轮新增隔离原生测试入口，并取得改变下一步动作的本机失败证据。C03 仍 DOING，完整目标不变，不勾选 ST-01–ST-03 或 C03.G。

## 新增入口，尚未通过原生测试

- [隔离集群 fixture](../../../../packages/core/src/test-support/postgres-native-cluster.mjs)：只接受显式的二进制目录，不接受连接 URL / 既有数据目录；新建项目内随机目录、随机测试用户名/密码、SCRAM、本机 127.0.0.1 高位端口。启动后检查实际 data_directory、端口、fsync / synchronous_commit / full_page_writes；结束时确认停库后才删除测试目录。
- [COMMIT 回包代理](../../../../packages/core/src/test-support/postgres-commit-ack-proxy.mjs)：真实服务器返回 COMMIT CommandComplete 时截断本机 TCP 回包，验证提交已存在但原 caller 不得获 grant / 自动重放；不记录认证包或参数。
- [原生测试](../../../../packages/core/src/storage/recovery/dispatch-intent.postgres-native.test.mjs)：计划执行八个独立 backend 的竞争、真实行锁等待跨到期、事务开始时间的反例、lock_timeout、终止被阻塞 backend、claim 唯一冲突、两种 prepared 模式下的真实 COMMIT ACK 丢失、身份隔离、受限角色和非资金分类。

上述三文件仅通过 `node --check`，**业务测试一个也没有运行到**，不宣称代理、并发、最小权限或清理自动化已经验收。启动失败发生在安装 proposal / 68 个迁移之前。v291 的五个代码产物 SHA-256 均与原证据一致；未重跑其 49 / 19 / 77 测试，不将旧结果计作本轮原生通过。

测试中的 15 秒 statement / idle-in-transaction timeout、250 ms lock_timeout、24 个最大连接仅是隔离夹具参数，不批准 C01.10 生产值。运行期权限 probe 是待执行场景，不能据其名称宣布权限结论。

## 本机环境与便携工具来源

只读检查未找到 PATH 或常见安装目录中的 PostgreSQL / Docker / Podman；首次 WSL 清点因沙箱权限失败，获准的只读检查确认 WSL 没有已安装发行版。操作系统为 Windows 11 Pro for Workstations，10.0.26200，64 位。

[PostgreSQL 官方 Windows 页](https://www.postgresql.org/download/windows/)提供不运行安装器的 EDB ZIP 入口；[EDB 公开二进制页](https://www.enterprisedb.com/download-postgresql-binaries)列出 18.6 x64。其 fileid=1260566 经 HTTPS 跳转到正式包 `postgresql-18.6-4-windows-x64-binaries.zip`。

下载保存于项目忽略目录 `.wrangler/staging/pg-native-v292-binaries/`，382,815,572 字节，SHA-256 为 `1df55002afe95b945d934c078b13e82c1603fa546731e511d068aa983b4ead28`。仅解出 `pgsql/bin`、`pgsql/lib`、`pgsql/share`，逐项校验解压目标不越界；未运行 PostgreSQL 安装器，不安装服务、不更改 PATH / 注册表。`postgres --version` 实际返回 18.6。postgres.exe 的 Authenticode 状态为 NotSigned；本地摘要只证明下载内容身份，不冒充发行方签名证明。便携缓存保留供修复运行库后重验。

## 两次失败与收尾

| 尝试 | 实际结果 | 处理 |
| --- | --- | --- |
| 默认沙箱 | 1 FAIL / 0 PASS，30,253.4454 ms；initdb 无法创建/重执行受限 token，错误 87 / 3 | 检查发现便携目录下唯一的 `postgres --single` 初始化子进程 PID 12972，父 PID 13764；核对路径、父进程和命令后终止。确认退出后清理固定测试目录 `run-w5HAyQ` |
| 获准非沙箱 | 1 FAIL / 0 PASS，8,026.7097 ms；initdb 子进程异常 `0xC0000005` | Windows 应用事件确认 postgres.exe 崩溃于系统 MSVCP140.dll；initdb 自行删除 data，另核实无原生测试进程后清理只剩临时密码文件的 `run-ao5HWM` |

首轮 fixture 曾在不明确 bootstrap 子进程是否退出时尝试清理，收到 EBUSY，不能当作成功。已修改：任何启动未确认都保留目录；不能以“没有 postmaster.pid”推断 `--single` 子进程已退出，必须检查明确归属再清理。修改后的第二次失败没有自动删除失败现场。

2026-09-21 09:15:40 UTC 前的最终进程/目录核验：本轮便携 initdb / postgres / pg_ctl 进程 **0**，测试 run 目录 **0**。删除的均为本轮生成的可重建测试数据/临时随机密码；没有删除用户或 staging 数据。没有启动持续服务。

## 已确认的崩溃事实，不夸大根因

Windows Application 事件 1000，2026-09-21 17:11:29 +08:00：

```text
Application: postgres.exe 18.0.6.0
Fault module: C:\Windows\System32\MSVCP140.dll
Module version: 14.0.24215.1
Exception: 0xc0000005
Fault offset: 0x0000000000018c34
Report ID: cb1e63d3-2810-45ca-9727-35c1d851bbb0
```

只读检查系统 MSVCP140.dll 与 vcruntime140.dll 均为 14.00.24215.1。[Microsoft 官方运行库说明](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)要求运行库版本不早于应用所用构建工具，并提供当前 v14 x64 下载。**运行库兼容问题是待验证推断**；崩溃模块不能单独证明旧版本是唯一根因，也不能据此断言之前 workerd 的访问冲突属于相同问题。

已询问是否允许安装/修复 Microsoft 官方最新版 v14 x64 Redistributable；系统级更新尚未获答复，因此本轮**未下载或运行 VC++ 安装器、未更新系统 DLL、未重启**。Firecrawl 开发者检索仅作线索，不将第三方讨论当成确定诊断。

## 下一有限步骤

1. 用户同意系统运行库更新后：核验官方安装包签名/版本，执行明确获准的安装/修复；若要求重启，单独告知，不自动重启。
2. 更新后核实 DLL 版本并重跑同一原生 suite；若仍崩溃，保留新事件，不把安装成功当数据库验收通过。不要改接未授权的远端 DATABASE_URL。
3. 若用户不允许系统更新，保持原生门禁开放，另选经批准的隔离运行环境；可继续不依赖原生启动的不可变结算模型设计/本地实现，但不能用其替代原生证据。

手动复跑入口（仅在运行库问题处理后、按需要获准非沙箱执行）：

```powershell
$env:GATEWAY_NATIVE_PG_BIN = (Resolve-Path '.wrangler/staging/pg-native-v292-binaries/extracted/pgsql/bin').Path
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/dispatch-intent.postgres-native.test.mjs
```

本轮公开文档 scrape 3 次、公开 developer 检索 1 次，以及 EDB 包 HEAD/GET；无 Cloudflare / GCP 管理、远端 SQL、部署、付费模型或 KMS 调用。首轮累计 US$2 不重置；C02 既有云端阻塞、C01 未决政策与完整 C00–C20 范围不变。[机器摘要](./C03-postgres-native-runtime-v292-results.json)
