import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECTION_VERSION } from "@pa/contracts";
import {
  MemoryCredentialStore,
  MemoryProjectionStore,
  PersonalAgentClient,
  validateGatewayUrl,
} from "@pa/sdk";
import { bootGateway, openAndSubmit } from "../helpers.js";

test("gateway url rejects credentials in the query and accepts http", () => {
  assert.equal(
    validateGatewayUrl("http://127.0.0.1:47471/"),
    "http://127.0.0.1:47471",
  );
  assert.throws(() => validateGatewayUrl("notaurl"), /不是有效的 URL/);
  assert.throws(() => validateGatewayUrl("ftp://127.0.0.1"), /http 或 https/);
  assert.throws(
    () => validateGatewayUrl("http://127.0.0.1/?token=secret"),
    /不能携带参数/,
  );
});

test("markdown hides raw emphasis markers", async () => {
  const { parseMarkdown, markdownToPlain } = await import("@pa/sdk");
  const blocks = parseMarkdown("**第 3 环**\n\n- `frontend`");
  const flat = JSON.stringify(blocks);
  assert.equal(flat.includes("**"), false);
  assert.equal(markdownToPlain("**已写入** 笔记"), "已写入 笔记");
  assert.equal(
    markdownToPlain("<script>alert(1)</script>"),
    "<script>alert(1)</script>",
  );
});

test("invalid token is rejected and does not keep credentials", async () => {
  const ctx = await bootGateway();
  try {
    const credentials = new MemoryCredentialStore();
    const persistence = new MemoryProjectionStore();
    const client = new PersonalAgentClient({
      baseUrl: ctx.gateway.baseUrl,
      credentials,
      persistence,
    });
    await assert.rejects(
      client.adoptToken("invalid-token-value"),
      /设备令牌无效、过期或已吊销/,
    );
    assert.equal(await credentials.load(), null);
    assert.equal(client.getSnapshot().sessions.length, 0);
    assert.equal(
      JSON.stringify(client.getSnapshot()).includes("invalid-token-value"),
      false,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("expired token is rejected with the same invalid-or-expired error", async () => {
  const ctx = await bootGateway({ deviceTokenTtlMs: 400 });
  try {
    const minted = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/mint`, {
      method: "POST",
    });
    const code = ((await minted.json()) as { code: string }).code;
    const redeemed = await fetch(`${ctx.gateway.baseUrl}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceLabel: "短命", kind: "test" }),
    });
    const token = ((await redeemed.json()) as { token: string }).token;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const client = new PersonalAgentClient({
      baseUrl: ctx.gateway.baseUrl,
      credentials: new MemoryCredentialStore(),
      persistence: new MemoryProjectionStore(),
    });
    await assert.rejects(client.adoptToken(token), /过期|无效/);
    assert.equal(JSON.stringify(client.getSnapshot()).includes(token), false);
  } finally {
    await ctx.cleanup();
  }
});

test("replacing the gateway drops the old snapshot and cursor", async () => {
  const first = await bootGateway();
  const second = await bootGateway();
  try {
    const credentials = new MemoryCredentialStore();
    const persistence = new MemoryProjectionStore();
    const minted = await fetch(`${first.gateway.baseUrl}/v1/pairing/mint`, {
      method: "POST",
    });
    const code = ((await minted.json()) as { code: string }).code;
    const client = new PersonalAgentClient({
      baseUrl: first.gateway.baseUrl,
      credentials,
      persistence,
    });
    await client.redeem({ code, deviceLabel: "甲", kind: "test" });
    await client.connect();
    const { sessionId } = await openAndSubmit(client, "SENTINEL_GATEWAY_A");
    await client.waitFor((projection) =>
      projection.sessions.some((session) => session.id === sessionId),
    );
    assert.ok(client.getSnapshot().cursor);
    await client.forget();
    const stored = await persistence.load();
    assert.equal(stored?.cursor, null);
    assert.equal(stored?.projection.sessions.length, 0);
    assert.equal(await credentials.load(), null);
    assert.equal(client.getSnapshot().sessions.length, 0);
    assert.equal(
      JSON.stringify(client.getSnapshot()).includes("SENTINEL_GATEWAY_A"),
      false,
    );

    const nextCredentials = new MemoryCredentialStore();
    const nextPersistence = new MemoryProjectionStore();
    const mintedB = await fetch(`${second.gateway.baseUrl}/v1/pairing/mint`, {
      method: "POST",
    });
    const codeB = ((await mintedB.json()) as { code: string }).code;
    const next = new PersonalAgentClient({
      baseUrl: second.gateway.baseUrl,
      credentials: nextCredentials,
      persistence: nextPersistence,
    });
    await next.redeem({ code: codeB, deviceLabel: "乙", kind: "test" });
    await next.connect();
    await next.resync();
    assert.equal(
      JSON.stringify(next.getSnapshot()).includes("SENTINEL_GATEWAY_A"),
      false,
    );
    await next.forget();
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("a saved expired cursor recovers a live subscription during connect", async () => {
  const ctx = await bootGateway();
  const credentials = new MemoryCredentialStore();
  const persistence = new MemoryProjectionStore();
  const client = new PersonalAgentClient({
    baseUrl: ctx.gateway.baseUrl,
    credentials,
    persistence,
  });
  const resumed = new PersonalAgentClient({
    baseUrl: ctx.gateway.baseUrl,
    credentials,
    persistence,
  });
  try {
    const { code } = ctx.gateway.store.mintPairing(60_000);
    await client.redeem({ code, deviceLabel: "回放", kind: "test" });
    await client.connect();
    const { sessionId, runId } = await openAndSubmit(client, "过期游标恢复");
    const saved = await client.waitFor((projection) =>
      projection.approvals.some((approval) => approval.runId === runId),
    );
    await client.disconnect();
    assert.ok(saved.self);
    const cursor = ctx.gateway.store.issueCursor(
      saved.self.userId,
      ctx.gateway.store.maxSeq(),
      Date.now() - 1000,
    );
    await persistence.save({
      version: PROJECTION_VERSION,
      cursor,
      projection: { ...saved, cursor, sessions: [] },
    });
    await resumed.connect();
    assert.equal(resumed.getSnapshot().connection, "live");
    assert.ok(
      resumed.getSnapshot().sessions.some((item) => item.id === sessionId),
    );
    await resumed.cancel(runId);
    await resumed.waitFor(
      (projection) => projection.runs[runId]?.status === "cancelled",
    );
  } finally {
    await resumed.disconnect();
    await client.disconnect();
    await ctx.cleanup();
  }
});
