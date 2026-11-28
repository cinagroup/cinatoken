---
title: API 接入
description: 使用 OpenAI 兼容的聊天接口。
---

## 连接参数

| 参数 | 值 |
| --- | --- |
| 服务地址 | `https://api.cinatoken.com` |
| OpenAI 兼容客户端的基础地址 | `https://api.cinatoken.com/v1` |
| 聊天请求路径 | `/v1/chat/completions` |
| 认证请求头 | `Authorization: Bearer <网关调用密钥>` |
| 模型 ID | 从[实时模型目录](/zh/models)复制 |

客户端若会自动追加 `/v1`，请使用不含 `/v1` 的服务地址，避免形成 `/v1/v1/...`。

## 请求结构

```json
{
  "model": "从模型目录复制的调用 ID",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false
}
```

完整命令见[快速开始](/zh/docs/quickstart/)。先用简短文本确认连接，再增加图片、工具或其他参数。只有模型目录明确声明且端点支持的能力才可使用。

## 流式响应

设置 `stream: true` 时，客户端需要逐步读取事件流。连接关闭、超时和取消应在应用中处理，避免无上限自动重试造成额外计费。遇到错误时保留状态码和请求 ID。

## 管理接口与公开目录

模型详情中的公开能力信息不等同于管理员端点配置。管理接口有独立的认证和权限要求；`401` 不应通过在公开页面嵌入管理密钥来解决。
