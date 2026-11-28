---
title: 调试台
description: 调试台（Playground）用于验证单条上游或工具引擎配置，与正式代理调用分开。
---

调试台（Playground）用于验证单条上游或工具引擎配置，与正式代理调用分开。

## 操作步骤

1. 选择需要核对的具体路由、协议或工具引擎。
2. 检查预览中的上游地址、模型名称与生效参数，再发送受控样本。
3. 确认上游结果后，再通过正式网关请求验证完整路由和计费流程。

## 核对范围

调试台不走网关正式计费、日志和故障转移；上游服务本身仍可能计费。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/features.md)
