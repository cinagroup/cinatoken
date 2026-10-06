# Changesets

本仓库用 [**Changesets**](https://github.com/changesets/changesets) 做 **fixed 单版本线**：根包 `cinatoken` 与 `@octafuse/core` / `@octafuse/proxy` / `@octafuse/admin` **共用同一 `version`**，与 Git 标签 **`vX.Y.Z`** 及 GHCR 镜像 tag 对齐。

根目录 **`package.json`** 的 **`workspaces`** 含 **`"."`**，以便 Changesets / manypkg 将根包与其它 workspace **一并**纳入 fixed 组（勿删，否则 `cinatoken` 不会出现在 Changesets 包列表中）。

## 日常开发

日常功能与外部贡献 PR 默认合入长期开发分支 **`develop`**。在包含用户可见变更的 PR 里添加一条 changeset：

```bash
npx changeset
```

按提示选择 **major / minor / patch**，并写摘要。会生成 `.changeset/<随机名>.md`，随 PR 提交即可。

`develop` 上的 changeset 不会触发发版，因为 Release workflow 只监听 `main`。若版本范围尚未确定，维护者可以允许 PR 暂不添加，但开发线合入 `main` 前必须补齐并审核。纯文档、测试、CI 或无用户影响的内部维护通常不需要 changeset。

文案建议：首段一句话摘要 + `### Proxy` / `### Admin` 等分区列表（见 [release-versioning.md](../docs/maintainers/release-versioning.md) §维护者日常操作）。GitHub Release 由 `npm run release:notes` 渲染，勿指望原始 `Patch Changes` 格式直接作为对外说明。

## 发版流程（自动化）

1. 发布前补齐 changesets，并通过 PR 将 **`develop`** 合入 **`main`**；需要冻结验收时，先从 `develop` 创建临时 `release/X.Y.Z`，再由该分支 PR 到 `main`。
2. GitHub Action **[Release](../.github/workflows/release.yml)** 会打开 **「Version Packages」** PR（更新 `package.json` 版本、`CHANGELOG.md`、并删除已消费的 changeset 文件）。
3. **审核并合并**该 Version PR。
4. 再次触发 Release workflow：其 **`publish`** 步骤运行 **`npm run ci:changeset-tag-push`**（内部为 `changeset tag` + 推送 **`vX.Y.Z`** 标签；见根 `package.json`）。
5. 标签推送触发 **[cinatoken Docker Images](../.github/workflows/cinatoken-docker-images.yml)**：构建并推送 **proxy / admin / migrate** 镜像，并创建/更新 **GitHub Release**（正文中附带各镜像 **digest**）。

SoloEnt 临时上线、应急或调试使用 `develop`（或指定提交）的 **`workflow_dispatch`** 手动构建并按 SHA/digest 部署，不合入 `main`，也不创建正式 Release。

若 CI 报 **「GitHub Actions is not permitted to create or approve pull requests」**：在仓库 **Settings → Actions → General** 勾选 **Allow GitHub Actions to create and approve pull requests**，或配置 secret **`CHANGESETS_GITHUB_TOKEN`**（PAT），详见 **[docs/maintainers/release-versioning.md](../docs/maintainers/release-versioning.md)** §「Release workflow 无法创建 PR」。

更多说明见 **[docs/maintainers/release-versioning.md](../docs/maintainers/release-versioning.md)**。
