---
title: 管理审计日志
description: 审计日志（Audit Logs）追踪管理变更的主体与对象，不替代模型调用日志。
---

审计日志（Audit Logs）追踪管理变更的主体与对象，不替代模型调用日志。

## 操作步骤

1. 根据时间和变更对象查找对应管理操作。
2. 核对操作主体、目标及结果，再关联请求或业务回执。
3. 发生结果不明确的写入时，先刷新对象与审计记录，再决定是否重试。

## 核对范围

管理页面的成功提示不能取代服务端回执和已保存状态的核对。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/api/admin.md)
