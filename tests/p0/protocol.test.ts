import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { PROTOCOL } from "@pa/contracts";
import {
  type EffectRow,
  bootGateway,
  id,
  openAndSubmit,
  summary,
} from "../helpers.js";

const secret = "sk-test-LEAK-PROBE-9f3a";

test("idempotency, payload conflict, and session busy", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const opened = await alpha.openSession("幂等");
    const sessionId = String(
      (opened.result as { sessionId: string }).sessionId,
    );
    const key = id();
    const first = await alpha.submit({
      sessionId,
      text: "同一条命令",
      providerMode: "demo",
      idempotencyKey: key,
      commandId: key,
    });
    const runId = String((first.result as { runId: string }).runId);
    const replay = await alpha.submit({
      sessionId,
      text: "同一条命令",
      providerMode: "demo",
      idempotencyKey: key,
      commandId: key,
    });
    assert.equal(replay.replayed, true);
    assert.equal((replay.result as { runId: string }).runId, runId);
    await assert.rejects(
      alpha.submit({
        sessionId,
        text: "不同内容",
        providerMode: "demo",
        idempotencyKey: key,
        commandId: id(),
      }),
      (error: { code?: string }) => error.code === "PAYLOAD_CONFLICT",
    );
    await assert.rejects(
      alpha.submit({
        sessionId,
        text: "另一条",
        providerMode: "demo",
        idempotencyKey: id(),
      }),
      (error: { code?: string }) => error.code === "SESSION_BUSY",
    );
    assert.equal((await summary(ctx.gateway.baseUrl)).runs.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("reject writes nothing; cancel before approval writes nothing", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const beta = await ctx.pair("beta");
    const rejected = await openAndSubmit(alpha, "请整理资料并写入摘要");
    const approval = (
      await alpha.waitFor((projection) =>
        projection.approvals.some((item) => item.runId === rejected.runId),
      )
    ).approvals.find((item) => item.runId === rejected.runId);
    assert.ok(approval);
    await beta.decide({
      approvalId: approval.id,
      decision: "reject",
      expectedVersion: 1,
      paramsHash: approval.paramsHash,
    });
    await alpha.waitFor((projection) =>
      projection.outcomes.some(
        (item) => item.runId === rejected.runId && item.effect === "none",
      ),
    );
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 0);
    assert.match(
      alpha
        .getSnapshot()
        .messages[rejected.sessionId]?.find(
          (message) => message.role === "assistant",
        )?.content ?? "",
      /没有产生文件变更/,
    );

    const second = await openAndSubmit(alpha, "第二条写入");
    const pending = (
      await alpha.waitFor((projection) =>
        projection.approvals.some(
          (item) => item.runId === second.runId && item.status === "pending",
        ),
      )
    ).approvals.find((item) => item.runId === second.runId);
    assert.ok(pending);
    await alpha.cancel(second.runId);
    await beta.waitFor((projection) =>
      projection.approvals.some(
        (item) =>
          item.id === pending.id &&
          item.status === "rejected" &&
          item.decision === "cancel",
      ),
    );
    await assert.rejects(
      beta.decide({
        approvalId: pending.id,
        decision: "approve",
        expectedVersion: 1,
        paramsHash: pending.paramsHash,
        idempotencyKey: id(),
      }),
      (error: { code?: string }) => error.code === "RUN_CANCELLED",
    );
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("approval races, stale version, and binding mismatch", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const beta = await ctx.pair("beta");
    const first = await openAndSubmit(alpha, "竞争批准");
    const approval = (
      await alpha.waitFor((projection) =>
        projection.approvals.some((item) => item.runId === first.runId),
      )
    ).approvals.find((item) => item.runId === first.runId);
    assert.ok(approval);
    await assert.rejects(
      beta.decide({
        approvalId: approval.id,
        decision: "approve",
        expectedVersion: 99,
        paramsHash: approval.paramsHash,
        idempotencyKey: id(),
      }),
      (error: { code?: string }) => error.code === "STALE_APPROVAL_VERSION",
    );
    await assert.rejects(
      beta.decide({
        approvalId: approval.id,
        decision: "approve",
        expectedVersion: 1,
        paramsHash: "a".repeat(64),
        idempotencyKey: id(),
      }),
      (error: { code?: string }) => error.code === "APPROVAL_BINDING_MISMATCH",
    );
    const duplicateBefore = fileEffects(
      await summary(ctx.gateway.baseUrl),
      first.runId,
    );
    const [left, right] = await Promise.allSettled([
      alpha.decide({
        approvalId: approval.id,
        decision: "approve",
        expectedVersion: 1,
        paramsHash: approval.paramsHash,
        idempotencyKey: id(),
      }),
      beta.decide({
        approvalId: approval.id,
        decision: "approve",
        expectedVersion: 1,
        paramsHash: approval.paramsHash,
        idempotencyKey: id(),
      }),
    ]);
    const fulfilled = [left, right].filter(
      (item) => item.status === "fulfilled",
    );
    assert.equal(fulfilled.length, 2);
    const duplicateAfterSummary = await summary(ctx.gateway.baseUrl);
    const duplicateAfter = fileEffects(duplicateAfterSummary, first.runId);
    assert.equal(duplicateBefore.length, 0);
    assert.equal(duplicateAfter.length, 1);
    assert.equal(
      new Set(duplicateAfter.map((row) => row.effectKey)).size,
      duplicateAfter.length,
    );

    const third = await openAndSubmit(alpha, "竞争相反决定");
    const other = (
      await alpha.waitFor((projection) =>
        projection.approvals.some(
          (item) => item.runId === third.runId && item.status === "pending",
        ),
      )
    ).approvals.find((item) => item.runId === third.runId);
    assert.ok(other);
    const oppositeBefore = fileEffects(
      await summary(ctx.gateway.baseUrl),
      third.runId,
    );
    const race = await Promise.allSettled([
      alpha.decide({
        approvalId: other.id,
        decision: "approve",
        expectedVersion: 1,
        paramsHash: other.paramsHash,
        idempotencyKey: id(),
      }),
      beta.decide({
        approvalId: other.id,
        decision: "reject",
        expectedVersion: 1,
        paramsHash: other.paramsHash,
        idempotencyKey: id(),
      }),
    ]);
    const ok = race.filter((item) => item.status === "fulfilled").length;
    const rejected = race.filter((item) => item.status === "rejected").length;
    assert.equal(ok, 1);
    assert.equal(rejected, 1);
    const oppositeSummary = await summary(ctx.gateway.baseUrl);
    const oppositeAfter = fileEffects(oppositeSummary, third.runId);
    const duplicateUnchanged = fileEffects(oppositeSummary, first.runId);
    assert.equal(oppositeBefore.length, 0);
    assert.ok(oppositeAfter.length <= 1);
    assert.deepEqual(
      duplicateUnchanged.map((row) => row.effectKey),
      duplicateAfter.map((row) => row.effectKey),
    );
    const winner = race.find((item) => item.status === "fulfilled");
    let winnerDecision: string | null = null;
    if (winner?.status === "fulfilled") {
      winnerDecision = (winner.value.result as { decision: string }).decision;
      assert.equal(oppositeAfter.length, winnerDecision === "approve" ? 1 : 0);
    }
    console.log(
      JSON.stringify({
        gate: "cas-by-id",
        duplicateApprove: {
          runId: first.runId,
          approvalId: approval.id,
          fulfilled: fulfilled.length,
          before: duplicateBefore,
          after: duplicateAfter,
          fileEffects: duplicateAfter.length,
        },
        oppositeDecision: {
          runId: third.runId,
          approvalId: other.id,
          fulfilled: ok,
          conflicted: rejected,
          winnerDecision,
          before: oppositeBefore,
          after: oppositeAfter,
          fileEffects: oppositeAfter.length,
        },
      }),
    );
  } finally {
    await ctx.cleanup();
  }
});

