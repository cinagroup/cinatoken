---
title: 请求日志
description: 请求日志（Request Logs）用于关联调用、路由和用量，排查时优先使用请求 ID。
---

请求日志（Request Logs）用于关联调用、路由和用量，排查时优先使用请求 ID。

## 操作步骤

1. 按时间、模型、用户或请求状态筛选，确认时区与范围。
2. 打开详情，核对请求入口、实际路由、失败阶段和用量。
3. 将脱敏错误与客户端记录对照，必要时再做受控复现。

## 核对范围

不要把加载失败当成没有请求，也不要在排查材料中附带完整密钥。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/users/configuration.md)
