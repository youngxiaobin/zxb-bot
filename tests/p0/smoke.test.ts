import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bootGateway, id, openAndSubmit, summary } from "../helpers.js";

const secret = "sk-test-LEAK-PROBE-9f3a";
let ctx: Awaited<ReturnType<typeof bootGateway>>;

before(async () => {
  ctx = await bootGateway();
});

after(async () => {
  await ctx.cleanup();
});

test("two devices share one run: stream, approve on the second, one write", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const target = String(args[0]);
    if (!target.startsWith(ctx.gateway.baseUrl)) networkCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  try {
    const alpha = await ctx.pair("desktop");
    const beta = await ctx.pair("phone", "mobile");
    const { sessionId, runId } = await openAndSubmit(
      alpha,
      "请整理资料并写入摘要",
    );
    assert.equal(networkCalls, 0);
    const pending = await alpha.waitFor((projection) =>
      projection.approvals.some((item) => item.status === "pending"),
    );
    const approval = pending.approvals.find((item) => item.runId === runId);
    assert.ok(approval);
    assert.equal(
      beta.getSnapshot().sessions.some((session) => session.id === sessionId),
      false,
    );
    assert.equal(
      beta.getSnapshot().approvals.some((item) => item.id === approval.id),
      true,
    );
    const beforeSeq = (await summary(ctx.gateway.baseUrl)).maxSeq;
    const ephemeralSeen = beta.getSnapshot().ephemeralByRun[runId];
    assert.equal(ephemeralSeen, undefined);
    await beta.decide({
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      paramsHash: approval.paramsHash,
    });
    await alpha.waitFor((projection) =>
      projection.outcomes.some(
        (item) => item.runId === runId && item.effect === "applied",
      ),
    );
    await beta.waitFor((projection) =>
      projection.outcomes.some(
        (item) => item.runId === runId && item.effect === "applied",
      ),
    );
    const assistant = alpha
      .getSnapshot()
      .messages[sessionId]?.find((message) => message.role === "assistant");
    assert.ok(assistant?.content.includes("SENTINEL_WEEKLY_7F3A"));
    assert.ok(
      assistant?.content.includes("fixtures/weekly-notes.md") ||
        assistant?.content.includes("weekly-notes.md"),
    );
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 1);
    assert.ok((await summary(ctx.gateway.baseUrl)).maxSeq >= beforeSeq);
    const again = await beta.decide({
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      paramsHash: approval.paramsHash,
      idempotencyKey: id(),
    });
    assert.equal((again.result as { outcome: string }).outcome, "idempotent");
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 1);
    assert.equal(networkCalls, 0);
    assert.equal(JSON.stringify(alpha.getSnapshot()).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
