import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableEvent } from "@pa/contracts";
import { applyEvent } from "@pa/sdk";
import { emptyProjection } from "@pa/sdk";

test("reducer does not invent events for sequence holes", () => {
  let projection = emptyProjection();
  for (const seq of [1, 4, 9]) {
    projection = applyEvent(projection, event(seq));
  }
  assert.equal(projection.messages["s1-session"]?.length, 3);
  assert.equal(projection.eventIds.length, 3);
  projection = applyEvent(projection, event(4));
  assert.equal(projection.messages["s1-session"]?.length, 3);
});

function event(seq: number): DurableEvent {
  return {
    protocol: "pa.event.v1",
    eventId: `evt-${seq}`,
    seq,
    cursor: `cursor-${seq}`,
    userId: "user-12345678",
    channelId: null,
    sessionId: "s1-session",
    runId: "run-123456",
    taskId: null,
    type: "message.user.created",
    createdAt: new Date(seq).toISOString(),
    payload: {
      messageId: `msg-${seq}`,
      sessionId: "s1-session",
      text: `消息 ${seq}`,
    },
  };
}
