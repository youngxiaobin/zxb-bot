# 数据库

权威 SQL 在 `packages/persistence/src/migrations.ts`。启动时核对校验和，不匹配就拒绝启动。每次连接都打开 `foreign_keys`、WAL、`synchronous=FULL` 和 `busy_timeout=5000`，并执行 `foreign_key_check`。

表：`schema_migrations`、`meta`、`users`、`devices`、`channels`、`pairing_grants`、`sessions`、`session_grants`、`messages`、`runs`、`tool_calls`、`approvals`、`expert_tasks`、`events`、`command_receipts`、`effect_log`、`executor_lock`。

约束：

- 会话、运行、工具调用用复合外键绑住同一个 `user_id`。
- 触发器要求运行引用的消息属于同一会话，工具引用的运行也属于同一会话。
- `runs_one_active_root` 只限制未结束的根运行。
- `events.seq` 是全局 `INTEGER PRIMARY KEY AUTOINCREMENT`。
- `effect_log` 只在演示写入真正创建文件后插入。重复写入会因为 `wx` 失败，不会覆盖。

工作流版本是 `pa-workflow.v1`，检查点兼容标记是 `langgraph-sqlite-saver.v1`。标记不匹配时没有自动迁移。

已核对的库组合：Node.js 22.23.4、pnpm 11.19.0、`@langchain/langgraph` 1.7.5、`@langchain/langgraph-checkpoint-sqlite` 1.1.1。检查点包被 pnpm override 到 `better-sqlite3` 13.2.0，因为 13 自带当前平台的预编译二进制；12 的安装脚本在这个环境里被跳过。
