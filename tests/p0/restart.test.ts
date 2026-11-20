import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PROTOCOL } from "@pa/contracts";
import { assertBindPolicy } from "@pa/gateway";

const secret = "sk-test-LEAK-PROBE-9f3a";
const repo = path.resolve(".");

test("bind policy refuses silent LAN exposure", () => {
  assert.throws(
    () => assertBindPolicy("0.0.0.0", false),
    /UNSAFE_LAN_DISABLED/,
  );
  assert.doesNotThrow(() => assertBindPolicy("127.0.0.1", false));
  assert.doesNotThrow(() => assertBindPolicy("0.0.0.0", true));
});

test("SIGKILL while approval is pending, then approve after restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pa-kill-"));
  const port = await freePort();
  let child = await launch(dir, port);
  try {
    const token = await pair(port);
    const sessionId = await command(port, token, "session.open", {});
    const runId = await command(port, token, "message.submit", {
      sessionId: sessionId.sessionId,
      text: "重启后继续审批",
      providerMode: "demo",
    });
    const approval = await waitApproval(port, token, String(runId.runId));
    const logs = child.logs();
    assert.equal(logs.includes(secret), false);
    await child.kill();
    child = await launch(dir, port);
    const after = await snapshot(port, token);
    assert.equal(
      after.approvals.some(
        (item) => item.id === approval.id && item.status === "pending",
      ),
      true,
    );
    await command(port, token, "approval.decide", {
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      paramsHash: approval.paramsHash,
    });
    const summary = await testSummary(port);
    assert.equal(summary.effects, 1);
    assert.equal(child.logs().includes(secret), false);
    console.log(
      JSON.stringify({
        gate: "pending-approval-restart",
        approvalId: approval.id,
        version: approval.version,
        statusAfterRestart: "pending",
        effects: summary.effects,
        maxSeq: summary.maxSeq,
      }),
    );
  } finally {
    await child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGKILL after approval commit but before resume still writes once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pa-resume-"));
  const port = await freePort();
  let child = await launch(dir, port);
  try {
    const token = await pair(port);
    const sessionId = await command(port, token, "session.open", {});
    const runId = await command(port, token, "message.submit", {
      sessionId: sessionId.sessionId,
      text: "批准后崩溃",
      providerMode: "demo",
    });
    const approval = await waitApproval(port, token, String(runId.runId));
    await fetch(`http://127.0.0.1:${port}/v1/test/fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "exit_after_approval_before_resume" }),
    });
    await command(port, token, "approval.decide", {
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      paramsHash: approval.paramsHash,
    }).catch(() => undefined);
    await child.exited();
    child = await launch(dir, port);
    const summary = await testSummary(port);
    assert.equal(summary.effects, 1);
    const runs = summary.runs as Array<{ id: string; status: string }>;
    const runStatus = runs.find((run) => run.id === runId.runId)?.status;
    assert.equal(runStatus, "completed");
    console.log(
      JSON.stringify({
        gate: "approval-persisted-pre-resume-restart",
        approvalId: approval.id,
        version: approval.version,
        effects: summary.effects,
        runStatus,
        maxSeq: summary.maxSeq,
      }),
    );
  } finally {
    await child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGKILL after the file write but before the ledger result does not write again", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pa-unknown-"));
  const port = await freePort();
  let child = await launch(dir, port);
  try {
    const token = await pair(port);
    const sessionId = await command(port, token, "session.open", {});
    const runId = await command(port, token, "message.submit", {
      sessionId: sessionId.sessionId,
      text: "写入后崩溃",
      providerMode: "demo",
    });
    const approval = await waitApproval(port, token, String(runId.runId));
    await fetch(`http://127.0.0.1:${port}/v1/test/fault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "effect_succeed_then_crash_before_result" }),
    });
    await command(port, token, "approval.decide", {
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      paramsHash: approval.paramsHash,
    }).catch(() => undefined);
    await child.exited();
    child = await launch(dir, port);
    const summary = await testSummary(port);
    assert.equal(summary.effects, 1);
    const runs = summary.runs as Array<{
      id: string;
      status: string;
      result_code?: string;
    }>;
    const runStatus = runs.find((run) => run.id === runId.runId)?.status;
    assert.equal(runStatus, "failed");
    console.log(
      JSON.stringify({
        gate: "written-pre-ledger-crash",
        approvalId: approval.id,
        version: approval.version,
        effects: summary.effects,
        runStatus,
        maxSeq: summary.maxSeq,
      }),
    );
  } finally {
    await child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

async function launch(dir: string, port: number) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/gateway/src/main.ts"],
    {
      cwd: repo,
      env: {
        ...process.env,
        PA_HOST: "127.0.0.1",
        PA_PORT: String(port),
        PA_DATA_DIR: dir,
        PA_FIXTURES_DIR: path.join(repo, "fixtures"),
        PA_TEST_HOOKS: "1",
        OPENAI_API_KEY: secret,
        PA_ALLOW_UNSAFE_LAN: "0",
        LANGCHAIN_TRACING_V2: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  await waitHealth(port, child, () => logs);
  return {
    logs: () => logs,
    kill: async () => kill(child),
    exited: () => waitExit(child),
  };
}

async function waitHealth(
  port: number,
  child: ChildProcess,
  logs: () => string,
) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (child.exitCode !== null) throw new Error(logs());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error(logs() || "网关没有启动");
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGKILL");
  await waitExit(child);
}

function waitExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function pair(port: number): Promise<string> {
  const minted = await fetch(`http://127.0.0.1:${port}/v1/pairing/mint`, {
    method: "POST",
  });
  const body = (await minted.json()) as { code: string };
  const redeemed = await fetch(`http://127.0.0.1:${port}/v1/pairing/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: body.code,
      deviceLabel: "重启",
      kind: "test",
    }),
  });
  return ((await redeemed.json()) as { token: string }).token;
}

async function command(
  port: number,
  token: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const idempotencyKey = crypto.randomUUID();
  const response = await fetch(`http://127.0.0.1:${port}/v1/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: PROTOCOL,
      commandId: idempotencyKey,
      idempotencyKey,
      type,
      payload,
    }),
  });
  const body = (await response.json()) as {
    result?: Record<string, unknown>;
    error?: { message: string };
  };
  if (!response.ok) throw new Error(body.error?.message ?? "命令失败");
  return body.result ?? {};
}

async function snapshot(port: number, token: string) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await response.json()) as {
    approvals: Array<{
      id: string;
      status: string;
      version: number;
      paramsHash: string;
    }>;
  };
}

async function waitApproval(port: number, token: string, runId: string) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const body = await snapshot(port, token);
    const found = body.approvals.find((item) => item.status === "pending");
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`没有等到审批 ${runId}`);
}

async function testSummary(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/test/summary`);
  return (await response.json()) as {
    effects: number;
    maxSeq: number;
    runs: Array<Record<string, unknown>>;
  };
}
