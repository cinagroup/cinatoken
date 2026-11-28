---
title: Cloudflare 部署入门
description: Cloudflare 部署需要分别核对服务绑定、数据库与路由，不能只检查静态页面。
---

Cloudflare 部署需要分别核对服务绑定、数据库与路由，不能只检查静态页面。

## 操作步骤

1. 在正确账户与环境中生成配置，区分本地与远程数据库。
2. 按版本运行迁移和构建检查，再上传待发布版本。
3. 核对绑定、变量、域名与回调，切流后验证登录、目录和资源交付。

## 核对范围

同域 Web 入口只转发业务请求，不应额外获得数据库或生产主密钥。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/deployment/cloudflare.md)
