# C02.B2.2 — 零字节控制命令与真实空队列恢复调用

2026-09-07；Checklist v1.59。**合法空 POST 兼容问题已修复，真实 Access → 私有 RPC → staging D1 的空队列调用通过；非空账务恢复和 C02.G 未通过。** 完整过程见 [结果 JSON](./C02-staging-recovery-empty-command-results.json)，保留 [v1.58 失败冒烟](./C02-staging-recovery-access.md)，不改写历史结论。

## 1. 根因与修复

仅修改 [控制运行时](../../../../packages/proxy/src/runtime/usage-recovery-control.ts) 和 [控制测试](../../../../packages/proxy/scripts/staging/usage-recovery-control.test.mjs)，其余 64 个锁定源文件摘要保持。无 schema、财务规则、接收端或源配置模板修改。

先在不放宽校验的诊断版本中，将组合错误拆成只对原生 Access 授权请求返回的固定 reason。真实客户端的“不传 body”“显式 Content-Length: 0”“显式空字符串 body”均返回 `body_present`，说明此前正文身份检查是实际拒绝点，而不是 Origin / 命令头 / Transfer-Encoding / 长度条件。诊断不回显任何原始头部、正文、用户资料或凭据。

修复将合同从 **JS 对象必须为 null** 改成 **正文实际为零字节**：

- Access、配置、命令头等校验保持；先取得 isolate 的 scalar busy 准入并登记 `waitUntil`，才读取正文。
- null 正文可直接通过；非 null 正文只使用 BYOB reader，一次读取、提供 1 字节缓冲，必须返回真正 EOF 且零字节才能调用 RPC。任何实际字节都拒绝，不累计、不解析、不 drain、不 clone，也不回退 default reader 的任意大小块。
- 不支持 BYOB 的内部流、已消费/锁定正文和读取错误均 fail-closed。Node 24 的标准 Request 空字符串样本通过，不等于 Node 22 或任意适配器已验收。
- 正文阶段设 1,000 ms 期限；取消产生的 `done=true` 不当作成功 EOF。读取或取消 Promise 尚未结束时不释放 busy、不排队、不发 RPC。若底层取消卡住，这是保留占用，不是保证 1 秒内响应；不能宣称物理资源已释放。
- EOF 后移除正文计时器/监听器；在途 RPC 仍按原合同持有直至结果真正结束，不由正文计时器或客户端断开推断 D1 已取消。

BYOB 使用调用方提供的缓冲，可约束此次读取的输出块；这不等于测出了整个 HTTP 传输、isolate、D1 或恢复工作集的物理内存上界。[Workers BYOB Reader](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreambyobreader/)

## 2. 真实平台验证

沿用专用 staging Access 应用 `2ed1f9a7-7eb3-45ad-8cdc-392f7ae96bc0` 和独立 D1 `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`。本轮只上传控制 Worker 两次：诊断版本 `a69e6fa0-33c1-4a79-81d3-05294fe26aee`，最终修复版本 **`e3a1830b-cb71-4256-bffe-55d263cf75c9`**。接收端仍为 `cde8d551-3aa1-4678-8202-374fef9ba722`，没有重新上传。

诊断 5 次 HTTP：未认证 / 错令牌各 401，三种空请求均 400 body_present。

修复后复验 11 次 HTTP：

- 未认证就绪探针 404 → 401；错误令牌 401。只在确认 Access 拒绝后发送有效身份请求。
- 错误方法 / query 各 404；缺命令和带 Origin 各 400，且固定 reason 分别命中对应条件。
- 一字节正文被 Content-Length 检查以 400 拒绝。本轮线上这一负例未单独触发 BYOB 非空拒绝；伪造零长度的 BYOB 拒绝由本地对抗测试证明，不混淆两者。
- 三种空请求均 **200 finished**，产生三个不同 runId；所有任务计数为 0，capacityLimited / admissionStopped 为 false，retry_safe=false。真实接收端已执行 schema 核对和空任务扫描，不是模拟 RPC 响应。

原生 Access 上下文只属于控制端直接调用，不会沿 Service Binding 传播；接收端授权来自只授予控制 Worker 的命名绑定，不伪造用户身份。[Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

## 3. 收尾、验证与失败记录

两轮均按关闭入口、禁用本轮令牌、关闭 service-auth 401 模式、恢复 deny-all、删除令牌并回读的顺序完成。两个临时令牌都已删除；秘密仅存在于操作进程内存。删除是实际撤销，不以关闭网页或结束本机进程代替。[服务令牌撤销](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

最终只读核验通过：四个相关 staging Worker 的 workers.dev / previews 均关闭；专用 Access deny-all；接收端/控制端版本符合预期；生产三个设置指纹和其他 Access 应用未变。24 个恢复对象定义通过，56 张表行计数不变，恢复四表仍空。完整内容散列、非空旧数据回填不在这些证据内。

本地最终控制 suite **72/72**（基线 56，净增 16）；完整 staging 链 **35 + 7 + 130 + 39 + 65 + 76 + 24 = 376** 全部通过，最后 24 项进程退出测试等待至退出码 0。staging、dispatch-safety 两项定向 TypeScript 检查和命名 RPC 绑定 types --check 通过。完整 Core 类型检查本轮未重跑，历史 32 条诊断不宣称已修复。

保留两个非成功过程：修复初稿运行 61 项测试时，旧的“空字符串必须拒绝”和旧 body_present reason 预期共两项失败；更新为真正 EOF / 非空字节的合同，并增加取消、超时、busy、错误和锁所有权测试后通过。首次最终只读检查还错误地要求已重新发布的控制 Worker 保留 v1.58 设置摘要；回读完整非敏感配置后改为验证完整已审阅配置及新版本，未变的接收端/生产仍要求旧摘要。未通过修改云端状态来迎合旧断言。

## 4. 费用与剩余门禁

本轮 **109 次显式管理 API 请求**，不含 Wrangler 内部未计数请求；10 次只读 REST SQL 查询元数据读 **1,677 行、写 0 行**。三次 Worker RPC 的 D1 行数元数据未采集，不把 REST 行数称为全部 D1 使用量。公网 HTTP 新增 **16**、首轮累计 **124**；模型/KMS 均 0，无生产写入、套餐升级或真实付款。首轮累计 **US$2 不重置**，最终增量账单未核验。

本轮成功范围只有控制协议、保护入口及真实空队列执行。下一项仍为 C02.B2.2：准备有界合成非空/正数费用快照，验证真实消费者的预算、日志、回执、任务原子状态和重复执行不重复记账，再测平台终止/重启及完整物理工作集。64 MiB 继续是实验分配，生产容量未启用；原线上漏日志事件、C02.G 和后续工作包不因空队列成功而关闭。
