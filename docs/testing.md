# 测试与验收

默认命令：

```bash
pnpm test
pnpm typecheck
pnpm typecheck:mobile
pnpm lint
pnpm --filter @pa/desktop build
```

`pnpm test` 只跑 `tests/p0`。它使用演示提供方，即使环境变量里有 `OPENAI_API_KEY` 也不会访问供应商。`pnpm test:live` 当前没有默认用例，实况供应商测试不算已执行。

已覆盖的节点测试包括：双设备审批、拒绝零写入、幂等与载荷冲突、同时批准、批准对拒绝、过期版本、参数绑定、游标畸形/超前/过期/越权、断线不取消、隔离主体和吊销、30 次预算与第 31 次不开始、专员并发预算、专员部分失败、工具超时、审批过期、取消后的迟到结果、检查点滞后不重复写入，以及三类真实 `SIGKILL` 重启。

`GET /v1/test/summary` 的 `effects` 用来计算实际写入，而不是只看模型回复。

这些测试证明的是 SDK 和 Gateway。它们没有启动 Electron，也没有启动 Expo 模拟器或真机。

独立复查时可以：

1. 用临时目录设置 `PA_DATA_DIR` 和 `PA_TEST_HOOKS=1`。
2. 看 `packages/persistence/src/migrations.ts` 的校验和。
3. 按 `docs/api.md` 的钩子名注入故障。
4. 杀掉进程后用同一个数据目录重启，再读 `/v1/test/summary`。
