# CINATOKEN 品牌迁移完整方案

**版本**: v1.0  
**日期**: 2026-04-04  
**目标**: 将 New-API 项目完全迁移到 CINATOKEN 品牌

---

## 📋 目录

1. [项目概述](#1-项目概述)
2. [品牌元素清单](#2-品牌元素清单)
3. [迁移步骤](#3-迁移步骤)
4. [文件修改清单](#4-文件修改清单)
5. [测试验证](#5-测试验证)
6. [部署检查](#6-部署检查)

---

## 1. 项目概述

### 1.1 当前状态

- **项目名称**: New API / new-api
- **GitHub**: github.com/QuantumNous/new-api
- **Docker**: calciumion/new-api
- **系统名称**: "New API"

### 1.2 目标状态

- **项目名称**: CINATOKEN
- **GitHub**: github.com/cinagroup/cinatoken
- **Docker**: cinagroup/cinatoken
- **系统名称**: "CINATOKEN"

---

## 2. 品牌元素清单

### 2.1 需要替换的文本

| 原文本 | 目标文本 | 出现位置 |
|--------|----------|----------|
| New API | CINATOKEN | 所有 UI 文本 |
| new-api | cinatoken | 代码、配置、URL |
| New-API | CINATOKEN | 文档、注释 |
| Calcium-Ion | cinagroup | GitHub 组织名 |
| calciumion | cinagroup | Docker 用户名 |
| QuantumNous | cinagroup | Go module 路径 |

### 2.2 需要替换的图片

| 文件 | 路径 | 替换内容 |
|------|------|----------|
| logo.png | web/public/logo.png | CINATOKEN Logo |
| favicon.ico | web/public/favicon.ico | CINATOKEN Favicon |
| icon.png | electron/icon.png | CINATOKEN 图标 |
| tray-icon*.png | electron/ | CINATOKEN 托盘图标 |

### 2.3 需要修改的配置

| 配置项 | 原值 | 目标值 |
|--------|------|--------|
| SystemName | "New API" | "CINATOKEN" |
| module 路径 | github.com/QuantumNous/new-api | github.com/cinagroup/cinatoken |
| Docker 镜像 | calciumion/new-api | cinagroup/cinatoken |

---

## 3. 迁移步骤

### 3.1 准备阶段

#### 步骤 1: 备份当前代码
```bash
cd /home/cina/.openclaw/workspace
mv cinatoken cinatoken.backup
git clone https://github.com/cinagroup/cinatoken.git
cd cinatoken
```

#### 步骤 2: 创建品牌资源
准备以下文件：
- CINATOKEN Logo (PNG, SVG)
- CINATOKEN Favicon (ICO)
- CINATOKEN 应用图标 (PNG)

### 3.2 代码修改阶段

#### 步骤 3: 修改 Go 模块配置
```bash
# 编辑 go.mod
sed -i 's|github.com/QuantumNous/new-api|github.com/cinagroup/cinatoken|g' go.mod

# 编辑所有 Go 文件中的 import 路径
find . -name "*.go" -type f -exec sed -i 's|github.com/QuantumNous/new-api|github.com/cinagroup/cinatoken|g' {} \;
```

#### 步骤 4: 修改系统名称
```bash
# 编辑 common/constants.go
sed -i 's/SystemName = "New API"/SystemName = "CINATOKEN"/g' common/constants.go
```

#### 步骤 5: 修改前端配置
```bash
# 编辑 web/index.html
sed -i 's/New API/CINATOKEN/g' web/index.html
sed -i 's/content="new-api"/content="cinatoken"/g' web/index.html

# 编辑前端组件中的品牌引用
find web/src -type f \( -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" \) \
  -exec sed -i 's/New API/CINATOKEN/g' {} \;
find web/src -type f \( -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" \) \
  -exec sed -i 's/new-api/cinatoken/g' {} \;
```

#### 步骤 6: 修改 Docker 配置
```bash
# 编辑 Dockerfile
sed -i 's/new-api/cinatoken/g' Dockerfile

# 编辑 docker-compose.yml
sed -i 's/new-api/cinatoken/g' docker-compose.yml
sed -i 's/CalciumIon/cinagroup/g' docker-compose.yml
```

### 3.3 资源替换阶段

#### 步骤 7: 替换 Logo 和图标
```bash
# 备份原文件
cp web/public/logo.png web/public/logo.png.bak
cp web/public/favicon.ico web/public/favicon.ico.bak
cp electron/icon.png electron/icon.png.bak

# 复制新品牌资源
cp /path/to/cinatoken-logo.png web/public/logo.png
cp /path/to/cinatoken-favicon.ico web/public/favicon.ico
cp /path/to/cinatoken-icon.png electron/icon.png
```

### 3.4 文档更新阶段

#### 步骤 8: 更新 README
```bash
# 编辑所有语言的 README
for file in README*.md; do
  sed -i 's/New API/CINATOKEN/g' "$file"
  sed -i 's/new-api/cinatoken/g' "$file"
  sed -i 's/Calcium-Ion/cinagroup/g' "$file"
done
```

#### 步骤 9: 更新文档
```bash
# 更新 docs 目录下的所有文档
find docs -type f -name "*.md" -exec sed -i 's/New API/CINATOKEN/g' {} \;
find docs -type f -name "*.md" -exec sed -i 's/new-api/cinatoken/g' {} \;
```

### 3.5 构建测试阶段

#### 步骤 10: 构建并测试
```bash
# 前端构建
cd web
bun install
bun run build

# 后端构建
cd ..
go build -o cinatoken

# 本地测试
./cinatoken
```

---

## 4. 文件修改清单

### 4.1 Go 后端文件

| 文件路径 | 修改内容 | 优先级 |
|----------|----------|--------|
| `go.mod` | module 路径 | 🔴 高 |
| `go.sum` | module 路径 | 🔴 高 |
| `common/constants.go` | SystemName | 🔴 高 |
| `common/totp.go` | SystemName 引用 | 🟡 中 |
| `common/email.go` | SystemName 引用 | 🟡 中 |
| `common/sys_log.go` | SystemName 引用 | 🟡 中 |
| `controller/misc.go` | system_name | 🟡 中 |
| 所有 `*.go` 文件 | import 路径 | 🔴 高 |

### 4.2 前端文件

| 文件路径 | 修改内容 | 优先级 |
|----------|----------|--------|
| `web/index.html` | title, meta, generator | 🔴 高 |
| `web/src/App.jsx` | 品牌文本 | 🟡 中 |
| `web/src/components/layout/Footer.jsx` | GitHub 链接、品牌名 | 🔴 高 |
| `web/src/components/settings/OtherSetting.jsx` | GitHub API URL | 🔴 高 |
| `web/src/i18n/locales/*.json` | 翻译文本 | 🟡 中 |
| 所有组件文件 | 品牌引用 | 🟡 中 |

### 4.3 配置文件

| 文件路径 | 修改内容 | 优先级 |
|----------|----------|--------|
| `Dockerfile` | 镜像名、输出文件名 | 🔴 高 |
| `docker-compose.yml` | 服务名、镜像名 | 🔴 高 |
| `.env.example` | 示例配置 | 🟢 低 |
| `VERSION` | 版本号 | 🟢 低 |

### 4.4 文档文件

| 文件路径 | 修改内容 | 优先级 |
|----------|----------|--------|
| `README.md` | 项目名、链接 | 🔴 高 |
| `README.zh_CN.md` | 项目名、链接 | 🔴 高 |
| `README.zh_TW.md` | 项目名、链接 | 🔴 高 |
| `README.fr.md` | 项目名、链接 | 🟡 中 |
| `README.ja.md` | 项目名、链接 | 🟡 中 |
| `docs/*.md` | 文档内容 | 🟡 中 |
| `.github/*.md` | GitHub 文档 | 🟢 低 |

### 4.5 资源文件

| 文件路径 | 替换内容 | 优先级 |
|----------|----------|--------|
| `web/public/logo.png` | CINATOKEN Logo | 🔴 高 |
| `web/public/favicon.ico` | CINATOKEN Favicon | 🔴 高 |
| `electron/icon.png` | 应用图标 | 🟡 中 |
| `electron/tray-icon*.png` | 托盘图标 | 🟢 低 |

---

## 5. 测试验证

### 5.1 构建测试

```bash
# 前端构建测试
cd web
bun run build
# 检查 dist/ 目录生成成功

# 后端构建测试
cd ..
go build -o cinatoken
# 检查二进制文件生成成功
```

### 5.2 功能测试

#### 登录页面
- [ ] Logo 显示正确
- [ ] 页面标题显示 CINATOKEN
- [ ] Favicon 显示正确

#### 控制台页面
- [ ] 系统名称显示 CINATOKEN
- [ ] 页脚链接正确
- [ ] GitHub 链接指向 cinagroup

#### API 测试
```bash
# 检查 API 响应
curl http://localhost:3000/api/status
# 检查 system_name 字段
```

### 5.3 Docker 测试

```bash
# 构建 Docker 镜像
docker build -t cinagroup/cinatoken:test .

# 运行容器
docker run -d -p 3000:3000 cinagroup/cinatoken:test

# 测试访问
curl http://localhost:3000/api/status
```

---

## 6. 部署检查

### 6.1 部署前检查清单

- [ ] 所有代码文件已更新
- [ ] 所有文档已更新
- [ ] Logo 和图标已替换
- [ ] 构建测试通过
- [ ] 功能测试通过
- [ ] Docker 构建测试通过

### 6.2 GitHub 仓库配置

- [ ] 仓库描述更新
- [ ] 网站链接更新
- [ ] Topics 标签更新
- [ ] Release 模板更新

### 6.3 Docker Hub 配置

- [ ] 仓库描述更新
- [ ] 构建规则配置
- [ ] 标签策略配置
- [ ] README 更新

### 6.4 发布后验证

- [ ] GitHub Pages 正常
- [ ] Docker 镜像可拉取
- [ ] 文档网站正常
- [ ] 用户反馈收集

---

## 附录

### A. 快速替换脚本

```bash
#!/bin/bash
# brand-migration.sh - 品牌迁移自动化脚本

set -e

echo "🚀 开始 CINATOKEN 品牌迁移..."

# 1. 替换 Go module 路径
echo "📝 更新 Go module 路径..."
find . -name "*.go" -type f -exec sed -i 's|github.com/QuantumNous/new-api|github.com/cinagroup/cinatoken|g' {} \;

# 2. 替换系统名称
echo "🏷️  更新系统名称..."
sed -i 's/SystemName = "New API"/SystemName = "CINATOKEN"/g' common/constants.go

# 3. 替换前端文本
echo "🎨 更新前端品牌..."
find web/src -type f \( -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" \) \
  -exec sed -i 's/New API/CINATOKEN/g' {} \;

# 4. 替换 Docker 配置
echo "🐳 更新 Docker 配置..."
sed -i 's/new-api/cinatoken/g' Dockerfile docker-compose.yml
sed -i 's/CalciumIon/cinagroup/g' docker-compose.yml

# 5. 替换文档
echo "📚 更新文档..."
find . -name "*.md" -type f -exec sed -i 's/New API/CINATOKEN/g' {} \;
find . -name "*.md" -type f -exec sed -i 's/new-api/cinatoken/g' {} \;

echo "✅ 品牌迁移完成！请手动替换 Logo 和图标文件。"
```

### B. 回滚脚本

```bash
#!/bin/bash
# rollback-brand.sh - 回滚品牌迁移

set -e

echo "⚠️  开始回滚到 New API 品牌..."

# 1. 恢复 Go module 路径
find . -name "*.go" -type f -exec sed -i 's|github.com/cinagroup/cinatoken|github.com/QuantumNous/new-api|g' {} \;

# 2. 恢复系统名称
sed -i 's/SystemName = "CINATOKEN"/SystemName = "New API"/g' common/constants.go

# 3. 恢复前端文本
find web/src -type f \( -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" \) \
  -exec sed -i 's/CINATOKEN/New API/g' {} \;

# 4. 恢复 Docker 配置
sed -i 's/cinatoken/new-api/g' Dockerfile docker-compose.yml
sed -i 's/cinagroup/CalciumIon/g' docker-compose.yml

echo "✅ 回滚完成！"
```

### C. 品牌资源规范

#### Logo 规格
- **格式**: PNG, SVG
- **尺寸**: 512x512px (最小), 1024x1024px (推荐)
- **背景**: 透明或白色
- **颜色**: 符合 CINATOKEN 品牌色

#### Favicon 规格
- **格式**: ICO
- **尺寸**: 16x16, 32x32, 48x48 (多尺寸包含)
- **兼容性**: 支持所有主流浏览器

#### 应用图标规格
- **格式**: PNG
- **尺寸**: 256x256px, 512x512px
- **平台**: Windows, macOS, Linux

---

**文档版本**: v1.0  
**最后更新**: 2026-04-04  
**维护者**: CINATOKEN 团队
