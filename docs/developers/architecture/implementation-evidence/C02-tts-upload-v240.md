# C02：语音克隆上传资源所有权（v240）

日期：2026-09-10。结论：**LOCAL_PASS，未部署**。C02.G、C01、原生 Workers 原实例容量与后续依赖仍未通过。

## 实际缺口与修复

v239 只登记 TTS 响应资源，克隆上传源虽然会在 finally 中停止，但未参与 `resourceCompletion`。因此，即使 fetch 仍锁定着尚未读完的上传流，成功响应、错误响应或取消后的迟到响应清理仍可能让资源结果为 `confirmed`，进而释放可选逻辑容量。

本轮把克隆上传登记在认证／准入／fetch 之前，随同当前尝试进入已有资源汇总。编码器独立持有可清空的状态，按需拉取，不在准入等待时预取；完成、取消、错误或强制停止时清空它自己的音频引用、prefix、suffix 和游标，不修改调用方的音频数据。

完整读取至源 EOF、消费者主动取消，以及从未读取且未锁定的源可确认结束。强制停止未完成上传、未读但仍锁定的上传和编码异常均为 `unconfirmed`。晚到解锁、响应 ACK 或经过某个超时时长不改变这个结果；逻辑容量继续保留数字预留。该保守策略有可用性代价，不能当作容量方案已经完成，生产容量开关仍关闭。

金融算法、未知结果规则、重放权限、参考音频格式以及 Images 不可逆成功点均不变。仅把资源完成事实纠正，不用上传清理状态撤销已取得的有效用量事实。详见 [上传资源合同](../../reference/tts-upload-resource-policy.md)。

## 验证

最初 24 项测试出现 6 个失败，其中一个是测试错误：`Response.arrayBuffer()` 消费后仍持有 reader，测试又调用 `body.cancel()`。已将它改成显式持有 reader、完整读取、reader.cancel 再 releaseLock；初始测试归档，不把该失败算作产品缺陷。

校正并冻结同一份 24 项测试后，真实修复前 **19 PASS / 5 FAIL**，修复后 **24 PASS / 0 FAIL**。五个失败分别覆盖：接受响应、拒绝响应、客户端取消、deadline 时的锁定部分上传，以及响应取消 ACK 不应掩盖上传未结束。此后仅作运行时代码缩进整理，并补充六项测试，最终范围为：

| 范围 | 数量 | 证据边界 |
| --- | ---: | --- |
| 四种强制停止与容量隔离 | 4 | 真实驱动＋资源调度器／数字池，未经过公开克隆路由 |
| 八种字节长度 × raw/data URI | 16 | Base64 分块、余数、JSON 内容及 EOF，调用方数据不被修改 |
| 未使用、主动取消、EOF 后取消 | 3 | 明确生产者终点保持可确认 |
| 响应 ACK 与上传分离 | 1 | 响应清理不能覆盖上传未确认 |
| 未读锁定、部分读取后解锁、suffix 后尚无 EOF | 3 | reader 状态或最后一块不等于完整消费 |
| 编码异常 | 1 | 固定安全消息，不把异常当作清理成功 |
| 准入写入等待期间取消 | 1 | 不预取、不继续发送，等待已开始准入收尾 |
| 原生 Node HTTP 上传 | 1 | 真实本地 socket、完整 JSON 与参考音频、一条请求，非 Workers |

最终专项 **30/30**；完整 dispatch 回归 **3,187/3,187**（包含此前 3,157 项），无失败／取消／跳过；dispatch 与 staging 类型检查均通过。新测试已接入 `test:dispatch-safety` 和 `test:unit`。最终进程正常退出 0，未用旧进程状态推断成功。

```powershell
node node_modules/tsx/dist/cli.mjs --test packages/proxy/src/services/egress/tts-upload-resource.test.mjs
node node_modules/typescript/bin/tsc -p packages/proxy/tsconfig.dispatch-safety.json --noEmit
node node_modules/typescript/bin/tsc -p packages/proxy/scripts/staging/tsconfig.json --noEmit
```

完整回归命令、源码摘要、退出码及原始日志在 `.wrangler/staging/tts-upload-v240-final-verification.json`。修复前／后对照分别存于同前缀的 `before-verification.json` 和 `after-verification.json`；比较用测试与中间驱动版本按字节归档。未重跑远程 CI、Node 22 或历史 staging 全套。

## 平台边界与下一步

按 workers-best-practices 技能重新查阅 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)和当前 `@cloudflare/workers-types@5.20260910.1` 的流 API；官方 npm 查询确认版本未变化，使用已下载的相同版本检查，未升级依赖或配置。技能促使本轮明确登记资源任务、避免隐式预取和跨请求上传状态；没有添加云队列或其他资源。

`confirmed` 只证明登记的本地生产者终结，不证明网络发送 ACK、调用方请求引用清空、GC 或原生 Workers 内存释放。`waitUntil` 的平台期限仍适用。本轮没有新增公开克隆路由端到端测试，也没有真实数据库扣费、原生 Workers 上传或原实例容量证明；已有公开 speech 响应生命周期测试随完整回归通过，不能将其冒充新增上传端到端验收。

下一步继续其余 JSON／ASR／上传消费者的资源登记、数据库初始化与写入自身时限，再制作新冻结候选做受控原生 Workers 验收。旧部署不含本轮变更；不重放不确定请求，不以碰撞式请求寻找同一实例，生产容量不启用。

## 历史与费用

继承 v239 的 2,204 条摘要记录；两份受影响旧源码按原路径＋SHA 重定位到本轮 `before-source` 目录，旧 manifest 不重写。精确总数及完整哈希验证见 [机器证据](./C02-tts-upload-v240-results.json)。

本轮 staging 管理／公开调用、部署、生产写入、付费模型和 KMS 均 0。首轮累计公开 HTTP 422，模型/KMS 0/0；US$2 上限不重置，US$1.20 历史／延迟预留与 US$0.80 未分配仍是操作预算，非核实后的账单。最后远端观察仍为 v232（2026-09-09T06:45:06.937Z），本轮未刷新云端状态或最终增量账单。
