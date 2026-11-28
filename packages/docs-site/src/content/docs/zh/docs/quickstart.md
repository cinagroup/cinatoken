---
title: 快速开始
description: 完成第一次模型调用。
---

## 1. 登录并选择工作区

打开[账户中心](/account)，使用 CinaAuth 完成登录。确认当前工作区；密钥和数据按工作区隔离。

## 2. 创建网关调用密钥

在账户中心的网关调用密钥（Gateway API keys）区域选择创建密钥（Create key）。为应用设置名称、消费上限和过期时间。完整密钥只在创建时显示，请立即保存到服务端的密钥管理工具。

消费上限为 `0` 会阻止计费调用。调用还受账户、工作区额度和实际模型可用性约束。

## 3. 从实时目录选择模型

在[模型目录](/zh/models)复制当前可用模型的调用 ID。不要直接使用文档中提及的模板名称。

## 4. 发起请求

在本机设置 `CINATOKEN_API_KEY` 和 `CINATOKEN_MODEL`。不要将密钥粘贴到公共代码仓库、截图或前端代码中。

```bash
export CINATOKEN_MODEL='从模型目录复制的调用 ID'
# CINATOKEN_API_KEY 由你的环境或密钥管理工具提供。
curl https://api.cinatoken.com/v1/chat/completions \
  -H "Authorization: Bearer $CINATOKEN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$CINATOKEN_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"
```

响应应包含模型回复。发生错误时，保留 HTTP 状态和请求 ID，按[故障排查](/zh/docs/troubleshooting/)处理。

下一步：[API 接入](/zh/docs/api/) · [密钥管理](/zh/docs/keys/)
