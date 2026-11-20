import assert from "node:assert/strict";
import { test } from "node:test";
import { bootGateway, openAndSubmit, summary } from "../helpers.js";

test("WS replay and live overlap deliver each event id once", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const { runId } = await openAndSubmit(alpha, "重叠回放");
    const approval = (
      await alpha.waitFor((projection) =>
        projection.approvals.some((item) => item.runId === runId),
      )
    ).approvals.find((item) => item.runId === runId);
    assert.ok(approval);
    const minted = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/mint`, {
      method: "POST",
    });
    const code = ((await minted.json()) as { code: string }).code;
    const redeemed = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceLabel: "重叠", kind: "test" }),
    });
    const token = ((await redeemed.json()) as { token: string }).token;
    const snapshot = await fetch(`${ctx.gateway.baseUrl}/v1/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const snap = (await snapshot.json()) as { userId: string };
    const signed = await fetch(`${ctx.gateway.baseUrl}/v1/test/sign-cursor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seq: 0,
        principalId: snap.userId,
        exp: Date.now() + 60_000,
      }),
    });
    const cursor = ((await signed.json()) as { cursor: string }).cursor;
    await fetch(`${ctx.gateway.baseUrl}/v1/test/fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "delay_replay", replayDelayMs: 400 }),
    });
    const before = await summary(ctx.gateway.baseUrl);
    const framesPromise = collectFrames(ctx.gateway.baseUrl, token, cursor);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await alpha.cancel(runId);
    const frames = await framesPromise;
    const eventFrames = frames.filter((frame) => frame.type === "event");
    const subscribed = frames.find((frame) => frame.type === "subscribed") as
      | { replayed?: number }
      | undefined;
    const ids = eventFrames.map((frame) => String(frame.event.eventId));
    const uniqueEventIds = new Set(ids).size;
    assert.equal(uniqueEventIds, ids.length);
    assert.ok(ids.length > 0);
    const outcome = eventFrames.filter(
      (frame) =>
        frame.event.type === "run.outcome" && frame.event.runId === runId,
    );
    assert.equal(outcome.length, 1);
    assert.equal(
      eventFrames.some((frame) => frame.event.type === "ephemeral.preview"),
      false,
    );
    const seqs = eventFrames.map((frame) => Number(frame.event.seq));
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    const overlapFrames = eventFrames.filter(
      (frame) => Number(frame.event.seq) > before.maxSeq,
    );
    assert.ok(overlapFrames.length >= 1);
    const overlapIds = overlapFrames.map((frame) =>
      String(frame.event.eventId),
    );
    assert.equal(new Set(overlapIds).size, overlapIds.length);
    console.log(
      JSON.stringify({
        gate: "ws-replay-live-overlap",
        seqBeforeOverlap: before.maxSeq,
        replayed: subscribed?.replayed ?? null,
        eventFrames: ids.length,
        uniqueEventIds,
        duplicateIds: ids.length - uniqueEventIds,
        overlapFrames: overlapFrames.length,
        overlapUniqueIds: new Set(overlapIds).size,
        outcomeFrames: outcome.length,
        ephemeralFrames: 0,
        seqMin: seqs[0] ?? null,
        seqMax: seqs.at(-1) ?? null,
      }),
    );
  } finally {
    await ctx.cleanup();
  }
});

async function collectFrames(baseUrl: string, token: string, cursor: string) {
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/v1/ws`;
  const ws = new WebSocket(wsUrl);
  const frames: Array<{
    type: string;
    event?: {
      eventId: string;
      type: string;
      runId: string | null;
      seq: number;
    };
  }> = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS 超时")), 8000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "hello", protocol: "pa.ws.v1", token }));
    });
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as {
        type: string;
        nonce?: string;
        event?: {
          eventId: string;
          type: string;
          runId: string | null;
          seq: number;
        };
      };
      if (frame.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", nonce: frame.nonce }));
        return;
      }
      if (frame.type === "hello.ok") {
        ws.send(JSON.stringify({ type: "subscribe", cursor }));
        return;
      }
      frames.push(frame);
      if (frame.type === "subscribed") {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
      if (frame.type === "error" || frame.type === "hello.error") {
        clearTimeout(timer);
        reject(new Error(JSON.stringify(frame)));
      }
    });
  });
  return frames;
}
