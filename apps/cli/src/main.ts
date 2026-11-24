import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  MemoryProjectionStore,
  PersonalAgentClient,
  type CredentialStore,
} from "@pa/sdk";

type Saved = {
  baseUrl: string;
  token: string;
  deviceId: string;
  userId: string;
};

class FileCredentials implements CredentialStore {
  constructor(private readonly file: string) {}

  async load() {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as Saved;
  }

  async save(value: Saved) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  async clear() {
    if (fs.existsSync(this.file)) fs.rmSync(this.file);
  }
}

const credentialsPath =
  process.env.PA_CREDENTIALS_PATH ??
  path.join(os.homedir(), ".personal-agent", "credentials.json");
const baseFlag =
  flag("--base-url") ?? process.env.PA_BASE_URL ?? "http://127.0.0.1:47471";
const [command, ...rest] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--base-url" && arg !== baseFlag);

async function main(): Promise<void> {
  if (command === "pairing-code") {
    const response = await fetch(`${baseFlag}/v1/pairing/mint`, {
      method: "POST",
    });
    const body = (await response.json()) as {
      code?: string;
      error?: { message: string };
    };
    if (!response.ok || !body.code) {
      process.stderr.write(`${body.error?.message ?? "无法签发配对码"}\n`);
      process.exit(1);
    }
    process.stdout.write(`一次性配对码：${body.code}\n`);
    process.stdout.write(
      "手机或另一台设备需要手动填写网关地址和这个配对码。配对码用过即失效。\n",
    );
    return;
  }
  const credentials = new FileCredentials(credentialsPath);
  const client = new PersonalAgentClient({
    baseUrl: baseFlag,
    credentials,
    persistence: new MemoryProjectionStore(),
  });
  if (command === "pair") {
    const code = flag("--code") ?? rest[0];
    if (!code) {
      const minted = await fetch(`${baseFlag}/v1/pairing/mint`, {
        method: "POST",
      });
      const body = (await minted.json()) as {
        code?: string;
        error?: { message: string };
      };
      if (!body.code) {
        process.stderr.write(
          `${body.error?.message ?? "本机签发失败。远程网关请传入 --code。"}\n`,
        );
        process.exit(1);
      }
      await client.redeem({
        code: body.code,
        deviceLabel: "命令行",
        kind: "cli",
      });
    } else {
      await client.redeem({ code, deviceLabel: "命令行", kind: "cli" });
    }
    process.stdout.write(
      "命令行设备已配对。令牌保存在本机凭据文件，不会打印。\n",
    );
    process.exit(0);
  }
  const saved = await credentials.load();
  if (!saved?.token) {
    process.stderr.write("尚未配对。请先运行 pair。\n");
    process.exit(1);
  }
  await client.connect();
  if (command === "status") {
    const health = await fetch(`${baseFlag}/v1/health`);
    process.stdout.write(`${await health.text()}\n`);
    const snap = client.getSnapshot();
    process.stdout.write(
      `设备 ${snap.self?.deviceId ?? saved.deviceId} 连接 ${snap.connection}\n`,
    );
    process.exit(0);
  }
  if (command === "sessions") {
    for (const session of client.getSnapshot().sessions)
      process.stdout.write(`${session.id}  ${session.title}\n`);
    if (client.getSnapshot().sessions.length === 0)
      process.stdout.write("还没有可见会话。\n");
    process.exit(0);
  }
  if (command === "approve" || command === "reject") {
    const approval = client
      .getSnapshot()
      .approvals.find(
        (item) => item.id === rest[0] && item.status === "pending",
      );
    if (!approval) {
      process.stderr.write("没有找到待处理审批。\n");
      process.exit(1);
    }
    await client.decide({
      approvalId: approval.id,
      decision: command === "approve" ? "approve" : "reject",
      expectedVersion: approval.version,
      paramsHash: approval.paramsHash,
    });
    process.stdout.write(
      command === "approve" ? "已提交批准。\n" : "已拒绝，不会写入。\n",
    );
    process.exit(0);
  }
  if (command === "submit") {
    const text = rest
      .filter((arg) => arg !== "--live")
      .join(" ")
      .trim();
    if (!text) {
      process.stderr.write("用法：submit <委托内容>\n");
      process.exit(1);
    }
    let sessionId = client.getSnapshot().sessions.at(-1)?.id;
    if (!sessionId) {
      const opened = await client.openSession("命令行会话");
      sessionId = String((opened.result as { sessionId: string }).sessionId);
      await client.resync();
    }
    const receipt = await client.submit({
      sessionId,
      text,
      providerMode: rest.includes("--live") ? "live" : "demo",
    });
    const { runId } = receipt.result as { runId: string };
    const { pending, reply } = await waitForRun(client, sessionId, runId);
    if (pending) {
      process.stdout.write(
        `等待审批 ${pending.id} 版本 ${pending.version}\n工具 ${pending.toolName}\n目标 ${pending.resource}\n`,
      );
    }
    if (reply) process.stdout.write(`${reply.content}\n`);
    await client.disconnect();
    process.exit(0);
  }
  if (command === "cancel") {
    await client.cancel(rest[0] ?? "");
    process.stdout.write("已接受取消。这不保证正在执行的工具立刻停止。\n");
    process.exit(0);
  }
  await chat(client, rest.includes("--live") ? "live" : "demo");
}

async function chat(
  client: PersonalAgentClient,
  providerMode: "demo" | "live",
): Promise<void> {
  let sessionId = client.getSnapshot().sessions[0]?.id;
  if (!sessionId) {
    const opened = await client.openSession("命令行会话");
    sessionId = String((opened.result as { sessionId: string }).sessionId);
    await client.resync();
  }
  process.stdout.write(
    `会话 ${sessionId}，提供方 ${providerMode === "demo" ? "演示（不是大模型）" : "实况"}。\n`,
  );
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  // A piped stdin can report flowing without delivering chunks to the
  // listener readline registered. Restart the read so scripted clients work.
  process.stdin.pause();
  process.stdin.resume();
  rl.setPrompt("> ");
  rl.prompt();
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      void (async () => {
        rl.pause();
        const text = line.trim();
        if (!text) {
          rl.prompt();
          rl.resume();
          return;
        }
        if (text === "/exit") {
          rl.close();
          resolve();
          return;
        }
        const receipt = await client.submit({ sessionId, text, providerMode });
        const { runId } = receipt.result as { runId: string };
        const { pending, reply } = await waitForRun(client, sessionId, runId);
        if (pending) {
          process.stdout.write(
            `等待审批 ${pending.id}\n工具 ${pending.toolName}\n目标 ${pending.resource}\n参数 ${JSON.stringify(pending.params)}\n`,
          );
        }
        if (reply) process.stdout.write(`${reply.content}\n`);
        rl.prompt();
        rl.resume();
      })().catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : "命令失败"}\n`,
        );
        rl.close();
        resolve();
      });
    });
    rl.on("close", () => resolve());
  });
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "命令失败"}\n`,
  );
  process.exit(1);
});

async function waitForRun(
  client: PersonalAgentClient,
  sessionId: string,
  runId: string,
) {
  const snapshot = await client.waitFor((projection) => {
    const status = projection.runs[runId]?.status;
    return (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "timed_out" ||
      projection.approvals.some(
        (approval) => approval.runId === runId && approval.status === "pending",
      )
    );
  });
  return {
    pending: snapshot.approvals.find(
      (approval) => approval.runId === runId && approval.status === "pending",
    ),
    reply: snapshot.messages[sessionId]?.findLast(
      (message) => message.runId === runId && message.role === "assistant",
    ),
  };
}
