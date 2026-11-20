import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { test } from "node:test";
import { PROTOCOL } from "@pa/contracts";
import { bootGateway, id, openAndSubmit, summary } from "../helpers.js";

test("pairing code is one-use and raw tokens stay out of logs and sqlite", async () => {
  const ctx = await bootGateway();
  const logs: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    logs.push(String(chunk));
    return original(chunk as never, ...(rest as never[]));
  }) as typeof process.stdout.write;
  try {
    const minted = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/mint`, {
      method: "POST",
    });
    const { code } = (await minted.json()) as { code: string };
    const first = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        deviceLabel: "泄漏探针",
        kind: "test",
      }),
    });
    const redeemed = (await first.json()) as { token: string };
    const second = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        deviceLabel: "第二次",
        kind: "test",
      }),
    });
    assert.equal(second.status, 409);
    const joined = logs.join("\n");
    assert.equal(joined.includes(code), false);
    assert.equal(joined.includes(redeemed.token), false);
    const db = fs.readFileSync(`${ctx.dir}/app.sqlite`);
    assert.equal(db.includes(Buffer.from(redeemed.token)), false);
    assert.equal(db.includes(Buffer.from(code)), false);
    const checkpoint = `${ctx.dir}/checkpoints.sqlite`;
    if (fs.existsSync(checkpoint)) {
      assert.equal(
        fs.readFileSync(checkpoint).includes(Buffer.from(redeemed.token)),
        false,
      );
    }
  } finally {
    process.stdout.write = original;
    await ctx.cleanup();
  }
});

test("expired device token is rejected and spoofed identity cannot cross sessions", async () => {
  const ctx = await bootGateway({ deviceTokenTtlMs: 400 });
  try {
    const minted = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/mint`, {
      method: "POST",
    });
    const { code } = (await minted.json()) as { code: string };
    const redeemed = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceLabel: "短命", kind: "test" }),
    });
    const token = ((await redeemed.json()) as { token: string }).token;
    const alpha = await ctx.pair("所有者");
    const { sessionId } = await openAndSubmit(
      alpha,
      "只有所有者能看见 SENTINEL_OWNER_TEXT",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const expired = await fetch(`${ctx.gateway.baseUrl}/v1/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(expired.status, 401);
    const intruderResponse = await fetch(
      `${ctx.gateway.baseUrl}/v1/test/isolated-principal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "别人" }),
      },
    );
    const intruder = (await intruderResponse.json()) as { token: string };
    const foreignHeaders = { authorization: `Bearer ${intruder.token}` };
    const snapshot = await fetch(`${ctx.gateway.baseUrl}/v1/snapshot`, {
      headers: foreignHeaders,
    });
    const body = await snapshot.text();
    assert.equal(body.includes("SENTINEL_OWNER_TEXT"), false);
    const resumed = await fetch(`${ctx.gateway.baseUrl}/v1/commands`, {
      method: "POST",
      headers: { ...foreignHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        protocol: PROTOCOL,
        commandId: id(),
        idempotencyKey: id(),
        type: "session.resume",
        payload: { sessionId, userId: "owner-spoofed" },
      }),
    });
    assert.equal(resumed.status, 400);
    const events = await fetch(
      `${ctx.gateway.baseUrl}/v1/events?cursor=${encodeURIComponent(
        await signOwn(ctx.gateway.baseUrl, intruder.token),
      )}`,
      { headers: foreignHeaders },
    );
    const eventBody = await events.text();
    assert.equal(eventBody.includes("SENTINEL_OWNER_TEXT"), false);
    const missing = await fetch(`${ctx.gateway.baseUrl}/v1/stream`, {
      headers: foreignHeaders,
    });
    assert.equal(missing.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test("reconnect keeps durable events and drops ephemeral previews", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const { runId } = await openAndSubmit(alpha, "预览不能当持久事件");
    await alpha.waitFor(
      (projection) =>
        Boolean(projection.ephemeralByRun[runId]) &&
        projection.approvals.some((item) => item.runId === runId),
    );
    const before = alpha.getSnapshot().eventIds.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await alpha.disconnect();
    await alpha.connect();
    const after = alpha.getSnapshot();
    assert.equal(after.ephemeralByRun[runId], undefined);
    assert.ok(after.eventIds.length >= before);
    assert.equal(
      after.approvals.some(
        (item) => item.runId === runId && item.status === "pending",
      ),
      true,
    );
    assert.equal(new Set(after.eventIds).size, after.eventIds.length);
  } finally {
    await ctx.cleanup();
  }
});

test("demo mode does not open a provider socket even when a key and base URL are set", async () => {
  const ctx = await bootGateway({
    openaiApiKey: "sk-test-LEAK-PROBE-9f3a",
    openaiBaseUrl: "http://203.0.113.10:9/v1",
  });
  const foreign: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalHttp = http.request;
  const originalHttps = https.request;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const target = String(input);
    if (!target.startsWith(ctx.gateway.baseUrl))
      foreign.push(`fetch ${target}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  http.request = ((...args: Parameters<typeof http.request>) => {
    foreign.push(`http ${String(args[0])}`);
    return originalHttp(...args);
  }) as typeof http.request;
  https.request = ((...args: Parameters<typeof https.request>) => {
    foreign.push(`https ${String(args[0])}`);
    return originalHttps(...args);
  }) as typeof https.request;
  try {
    const alpha = await ctx.pair("alpha");
    await openAndSubmit(alpha, "演示禁止出网", "demo");
    await alpha.waitFor((projection) => projection.approvals.length > 0);
    assert.deepEqual(foreign, []);
    const noKey = await bootGateway({
      openaiApiKey: "",
      openaiBaseUrl: "http://203.0.113.10:9/v1",
    });
    try {
      const user = await noKey.pair("nokey");
      const session = await user.openSession("无密钥");
      await assert.rejects(
        user.submit({
          sessionId: String(
            (session.result as { sessionId: string }).sessionId,
          ),
          text: "这不是演示",
          providerMode: "live",
        }),
        (error: { code?: string }) => error.code === "PROVIDER_NOT_CONFIGURED",
      );
      assert.equal((await summary(noKey.gateway.baseUrl)).runs.length, 0);
      assert.equal(
        fs
          .readFileSync(`${noKey.dir}/app.sqlite`)
          .includes(Buffer.from("SENTINEL_WEEKLY_7F3A")),
        false,
      );
    } finally {
      await noKey.cleanup();
    }
  } finally {
    globalThis.fetch = originalFetch;
    http.request = originalHttp;
    https.request = originalHttps;
    await ctx.cleanup();
  }
});

async function signOwn(baseUrl: string, token: string): Promise<string> {
  const snapshot = await fetch(`${baseUrl}/v1/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await snapshot.json()) as { userId: string };
  const signed = await fetch(`${baseUrl}/v1/test/sign-cursor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seq: 0,
      principalId: body.userId,
      exp: Date.now() + 60_000,
    }),
  });
  return ((await signed.json()) as { cursor: string }).cursor;
}