test("cursor malformed, future, expired, unauthorized, and numeric gaps are not inferred", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    await openAndSubmit(alpha, "游标测试");
    const token = await tokenOf(ctx.gateway.baseUrl);
    const maxSeq = (await summary(ctx.gateway.baseUrl)).maxSeq;
    const headers = { authorization: `Bearer ${token}` };
    const malformed = await fetch(
      `${ctx.gateway.baseUrl}/v1/events?cursor=not-a-cursor`,
      { headers },
    );
    assert.equal(malformed.status, 400);
    const futureCursor = await sign(ctx.gateway.baseUrl, {
      seq: maxSeq + 50,
      principalId: await userId(ctx.gateway.baseUrl, token),
      exp: Date.now() + 60_000,
    });
    const future = await fetch(
      `${ctx.gateway.baseUrl}/v1/events?cursor=${encodeURIComponent(futureCursor)}`,
      { headers },
    );
    assert.equal(future.status, 409);
    const expiredCursor = await sign(ctx.gateway.baseUrl, {
      seq: 0,
      principalId: await userId(ctx.gateway.baseUrl, token),
      exp: Date.now() - 1000,
    });
    const expired = await fetch(
      `${ctx.gateway.baseUrl}/v1/events?cursor=${encodeURIComponent(expiredCursor)}`,
      { headers },
    );
    assert.equal(expired.status, 410);
    const intruder = await fetch(
      `${ctx.gateway.baseUrl}/v1/test/isolated-principal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "入侵者" }),
      },
    );
    const intruderBody = (await intruder.json()) as {
      token: string;
      userId: string;
    };
    const foreign = await sign(ctx.gateway.baseUrl, {
      seq: 0,
      principalId: intruderBody.userId,
      exp: Date.now() + 60_000,
    });
    const unauthorized = await fetch(
      `${ctx.gateway.baseUrl}/v1/events?cursor=${encodeURIComponent(foreign)}`,
      { headers },
    );
    assert.equal(unauthorized.status, 403);
    const own = await sign(ctx.gateway.baseUrl, {
      seq: 0,
      principalId: await userId(ctx.gateway.baseUrl, token),
      exp: Date.now() + 60_000,
    });
    const replay = await fetch(
      `${ctx.gateway.baseUrl}/v1/events?cursor=${encodeURIComponent(own)}`,
      { headers },
    );
    const body = (await replay.json()) as {
      events: Array<{ seq: number; eventId: string }>;
    };
    const seqs = body.events.map((event) => event.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    assert.equal(
      new Set(body.events.map((event) => event.eventId)).size,
      body.events.length,
    );
    const query = await fetch(`${ctx.gateway.baseUrl}/v1/ws?token=${secret}`);
    assert.equal(query.status, 400);
  } finally {
    await ctx.cleanup();
  }
});

test("disconnect does not cancel, and isolated or revoked devices cannot cross sessions", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const { runId } = await openAndSubmit(alpha, "保持挂起");
    await alpha.waitFor((projection) =>
      projection.approvals.some((item) => item.runId === runId),
    );
    await alpha.disconnect();
    const still = (await summary(ctx.gateway.baseUrl)).runs.find(
      (run) => run.id === runId,
    );
    assert.equal(still?.status, "awaiting_approval");
    const intruder = await fetch(
      `${ctx.gateway.baseUrl}/v1/test/isolated-principal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "别人" }),
      },
    );
    const other = (await intruder.json()) as { token: string };
    const snapshot = await fetch(`${ctx.gateway.baseUrl}/v1/snapshot`, {
      headers: { authorization: `Bearer ${other.token}` },
    });
    const snap = (await snapshot.json()) as {
      sessions: unknown[];
      approvals: unknown[];
    };
    assert.equal(snap.sessions.length, 0);
    assert.equal(snap.approvals.length, 0);
    const device = await tokenOf(ctx.gateway.baseUrl);
    const owner = await userId(ctx.gateway.baseUrl, device);
    const listed = await fetch(`${ctx.gateway.baseUrl}/v1/snapshot`, {
      headers: { authorization: `Bearer ${device}` },
    });
    const ownerSnap = (await listed.json()) as { deviceId: string };
    await fetch(`${ctx.gateway.baseUrl}/v1/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${device}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: PROTOCOL,
        commandId: id(),
        idempotencyKey: id(),
        type: "device.revoke",
        payload: { deviceId: ownerSnap.deviceId },
      }),
    });
    const revoked = await fetch(`${ctx.gateway.baseUrl}/v1/snapshot`, {
      headers: { authorization: `Bearer ${device}` },
    });
    assert.equal(revoked.status, 401);
    assert.equal(owner.length > 0, true);
  } finally {
    await ctx.cleanup();
  }
});

test("budget blocks the 31st call and partial specialist failure keeps provenance", async () => {
  const full = await bootGateway();
  try {
    const alpha = await full.pair("alpha");
    await openAndSubmit(alpha, "/budget-burn 读满预算");
    await alpha.waitFor((projection) =>
      projection.outcomes.some((item) => item.effect === "none"),
    );
    const report = await summary(full.gateway.baseUrl);
    const started = report.tools.reduce((sum, row) => sum + row.n, 0);
    assert.equal(started, 30);
    assert.equal(report.effects, 0);
    assert.equal(alpha.getSnapshot().lastError, null);
    const blocked = JSON.stringify(alpha.getSnapshot());
    assert.match(blocked, /BUDGET_EXHAUSTED|预算/);
  } finally {
    await full.cleanup();
  }

  const tight = await bootGateway({ toolBudget: 3 });
  try {
    const alpha = await tight.pair("alpha");
    await openAndSubmit(alpha, "两个专员同时读取");
    await alpha.waitFor(
      (projection) =>
        projection.outcomes.length > 0 ||
        Object.values(projection.runs).some((run) =>
          ["completed", "failed"].includes(run.status),
        ),
    );
    const report = await summary(tight.gateway.baseUrl);
    const started = report.tools.reduce((sum, row) => sum + row.n, 0);
    assert.ok(started <= 3);
    assert.equal(report.effects, 0);
  } finally {
    await tight.cleanup();
  }

  const partial = await bootGateway();
  try {
    const alpha = await partial.pair("alpha");
    const { sessionId, runId } = await openAndSubmit(
      alpha,
      "/partial-fail 提纲失败",
    );
    const done = await alpha.waitFor(
      (projection) =>
        projection.approvals.some((item) => item.runId === runId) ||
        projection.outcomes.some((item) => item.runId === runId),
    );
    const text =
      JSON.stringify(done.specialists[runId] ?? []) +
      (done.messages[sessionId]?.map((message) => message.content).join("\n") ??
        "");
    assert.match(text, /SENTINEL_WEEKLY_7F3A/);
    assert.match(text, /specialist_forced_failure|提纲专员失败/);
    assert.equal(text.includes("并未出现的虚构结论甲"), false);
  } finally {
    await partial.cleanup();
  }
});

test("demo ignores a configured key; live does not fall back", async () => {
  const ctx = await bootGateway();
  try {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const target = String(args[0]);
      if (!target.startsWith(ctx.gateway.baseUrl)) calls.push(target);
      return original(...args);
    }) as typeof fetch;
    try {
      const alpha = await ctx.pair("alpha");
      await openAndSubmit(alpha, "演示不能联网", "demo");
      await alpha.waitFor((projection) => projection.approvals.length > 0);
      assert.deepEqual(calls, []);
    } finally {
      globalThis.fetch = original;
    }
    const noKey = await bootGateway({ openaiApiKey: "" });
    try {
      const user = await noKey.pair("nokey");
      const session = await user.openSession("无密钥");
      await assert.rejects(
        user.submit({
          sessionId: String(
            (session.result as { sessionId: string }).sessionId,
          ),
          text: "你好",
          providerMode: "live",
        }),
        (error: { code?: string }) => error.code === "PROVIDER_NOT_CONFIGURED",
      );
      assert.equal((await summary(noKey.gateway.baseUrl)).runs.length, 0);
    } finally {
      await noKey.cleanup();
    }
    const db = fs.readFileSync(`${ctx.dir}/checkpoints.sqlite`);
    assert.equal(db.includes(Buffer.from(secret)), false);
  } finally {
    await ctx.cleanup();
  }
});

test("live model receives tool outputs with the original call IDs", async () => {
  const provider = await bootModelProvider((index) => ({
    message:
      index === 0
        ? modelToolCalls([
            ["list-1", "list_fixtures", {}],
            ["read-1", "read_fixture", { name: "weekly-notes.md" }],
          ])
        : { role: "assistant", content: "已根据资料整理。" },
  }));
  const ctx = await bootGateway({ openaiBaseUrl: provider.url });
  try {
    const alpha = await ctx.pair("alpha");
    const { runId } = await openAndSubmit(alpha, "读取周报", "live");
    const state = await alpha.waitFor((projection) =>
      projection.outcomes.some((outcome) => outcome.runId === runId),
    );
    assert.equal(provider.requests.length, 2);
    const [assistant, list, read] = provider.requests[1].slice(-3);
    assert.deepEqual(
      assistant.tool_calls?.map((call) => call.id),
      ["list-1", "read-1"],
    );
    assert.equal(list.tool_call_id, "list-1");
    assert.equal(read.tool_call_id, "read-1");
    assert.ok(
      JSON.parse(list.content ?? "null").files.includes("weekly-notes.md"),
    );
    assert.equal(
      JSON.parse(read.content ?? "null").text,
      fs.readFileSync("fixtures/weekly-notes.md", "utf8"),
    );
    assert.equal(
      state.outcomes.find((outcome) => outcome.runId === runId)?.resultCode,
      "read_only_done",
    );
  } finally {
    await ctx.cleanup();
    await provider.close();
  }
});

test("provider failure settles the run and the session accepts another message", async () => {
  const provider = await bootModelProvider(() => ({
    error: `鉴权失败 ${secret}`,
  }));
  const ctx = await bootGateway({ openaiBaseUrl: provider.url });
  try {
    const alpha = await ctx.pair("alpha");
    const { runId, sessionId } = await openAndSubmit(alpha, "访问实况", "live");
    const state = await alpha.waitFor((projection) =>
      projection.outcomes.some((outcome) => outcome.runId === runId),
    );
    assert.equal(
      state.outcomes.find((outcome) => outcome.runId === runId)?.resultCode,
      "provider_failed",
    );
    assert.equal(
      (await summary(ctx.gateway.baseUrl)).runs.find((run) => run.id === runId)
        ?.status,
      "failed",
    );
    assert.equal(JSON.stringify(state).includes(secret), false);
    assert.equal(state.runs[runId]?.errorCode, "PROVIDER_FAILED");
    await alpha.resync();
    assert.equal(alpha.getSnapshot().runs[runId]?.errorCode, "PROVIDER_FAILED");
    await alpha.submit({
      sessionId,
      text: "/slow-read 重试",
      providerMode: "demo",
    });
  } finally {
    await ctx.cleanup();
    await provider.close();
  }
});

test("a cancelled live run ignores a late write request", async () => {
  const requestStarted = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const provider = await bootModelProvider(async () => {
    requestStarted.resolve();
    await releaseProvider.promise;
    return {
      message: modelToolCalls([
        ["late-write", "write_demo_note", { title: "标题", body: "已取消" }],
      ]),
    };
  });
  const ctx = await bootGateway({ openaiBaseUrl: provider.url });
  try {
    const alpha = await ctx.pair("alpha");
    const opened = await alpha.openSession("取消实况");
    const { sessionId } = opened.result as { sessionId: string };
    const submission = alpha.submit({
      sessionId,
      text: "写笔记",
      providerMode: "live",
    });
    try {
      await Promise.race([requestStarted.promise, submission]);
      const state = await alpha.waitFor((projection) =>
        Object.values(projection.runs).some(
          (run) => run.sessionId === sessionId,
        ),
      );
      const run = Object.values(state.runs).find(
        (run) => run.sessionId === sessionId,
      );
      assert.ok(run);
      const runId = String(run.id);
      await alpha.cancel(runId);
      releaseProvider.resolve();
      await submission;
      await alpha.resync();
      assert.equal(
        alpha
          .getSnapshot()
          .approvals.some((approval) => approval.runId === runId),
        false,
      );
      const settled = await summary(ctx.gateway.baseUrl);
      assert.equal(
        settled.runs.find((run) => run.id === runId)?.status,
        "cancelled",
      );
      assert.equal(settled.effects, 0);
      await alpha.submit({
        sessionId,
        text: "/slow-read 继续",
        providerMode: "demo",
      });
    } finally {
      releaseProvider.resolve();
      await submission.catch(() => undefined);
    }
  } finally {
    await ctx.cleanup();
    await provider.close();
  }
});

test("tool timeout and expired approval do not write", async () => {
  const slow = await bootGateway({ toolTimeoutMs: 80 });
  try {
    await fetch(`${slow.gateway.baseUrl}/v1/test/fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "delay_before_tool_effect", delayMs: 500 }),
    });
    const alpha = await slow.pair("alpha");
    await openAndSubmit(alpha, "/slow-read 超时");
    await alpha.waitFor((projection) =>
      projection.outcomes.some(
        (item) =>
          item.resultCode === "tool_timeout" || item.excerpt.includes("超时"),
      ),
    );
    assert.equal((await summary(slow.gateway.baseUrl)).effects, 0);
  } finally {
    await slow.cleanup();
  }

  const expiry = await bootGateway({ approvalTtlMs: 200, sweepMs: 40 });
  try {
    const alpha = await expiry.pair("alpha");
    const { runId } = await openAndSubmit(alpha, "审批会过期");
    const expired = await alpha.waitFor(
      (projection) =>
        projection.outcomes.some(
          (item) =>
            item.runId === runId && item.resultCode === "approval_expired",
        ),
      4000,
    );
    assert.equal(expired.runs[runId]?.status, "failed");
    assert.equal(expired.runs[runId]?.errorCode, "approval_expired");
    assert.equal(
      expired.approvals.find((item) => item.runId === runId)?.status,
      "expired",
    );
    assert.equal((await summary(expiry.gateway.baseUrl)).effects, 0);
  } finally {
    await expiry.cleanup();
  }
});

