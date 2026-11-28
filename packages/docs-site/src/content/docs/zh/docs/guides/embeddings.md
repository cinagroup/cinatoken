---
title: 向量模型
description: 向量模型返回用于检索或相似度计算的向量，不生成聊天回复。
---

向量模型返回用于检索或相似度计算的向量，不生成聊天回复。

## 操作步骤

1. 确认实时目录有可调用的向量模型与所需维度。
2. 使用兼容的 /v1/embeddings 请求或模型声明的原生入口。
3. 核对输入批量、长度限制、向量维度及输入用量。

## 核对范围

更换模型或维度可能需要重新生成已有索引，不能仅替换调用 ID。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/api/user.md)
