# ASR JSON 上传与原生长度声明合同

本合同补充 [ASR 响应合同](./asr-resource-completion-policy.md)及 [multipart 上传合同](./asr-upload-resource-policy.md)，覆盖 DashScope Qwen3、Qwen-Audio、Fun 同步 ASR、异步提交和原生多模态 JSON 透传。它不代表整个请求工作集、Workers 线上传输或容量已经验收。

## 表示与所有权

五条出站 JSON 路径使用请求局部 owner：准入前快照 JSON 投影、计算精确编码长度并登记资源任务，pull 时按至多 64 KiB 页面编码。既有 JSON 编码器的结束回调可能与最后一页入队同时发生，外层 owner 因此要求消费者真正读取到 EOF，不能把编码结束当作消费完成。

同步音频以 24 KiB 原始片段编码为最多 32 Ki 字符的 Base64 页面，只有末页包含填充；不拼接完整二进制字符串、Data URL 或请求 JSON。**页面仍在准入前全部构造并保留，不是音频 Base64 的惰性生成，也不是 O(单页) 的全部请求内存。** Data URL 的既有 10 MiB 校验保持不变；公开入口的 MIME 约束继续适用。

旧导出的字符串构造辅助函数保留默认契约；实际同步 dispatch 传入分页编码器。`provider.options` 的既有拒绝／映射规则、提示词、格式与语言参数、异步轮询和结果下载语义不变。字符串快照不可变共享，容器复制；内部 getter／toJSON 在快照时执行一次，不在网络 pull 时执行。

上传在认证及持久化准入前登记。客户端取消不遗弃准入写入；所有返回／抛错路径都停止上传。异步提交收到响应后立即停止上传源，轮询只读取任务状态，不接管或重新发送原始提交。

## 完成与账务

- 外层消费者 EOF 或消费者 cancel 的内部清理完成，可以确认已登记上传源。
- 从未 pull、当前未锁定的源被停止，可以确认没有交付页面。
- 强制停止锁定未读、部分读取、部分读取后解锁、只读完最后页面未读 EOF 的源，均为 `unconfirmed`。
- 迟到响应及其取消 ACK 仍归原请求；响应 ACK 成功不能覆盖上传的未确认结果。
- 内部编码／取消错误归一化为安全结果；不把任意 abort 原因或异常详情返回客户端。

上传完成不等于对端处理成功。已经明确成功或失败的推理沿用原有账务分类；资源失败不改金额、不授权重放。Images completed＋真实上游 `[DONE]` 的不可逆成功点保持不变。

## Workers 长度声明

普通流仅手工设置 Content-Length，不能保证 Workers 原生定长传输。[官方类型](https://www.npmjs.com/package/@cloudflare/workers-types)和 [workerd 流实现](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/streams/standard.c%2B%2B)提供 `UnderlyingSource.expectedLength`：当前实现将它交给原生长度查询，并在 Request 转移流时保留该值。因此 multipart 与 JSON 的最外层源直接声明精确长度，不额外引入 FixedLengthStream 的转发泵、缓冲和完成 owner。Node 忽略该扩展，继续使用显式 Content-Length。

这是实现依据，不是本轮原生运行证明。Node 字节／长度检查与源参数检查通过，但 Windows 本机 workerd `1.20260828.1` 在启动阶段出现 `0xc0000005` 访问异常，没有执行测试请求。未更改系统运行库，也没有反复重启或将失败标为跳过／通过。

可在能够正常启动 workerd 的本地或 CI 环境执行专项：

```powershell
node --test packages/proxy/scripts/staging/asr-upload-workerd.test.mjs
```

该专项使用真实 workerd 和仅监听 127.0.0.1 的合成 HTTP 上游，不访问模型或 KMS。它尚未通过；通过后也只证明本地 multipart 请求的长度／字节契约，不代替 Cloudflare staging 的完整驱动、取消及原实例容量验收。JSON 的原生 wire 专项亦仍待补齐。

下一步继续剩余 JSON／错误正文消费者、入口与数据库自身时限，同时为新冻结构建补全原生传输验收。生产容量不开启，C02.G、C01 及下游依赖仍未通过；不得把平台终止期限或 TTL 当作资源释放证明。
