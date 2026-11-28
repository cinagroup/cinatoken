---
title: 管理概览统一入口
description: 管理概览统一到 /admin，旧 Dashboard 书签保留筛选条件后跳转。
sidebar:
  hidden: true
---

2026-11-27 UTC · CinaToken

管理控制台的概览入口统一为 `/admin`。旧 `/dashboard` 书签继续保留查询筛选条件并跳转到新入口。账户中心仍管理当前用户的工作区与调用密钥。

概览包括时段对比、延迟分位数、费用效率和故障汇总，并支持可选自动刷新。页面只在收到有效响应后显示数据，验证失败不代表用量或费用为零。

[进入管理控制台](/admin) · [管理员指南](/zh/docs/administration/)

[对应提交](https://github.com/cinagroup/cinatoken/commit/c280759bfe0bafba01de338e35aa3f40f480d54d)
