---
title: 用户与管理员权限
description: 网关用户记录、CinaAuth 登录身份与工作区权限相互关联，但并不等价。
---

网关用户记录、CinaAuth 登录身份与工作区权限相互关联，但并不等价。

## 操作步骤

1. 在用户（Users）中核对主体、外部关联与当前状态。
2. 为调用方配置所需工作区与额度，并用受限密钥验证访问范围。
3. 管理员权限由 CinaAuth 角色与服务端复核决定；角色变更后重新完成管理员登录。

## 核对范围

创建网关用户记录不会自动创建 CinaAuth 账号或授予共享身份后台权限。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/integration.md)
