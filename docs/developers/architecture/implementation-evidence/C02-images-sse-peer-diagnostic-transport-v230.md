# C02.B2.2 — Peer 诊断传输、原窗口接入与封闭构建

2026-09-09；Checklist v1.129。STAGING_PARTIAL：诊断传输和协调器本地验证通过，独立候选 dry-run 通过；没有新部署或线上试验。

## 本次实现

新增诊断版客户端，复用原 V3 单一拒绝正文读取流程、同一升级请求、原 primary DTO 和 monotonic 时钟。只有完整、精确 canonical mismatch 且自然 EOF 后才形成诊断；最多 8 条、每条 2 KiB。记录原 78 字节正文、摘要、原响应时点以及验证后的两个公开诊断头，不保存 Access 凭据、任意响应头或错误页正文。

诊断作为独立 journal 事件保存，下一次观察连接必须等该记录保存确认。保存失败 / 超时停止发现，迟到确认不能改写封存记录。日志事件中的 `persisted:false` 表示该事件本身尚不能证明保存 ACK；客户端仅在收到实际返回后在本地封存报告中标记 true。

缺失或非法诊断值记为 UNAVAILABLE，不伪造分类，也不记录非法原值；这不改变冻结的 canonical mismatch 重试规则。重复 HTTP 头、非 canonical 正文、截断响应仍在原传输合同处终止，不产生诊断或下一次尝试。8 次 / 20 秒上限、单次推理、原容量报告和联合 native / 财务验收输入均不变。

诊断协调器已与原窗口、finalizer 组合：sidecar 同时进入原 journal 和外层窗口回执，严格的原 `peerReport` 不增字段。原 acceptance 不依赖这个 sidecar，因此它不能把容量仍占用、native 缺失或财务不一致提升为成功。

## 验证范围

新增 80 项运行检查：19 项诊断传输专项、44 项既有客户端用例在新客户端上的回归、17 项原窗口用例在诊断协调器上的回归。真实本地 HTTP/WebSocket、实际 Images handler、SQLite 结算和恢复链覆盖了不同实例首次拒绝后的成功观察、容量释放 / 仍占用分支以及失败收尾；WebSocketPair、native host-stop / tail、经过时间和管理服务仍明确模拟。

联合回归 2,392/2,392、staging 类型检查通过。旧 1,928 条发布摘要保持不变，本次发布核验 1,947 条摘要。新增 Node 22/24 CI 配置未在远端运行，本机 Node 24.14.1；不能据此声称 Node 22 或线上 Workers 已验收。

## 封闭候选

Wrangler 4.127.1 真实 `deploy --dry-run` 和绑定生成通过；790 个构建输入及产物摘要核验。配置与旧封闭 staging 相比只改变入口，原 D1 / service bindings / limits、空 routes / crons、workers_dev=false、preview_urls=false 不变。绑定接口与现有生成类型一致，未修改依赖、schema 或生产代码。

产物：`.wrangler/staging/sse-peer-diagnostic-v230/bundle/images-sse-capacity-peer-diagnostic-gateway.js`；SHA-256：`dcde110b43d8c9c859c4a0dfab24f8ef0798f2ba6131f25709e71e5fab5e16ce`。这是候选身份，不是云端部署回执。

Workers 最佳实践技能促使诊断保持有界、只读和单一正文所有权；Wrangler 技能用于核对 dry-run 和生成绑定。遵循用户资源隔离约束，显式关闭 autoconfig / 自动 provisioning，未采用技能中自动创建资源的通用建议。[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)，[Wrangler 命令文档](https://developers.cloudflare.com/workers/wrangler/commands/workers/)。

最初独立 `--version` 检查输出版本号，但默认用户日志目录写入被沙箱拒绝；随后候选构建脚本使用工作区内明确日志路径，三个构建步骤均 exit 0。没有因此扩大文件权限、重新登录或更改云端权限。当前官方 Workers types 版本查询为 5.20260908.1，与已有本地类型参考一致。

## 线上状态与后续

本轮 staging 管理 API / 公开 HTTP / D1 写入 / 真实模型 / KMS 均为 0，公开 HTTP 累计 406，真实模型 / KMS 0/0，US$2 累计上限不重置；最终增量账单未核实。文档和 npm 公共读取不计入 staging 试验请求。最后关闭读回仍为 v228 的 2026-09-09T05:41:52.641Z；历史总体 FAILED / 容量未证明保持，不能补写历史八次拒绝的具体分类。

下一步把新候选摘要、诊断协调器及累计 406 基线接入新的单次资源操作器 / CLI，再做独立 staging 新鲜前检、封闭上传和原预算内受控试验。旧 v227 deploy/run 已消费，禁止删除目录或重放；不增加推理重放、不修改发现上限或增设资源。完整容量、unknown / 幂等、C02.G、C01 和 C03–C20 仍开放。

[机器证据](./C02-images-sse-peer-diagnostic-transport-v230-results.json)
