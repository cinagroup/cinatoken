---
title: OAuth 客户端与授权
description: OAuth 用于客户端按声明的权限访问受保护资源；它与 CinaAuth 网页登录的用途需要分别确认。
---

OAuth 用于客户端按声明的权限访问受保护资源；它与 CinaAuth 网页登录的用途需要分别确认。

## 操作步骤

1. 核对授权服务器与受保护资源的发现信息。
2. 按管理员规则注册客户端，使用准确的回调地址与适用的 PKCE 或客户端认证方式。
3. 完成授权后检查实际 scope、令牌有效期和撤销流程。

## 核对范围

旧版 OAuth 迁移文档说明当时的升级顺序，当前协议字段仍以 API 契约为准。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/migrations/0036-oauth-authorization-server.md)
