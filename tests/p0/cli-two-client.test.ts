import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MemoryProjectionStore, PersonalAgentClient } from "@pa/sdk";
import { bootGateway, summary } from "../helpers.js";

const repo = path.resolve(".");

test("CLI initiator and CLI approver finish the same run", async () => {
  const ctx = await bootGateway();
  try {
    const credA = path.join(ctx.dir, "cli-a.json");
    const credB = path.join(ctx.dir, "cli-b.json");
    const pairedA = await runCli(ctx.gateway.baseUrl, credA, ["pair"]);
    const pairedB = await runCli(ctx.gateway.baseUrl, credB, ["pair"]);
    assert.equal(pairedA.code, 0);
    assert.equal(pairedB.code, 0);
    assert.equal(
      pairedA.stdout.includes(JSON.parse(fs.readFileSync(credA, "utf8")).token),
      false,
    );
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(credA).mode & 0o777, 0o600);
    }
    const submitted = await runCli(ctx.gateway.baseUrl, credA, [
      "submit",
      "请根据资料整理摘要并等待批准",
    ]);
    assert.equal(submitted.code, 0, submitted.stderr);
    const approvalId = /等待审批 ([A-Za-z0-9-]{8,80})/.exec(
      submitted.stdout,
    )?.[1];
    assert.ok(approvalId, submitted.stdout);
    const approved = await runCli(ctx.gateway.baseUrl, credB, [
      "approve",
      approvalId,
    ]);
    assert.equal(approved.code, 0, approved.stderr);
    assert.match(approved.stdout, /已提交批准/);
    const report = await summary(ctx.gateway.baseUrl);
    assert.equal(report.effects, 1);
    const note = fs
      .readdirSync(path.join(ctx.dir, "sandbox", "notes"))
      .filter((name) => name.endsWith(".md"));
    assert.equal(note.length, 1);
    const saved = JSON.parse(fs.readFileSync(credA, "utf8")) as {
      baseUrl: string;
      token: string;
      deviceId: string;
      userId: string;
    };
    const viewer = new PersonalAgentClient({
      baseUrl: ctx.gateway.baseUrl,
      credentials: {
        async load() {
          return saved;
        },
        async save() {},
        async clear() {},
      },
      persistence: new MemoryProjectionStore(),
    });
    await viewer.connect();
    await viewer.resync();
    const text = JSON.stringify(viewer.getSnapshot().messages);
    assert.match(text, /已写入/);
    assert.match(text, /SENTINEL_WEEKLY_7F3A/);
    await viewer.disconnect();

    const next = await runCli(ctx.gateway.baseUrl, credA, [
      "submit",
      "请在同一个会话里整理第二份摘要",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const nextApprovalId = /等待审批 ([A-Za-z0-9-]{8,80})/.exec(
      next.stdout,
    )?.[1];
    assert.ok(nextApprovalId, next.stdout);
    assert.notEqual(nextApprovalId, approvalId);
    assert.doesNotMatch(next.stdout, /已写入/);
    const snapshot = await fetch(`${ctx.gateway.baseUrl}/v1/snapshot`, {
      headers: { authorization: `Bearer ${saved.token}` },
    });
    const { sessions, approvals } = (await snapshot.json()) as {
      sessions: Array<{ id: string }>;
      approvals: Array<{ id: string; sessionId: string; status: string }>;
    };
    assert.equal(sessions.length, 1);
    const nextApproval = approvals.find((item) => item.id === nextApprovalId);
    assert.equal(nextApproval?.sessionId, sessions[0]?.id);
    assert.equal(nextApproval?.status, "pending");
  } finally {
    await ctx.cleanup();
  }
});

test("CLI reject leaves no write", async () => {
  const ctx = await bootGateway();
  try {
    const credA = path.join(ctx.dir, "cli-a.json");
    const credB = path.join(ctx.dir, "cli-b.json");
    assert.equal((await runCli(ctx.gateway.baseUrl, credA, ["pair"])).code, 0);
    assert.equal((await runCli(ctx.gateway.baseUrl, credB, ["pair"])).code, 0);
    const submitted = await runCli(ctx.gateway.baseUrl, credA, [
      "submit",
      "请整理但不要写入",
    ]);
    assert.equal(submitted.code, 0, submitted.stderr);
    const approvalId = /等待审批 ([A-Za-z0-9-]{8,80})/.exec(
      submitted.stdout,
    )?.[1];
    assert.ok(approvalId, submitted.stdout);
    const rejected = await runCli(ctx.gateway.baseUrl, credB, [
      "reject",
      approvalId,
    ]);
    assert.equal(rejected.code, 0, rejected.stderr);
    assert.match(rejected.stdout, /已拒绝，不会写入/);
    const report = await summary(ctx.gateway.baseUrl);
    assert.equal(report.effects, 0);
    assert.equal(
      fs.existsSync(path.join(ctx.dir, "sandbox", "notes"))
        ? fs.readdirSync(path.join(ctx.dir, "sandbox", "notes")).length
        : 0,
      0,
    );
  } finally {
    await ctx.cleanup();
  }
});

function runCli(baseUrl: string, credentials: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/cli/src/main.ts", ...args],
        {
          cwd: repo,
          env: {
            ...process.env,
            PA_BASE_URL: baseUrl,
            PA_CREDENTIALS_PATH: credentials,
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    },
  );
}
