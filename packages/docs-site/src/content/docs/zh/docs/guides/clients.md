---
title: 客户端与 SDK 接入
description: 兼容客户端通常需要基础地址、网关调用密钥和模型调用 ID 三项配置。
---

兼容客户端通常需要基础地址、网关调用密钥和模型调用 ID 三项配置。

## 操作步骤

1. 从账户中心创建当前工作区的调用密钥。
2. 按客户端要求填写 https://api.cinatoken.com/v1；自动追加 /v1 的客户端使用不含该后缀的地址。
3. 复制实时目录中的模型 ID，先发送简短文本，再启用其他能力。

## 核对范围

客户端的账号登录状态不能替代 API 请求中的网关调用密钥。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/connect-clients.md)
