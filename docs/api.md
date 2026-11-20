# API

所有命令都是 `POST /v1/commands`，带 `Authorization: Bearer <设备令牌>`。令牌不能放在查询字符串里。

```json
{
  "protocol": "pa.command.v1",
  "commandId": "uuid",
  "idempotencyKey": "uuid",
  "type": "message.submit",
  "payload": { "sessionId": "...", "text": "...", "providerMode": "demo" }
}
```

命令类型：

| type              | payload                                                 | 作用                                               |
| ----------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `session.open`    | `{ title? }`                                            | 在当前设备的频道下打开会话                         |
| `session.resume`  | `{ sessionId }`                                         | 同一所有者显式授权当前设备阅读会话                 |
| `message.submit`  | `{ sessionId, text, providerMode }`                     | 创建一条根运行                                     |
| `approval.decide` | `{ approvalId, decision, expectedVersion, paramsHash }` | 批准或拒绝。相同决定重试是幂等的，相反决定返回 409 |
| `run.cancel`      | `{ runId }`                                             | 接受取消。不保证正在执行的工具立刻停止             |
| `device.revoke`   | `{ deviceId }`                                          | 吊销设备令牌                                       |

读取：

- `GET /v1/snapshot`：当前设备可见的快照和水印游标。
- `GET /v1/events?cursor=`：游标之后的可见事件。畸形 400，超前 409，过期 410，身份不符 403。
- `GET /v1/health`：不含密钥。`providers.liveConfigured` 只是布尔值。
- `POST /v1/pairing/mint`：仅回环地址，返回一次性配对码。
- `POST /v1/pairing/redeem`：用配对码换设备令牌，令牌只返回一次。
- `GET /v1/ws`：先发 `{ "type": "hello", "protocol": "pa.ws.v1", "token" }`，再发 `{ "type": "subscribe", "cursor": null }`。

WebSocket 还发送 `ephemeral.preview`。它没有序号，断线重连不能靠它补历史。

测试钩子只在 `PA_TEST_HOOKS=1` 时存在，否则 404：

- `POST /v1/test/fault`，`name` 为 `clear`、`effect_succeed_then_crash_before_result`、`exit_after_approval_before_resume`、`skip_checkpoint_advance`、`delay_before_tool_effect`、`hold_before_effect`、`hold_after_effect`、`drop_response_once`、`delay_replay`。
- `POST /v1/test/release`
- `POST /v1/test/reload`
- `POST /v1/test/isolated-principal`
- `POST /v1/test/sign-cursor`
- `GET /v1/test/summary`，其中 `effects` 是实际写入次数。

演示文本前缀：`/budget-burn`、`/partial-fail`、`/slow-read`。其他文本走两名专员加一次审批写入。
