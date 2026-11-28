---
title: 模拟器
description: 模拟器（Simulator）通过真实代理服务验证调用，因此与离线预演不同。
---

模拟器（Simulator）通过真实代理服务验证调用，因此与离线预演不同。

## 操作步骤

1. 选择当前有权限使用的网关调用密钥、模型和请求入口。
2. 核对将发送的参数，先用最小样本执行。
3. 根据请求 ID 检查鉴权、路由、用量、费用和日志结果。

## 核对范围

模拟器可能产生实际消费；调试台成功不代表模拟器的正式路径已通过。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/features.md)
