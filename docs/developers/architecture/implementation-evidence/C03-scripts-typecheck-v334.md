# C03 v334：数据库切换脚本类型检查恢复

2026-09-24；本地脚本门禁修复。上一轮 `npx tsc -p scripts/tsconfig.json --noEmit` 在目录探针和三个 smoke 文件报错；本轮补充 PostgreSQL client 判别、Workspace 参数与预算快照测试输入，并移除脚本编译配置不接受的 `.ts` 导入后，该命令 **退出码 0**。

`node --import tsx --test scripts/smoke/test-critical-write-paths.ts` **4/4 PASS**。这些测试使用合成 D1/PG 对象；本轮没有运行真实 PostgreSQL/MySQL smoke，也没有重跑 v333 七份原生回放报告。C03 的生产锁窗、完整历史 handler、保留期/contract、真实 Workers／Hyperdrive／Queue 与物理连接关闭证据仍开放，C03.7/C03.G 不勾选。

该修复不增加正式迁移（PostgreSQL 仍 73 条），不执行远端 SQL、部署或云调用。机器摘要见 [JSON](./C03-scripts-typecheck-v334-results.json)。
