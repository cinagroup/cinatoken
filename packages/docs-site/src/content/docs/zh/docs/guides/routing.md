---
title: 模型路由与回退
description: 路由（Routes）连接客户端请求入口与上游目标。优先级控制跨层主备，策略决定同层候选顺序。
---

路由（Routes）连接客户端请求入口与上游目标。优先级控制跨层主备，策略决定同层候选顺序。

## 操作步骤

1. 选择模型与请求入口，确认两侧协议和上游模型名称。
2. 按业务要求设置优先级、权重与层内策略，确认供应商和路由均启用。
3. 验证首选目标与允许的故障转移行为，并检查请求日志。

## 核对范围

供应商粘性是一项路由池规则，不是额外的第五种选路策略。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/reference/route-strategies.md)
