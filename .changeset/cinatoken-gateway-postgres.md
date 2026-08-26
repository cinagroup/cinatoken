---
"cinatoken": minor
---

启动 `cinatoken_gateway` PostgreSQL 迁移：安全改名历史 Schema，补齐门户整数账本与链上事务 Outbox 迁移，统一 PostgreSQL 运行时 search path，并将 D1→PostgreSQL ETL/对账升级为覆盖当前数据模型、源冻结、目标离线、会话失效和失败关闭的生产迁移流程。Proxy、Admin/Portal 与 Chain Worker 现可通过同一个 Cloudflare Hyperdrive 绑定显式切换到 PostgreSQL；默认仍保持 D1，缺失或不一致的切换配置会失败关闭。
