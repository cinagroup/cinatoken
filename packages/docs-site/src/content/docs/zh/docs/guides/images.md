---
title: 图像生成与编辑
description: 图像请求需要已开通的图像模型与匹配端点，不能用文本模型 ID 直接替代。
---

图像请求需要已开通的图像模型与匹配端点，不能用文本模型 ID 直接替代。

## 操作步骤

1. 在实时目录确认图像模型、生成或编辑能力及输入要求。
2. 根据模型约定调用 /v1/images/generations 或 /v1/images/edits。
3. 核对尺寸、数量、返回格式及按张或按 token 的计量单位。

## 核对范围

参考目录中的图像预设不代表当前托管实例已开通对应路由。

[完整工程约定](https://github.com/cinagroup/cinatoken/blob/8fbaa084eeab5a0506f32f27da383e8f457836d0/docs/developers/reference/image-models.md)