test("approved write timeout settles the run and releases the session", async () => {
  const ctx = await bootGateway({ toolTimeoutMs: 80 });
  try {
    const alpha = await ctx.pair("alpha");
    const { runId, sessionId } = await openAndSubmit(alpha, "准备写入");
    const state = await alpha.waitFor((projection) =>
      projection.approvals.some((approval) => approval.runId === runId),
    );
    const approval = state.approvals.find((item) => item.runId === runId);
    assert.ok(approval);
    await fetch(`${ctx.gateway.baseUrl}/v1/test/fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "delay_before_tool_effect", delayMs: 500 }),
    });
    await alpha.decide({
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      paramsHash: approval.paramsHash,
    });
    const settled = await alpha.waitFor((projection) =>
      projection.outcomes.some((outcome) => outcome.runId === runId),
    );
    const outcome = settled.outcomes.find((item) => item.runId === runId);
    assert.equal(outcome?.resultCode, "tool_timeout");
    assert.equal(outcome?.effect, "none");
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 0);
    await alpha.submit({
      sessionId,
      text: "/slow-read 继续",
      providerMode: "demo",
    });
  } finally {
    await ctx.cleanup();
  }
});

test("an interrupted flush reports an uncertain write outcome", async (t) => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const { runId } = await openAndSubmit(alpha, "写入后落盘失败");
    const state = await alpha.waitFor((projection) =>
      projection.approvals.some((approval) => approval.runId === runId),
    );
    const approval = state.approvals.find((item) => item.runId === runId);
    assert.ok(approval);
    t.mock.method(fs, "fsyncSync", () => {
      throw new Error("模拟落盘失败");
    });
    await alpha.decide({
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      paramsHash: approval.paramsHash,
    });
    const settled = await alpha.waitFor((projection) =>
      projection.outcomes.some((outcome) => outcome.runId === runId),
    );
    const outcome = settled.outcomes.find((item) => item.runId === runId);
    assert.equal(outcome?.resultCode, "outcome_unknown");
    assert.equal(outcome?.effect, "unknown");
    assert.equal(fs.existsSync(`${ctx.dir}/sandbox/notes/${runId}.md`), true);
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("late tool result after cancel stays on the cancelled run and is not repeated", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const beta = await ctx.pair("beta");
    const { runId } = await openAndSubmit(alpha, "晚到结果");
    const approval = (
      await alpha.waitFor((projection) =>
        projection.approvals.some((item) => item.runId === runId),
      )
    ).approvals.find((item) => item.runId === runId);
    assert.ok(approval);
    await fetch(`${ctx.gateway.baseUrl}/v1/test/fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "hold_after_effect" }),
    });
    const deciding = beta.decide({
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: 1,
      paramsHash: approval.paramsHash,
      idempotencyKey: id(),
    });
    const started = Date.now();
    while ((await summary(ctx.gateway.baseUrl)).effects < 1) {
      if (Date.now() - started > 4000) throw new Error("没有观察到副作用");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await alpha.cancel(runId);
    await fetch(`${ctx.gateway.baseUrl}/v1/test/release`, { method: "POST" });
    await deciding;
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 1);
    const run = (await summary(ctx.gateway.baseUrl)).runs.find(
      (item) => item.id === runId,
    );
    assert.equal(run?.status, "cancelled");
  } finally {
    await ctx.cleanup();
  }
});

