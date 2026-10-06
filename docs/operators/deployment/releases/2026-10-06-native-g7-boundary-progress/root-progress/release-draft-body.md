Changesets 固定版本组此前漏掉独立 Web，且根 Prettier 2 无法加载 Web 的 Prettier 3 插件，导致 Web changelog 缺失。修复后真实 Release 已生成本候选：根、Core、Tool Engines、Proxy、Admin、Web 六包同步为 2.9.0，并生成六份 changelog；Chain Worker 保持 2.8.0。

候选由 Release run 37403320523 从 main `00858e90592d55fa1d58b15bf1a4ebec1883b848` 生成，已核对候选提交 `4d167799e2d7cf290053003d878e144cb50d3360` 的 13 个差异文件。Actions 在创建 PR 时被仓库现有策略拒绝，因此以草稿保存可审阅候选；仓库权限和 secrets 没有变更。

验证与待办：

- 原 main `4e2ed519` 的 Web frontend、Docker Compose Smoke 和版本校验通过，8 个修复的 PG73 native 测试在原 Linux CI 通过。
- 新 5 个 PG73 夹具已保留 276 原断言和 7 原 grant 调用；本地语法、既有桥接控制及源码核对通过，当前提交的真实 native CI 待终态。
- 首轮隔离 G7 在 seed 夹具失败，清理验证通过；HTTPS、认证写、灰度与回滚等完整验收待完成。
- v364 严格流取消测试仍失败，诊断证据已保留。

本 PR 保持草稿，尚未合并、打 tag 或发布版本。现有独立 Web 生产切流使用 `c13a64b9`，本版本候选未部署。

