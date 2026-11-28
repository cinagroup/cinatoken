---
title: Docker 部署入门
description: Docker 部署把管理后台与代理服务放在同一数据库边界内，迁移使用独立任务。
---

Docker 部署把管理后台与代理服务放在同一数据库边界内，迁移使用独立任务。

## 操作步骤

1. 按工程文档准备数据库、身份服务和运行环境配置。
2. 先运行目标版本的迁移任务，再启动对应的应用镜像。
3. 验证代理健康、管理员登录、公开目录和一条受控调用，再接入 Web 入口。

## 核对范围

应用启动成功不代表数据库结构、登录或真实调用已验收。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/operators/deployment/docker.md)