test("checkpoint lag reloads the ledger instead of writing again", async () => {
  const ctx = await bootGateway();
  try {
    const alpha = await ctx.pair("alpha");
    const { runId } = await openAndSubmit(alpha, "检查点滞后");
    const approval = (
      await alpha.waitFor((projection) =>
        projection.approvals.some((item) => item.runId === runId),
      )
    ).approvals[0];
    assert.ok(approval);
    await fetch(`${ctx.gateway.baseUrl}/v1/test/fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "skip_checkpoint_advance" }),
    });
    await assert.rejects(
      alpha.decide({
        approvalId: approval.id,
        decision: "approve",
        expectedVersion: 1,
        paramsHash: approval.paramsHash,
      }),
    );
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 1);
    await fetch(`${ctx.gateway.baseUrl}/v1/test/fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "clear" }),
    });
    await fetch(`${ctx.gateway.baseUrl}/v1/test/reload`, { method: "POST" });
    await alpha.waitFor((projection) =>
      projection.outcomes.some((item) => item.runId === runId),
    );
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("startup closes approvals left pending by an old cancelled run", async () => {
  const ctx = await bootGateway();
  try {
    const creator = await ctx.pair("发起人");
    const approver = await ctx.pair("审批人");
    const { sessionId, runId } = await openAndSubmit(creator, "历史取消恢复");
    const ready = await approver.waitFor((projection) =>
      projection.approvals.some((approval) => approval.runId === runId),
    );
    const approval = ready.approvals.find((item) => item.runId === runId);
    assert.ok(approval);
    const stamp = new Date().toISOString();
    ctx.gateway.store.transaction(() => {
      ctx.gateway.store.patchRun(runId, {
        status: "cancelled",
        result_code: "user_cancelled",
        cancel_requested_at: stamp,
        terminal_at: stamp,
      });
    });
    await ctx.gateway.runtime.reload();
    const restored = await approver.waitFor(
      (projection) =>
        projection.approvals.some(
          (item) => item.id === approval.id && item.decision === "cancel",
        ) && projection.outcomes.some((item) => item.runId === runId),
    );
    assert.equal(
      restored.approvals.find((item) => item.id === approval.id)?.status,
      "rejected",
    );
    assert.equal(
      restored.outcomes.find((item) => item.runId === runId)?.resultCode,
      "user_cancelled",
    );
    await creator.submit({
      sessionId,
      text: "继续同会话",
      providerMode: "demo",
    });
    assert.equal((await summary(ctx.gateway.baseUrl)).effects, 0);
  } finally {
    await ctx.cleanup();
  }
});

