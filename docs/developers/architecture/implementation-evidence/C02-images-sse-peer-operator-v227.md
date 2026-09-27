# C02.B2.2 — V3 固定资源执行器与 CLI

日期：2026-09-09；Checklist v1.126。状态：STAGING_PARTIAL。V3 资源执行器、拒绝响应留证与 CLI 已接通；尚未部署 V3 或取得真实 Workers native 验收。业务成功结算点保持“有效 completed 图片及实际上游 DONE”，本轮未修改生产结算算法。

## 固定范围与执行链路

新的 CLI 固定绑定 v222 的 V3 构建、staging Worker / D1 / Access、Wrangler 4.127.1 和累计 390 次公开 HTTP 基线。仅接受本地核验、封闭部署、一次执行三种模式，不接受环境 / 目标 / 恢复参数。所有已发布文件和构建输入必须与摘要一致；原封闭状态和部署后的内容 / 版本均需新鲜前检。本地测试中的前检为模拟，不能作为线上前检回执。

执行器使用同一个 session、预算和原 tail collector：先前检实际 V3 内容摘要，再创建自有 tail / token、配置双 Access、六次鉴权探测、一次原子 seed，随后进入既有 V3 单请求窗口。原响应只有一个 reader；观察端不能 clone / tee。恢复调用先消费并留 PENDING，回执丢失不重放。结束时关闭固定入口、撤销自有资源，并在原始 native / D1 / 财务事实和安全期全部成立后才清理合成数据。

CLI 保留独占尝试目录、append-only fsync 日志、固定无 shell 子进程、禁止自动资源创建 / 自动配置和默认关闭入口的边界。本轮没有运行部署子进程，也没有重新打包候选；对应 CLI 行为由本地测试检查。

拒绝捕获只读取唯一推理 POST 的非 200 响应，保留实际状态、SHA-256 摘要、是否自然 EOF，不保存响应原文或敏感头。上限仍为 8 KiB / 128 次读取 / 2 秒读取 / 1 秒持久化。V3 primary 只接受七种精确、完整、HTTP 状态匹配的声明；watch 或旧协议拒绝不再被误认为 primary 声明。声明也不授权重试、不证明结算或 native。日志失败或封存期间迟到回调不能把失败升级为成功。外层 report 返回与最终结果一致的拒绝留证状态。

## 验证

新增 86 项测试：20 项完整资源执行器（4 个成功 / 占用组合和 16 个故障），24 项 CLI，42 项拒绝留证。包含 preflight / 内容不匹配零写入、tail / token 创建 ACK 丢失、Access / seed / 日志失败、primary 409、恢复 ACK 丢失、证据封存失败及最终隔离漂移。

完整链路运行实际 Images handler、SQLite 事务 / 恢复 / 去重 / 清理、真实回环 HTTP 和 WebSocket、原请求 signal、原 tail collector 与 V3 判定器。管理 API / preflight、WebSocketPair 适配、native host-stop envelope 和取消后的长时间推进为显式本地模型；没有运行 workerd，不能声称线上容量或 isolate 驱逐已通过。

联合回归 **2,274/2,274 PASS**，失败 / 取消 / 跳过均为 0，staging 类型检查 PASS；最终由[验证回执](../../../../.wrangler/staging/sse-peer-operator-v227-verification-result.json)和[机器清单](./C02-images-sse-peer-operator-v227-results.json)确认。验证前后核对既有 1,880 条摘要及新增 10 个源代码 / 测试 / CI 文件；新清单合计 1,898 条摘要。Node v24.14.1，验证子进程移除 Cloudflare 凭据。Node 22 / 24 CI 已定义，远端 CI 与本机 Node 22 未验收。

初次四项联调失败记录仍保留。仅增加 setImmediate 的第二次尝试也失败；随后抓到 12 次实际查询均为 armed / 无 pending job，而 abort 后才出现 held / pending。原因是加速时钟提前耗尽轮询，真实异步写入尚未完成。夹具现在在原请求取消前按实际间隔等待，取消后才加速长安全期；没有更改执行器超时、替换快照或放宽校验。见[原始观察](../../../../.wrangler/staging/peer-v227-initial/observation.json)及[诊断更正](../../../../.wrangler/staging/peer-v227-initial/follow-up.json)。未归档的终端输出不冒充完整原始记录。

## 下一步与费用

下一步以新清单完成 CLI 本地完整性核验，然后对封闭 V3 候选执行实际部署前检 / 发布 / 内容读回，之后才开始一次受控 Workers 验收。不能重放已消费的历史尝试或通过删除尝试目录重试。

本轮 Cloudflare API、公开 HTTP、远端 D1 写入、部署、模型 / KMS、生产写入均为 0；最后真实云端观察仍为 v220，已部署网关仍 V2。公开 HTTP 累计 390、模型 / KMS 0/0，首轮累计 US$2 上限不重置；最终增量账单未核实。C02 保持 DOING，物理 / 跨消费者容量、unknown / 幂等、C02.G、C01 和 C03–C20 仍开放。