async function tokenOf(baseUrl: string): Promise<string> {
  const minted = await fetch(`${baseUrl}/v1/pairing/mint`, { method: "POST" });
  const body = (await minted.json()) as { code: string };
  const redeemed = await fetch(`${baseUrl}/v1/pairing/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: body.code, deviceLabel: "raw", kind: "test" }),
  });
  return ((await redeemed.json()) as { token: string }).token;
}

async function userId(baseUrl: string, token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return ((await response.json()) as { userId: string }).userId;
}

function fileEffects(
  report: { effectRows?: EffectRow[] },
  runId: string,
): EffectRow[] {
  return (report.effectRows ?? []).filter(
    (row) => row.runId === runId && row.kind === "write",
  );
}

async function sign(
  baseUrl: string,
  body: { seq: number; principalId: string; exp: number },
): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/test/sign-cursor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return ((await response.json()) as { cursor: string }).cursor;
}

type ModelRequestMessage = {
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
};

async function bootModelProvider(
  respond: (
    index: number,
  ) =>
    | { message: Record<string, unknown>; error?: never }
    | { error: string; message?: never }
    | Promise<{ message: Record<string, unknown>; error?: never }>,
) {
  const requests: ModelRequestMessage[][] = [];
  const server = createServer(async (request, response) => {
    try {
      let text = "";
      request.setEncoding("utf8");
      for await (const chunk of request) text += chunk;
      const index = requests.length;
      requests.push(
        (JSON.parse(text) as { messages: ModelRequestMessage[] }).messages,
      );
      const result = await respond(index);
      response.setHeader("content-type", "application/json");
      if (result.error !== undefined) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { message: result.error } }));
        return;
      }
      response.end(
        JSON.stringify({
          id: `mock-${index}`,
          object: "chat.completion",
          created: 0,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: result.message,
              finish_reason: result.message.tool_calls ? "tool_calls" : "stop",
            },
          ],
        }),
      );
    } catch {
      response.statusCode = 500;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function modelToolCalls(
  calls: Array<[string, string, Record<string, unknown>]>,
) {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map(([id, name, args]) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    })),
  };
}
