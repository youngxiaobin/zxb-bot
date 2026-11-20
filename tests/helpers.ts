import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startGateway, type GatewayHandle } from "@pa/gateway";
import {
  MemoryCredentialStore,
  MemoryProjectionStore,
  PersonalAgentClient,
} from "@pa/sdk";

const fixturesDir = path.resolve("fixtures");

export async function bootGateway(
  overrides: Partial<Parameters<typeof startGateway>[0]> = {},
): Promise<{
  gateway: GatewayHandle;
  dir: string;
  pair: (
    label: string,
    kind?: "test" | "cli" | "desktop" | "mobile",
  ) => Promise<PersonalAgentClient>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "pa-"));
  const clients: PersonalAgentClient[] = [];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    fixturesDir,
    allowUnsafeLan: false,
    testHooks: true,
    corsOrigin: "http://127.0.0.1:47331",
    openaiApiKey: "sk-test-LEAK-PROBE-9f3a",
    openaiBaseUrl: "http://127.0.0.1:9",
    openaiModel: "gpt-4o-mini",
    toolBudget: 30,
    maxModelSteps: 30,
    executionBudgetMs: 120_000,
    toolTimeoutMs: 20_000,
    approvalTtlMs: 600_000,
    cursorTtlMs: 86_400_000,
    pairingTtlMs: 300_000,
    deviceTokenTtlMs: 2_592_000_000,
    sweepMs: 60_000,
    ...overrides,
    dataDir: overrides.dataDir ?? dir,
  });
  return {
    gateway,
    dir: overrides.dataDir ?? dir,
    pair: async (label, kind = "test") => {
      const minted = await fetch(`${gateway.baseUrl}/v1/pairing/mint`, {
        method: "POST",
      });
      const code = (await minted.json()) as { code: string };
      const client = new PersonalAgentClient({
        baseUrl: gateway.baseUrl,
        credentials: new MemoryCredentialStore(),
        persistence: new MemoryProjectionStore(),
      });
      await client.redeem({ code: code.code, deviceLabel: label, kind });
      await client.connect();
      clients.push(client);
      return client;
    },
    cleanup: async () => {
      await Promise.all(clients.map((client) => client.disconnect()));
      await gateway.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function pairClient(
  baseUrl: string,
  label: string,
  kind: "test" | "cli" | "desktop" | "mobile" = "test",
) {
  const minted = await fetch(`${baseUrl}/v1/pairing/mint`, { method: "POST" });
  const code = (await minted.json()) as { code: string };
  const client = new PersonalAgentClient({
    baseUrl,
    credentials: new MemoryCredentialStore(),
    persistence: new MemoryProjectionStore(),
  });
  await client.redeem({ code: code.code, deviceLabel: label, kind });
  await client.connect();
  return client;
}

export async function openAndSubmit(
  client: PersonalAgentClient,
  text: string,
  providerMode: "demo" | "live" = "demo",
) {
  const opened = await client.openSession("测试会话");
  const sessionId = String((opened.result as { sessionId: string }).sessionId);
  await client.resync();
  const submitted = await client.submit({ sessionId, text, providerMode });
  return {
    sessionId,
    runId: String((submitted.result as { runId: string }).runId),
    submitted,
  };
}

export type EffectRow = {
  effectKey: string;
  runId: string;
  approvalId: string | null;
  toolCallId: string;
  kind: string;
  file: string;
};

export async function summary(baseUrl: string): Promise<{
  effects: number;
  effectRows: EffectRow[];
  tools: Array<{ status: string; n: number }>;
  runs: Array<Record<string, unknown>>;
  maxSeq: number;
}> {
  const response = await fetch(`${baseUrl}/v1/test/summary`);
  return (await response.json()) as {
    effects: number;
    effectRows: EffectRow[];
    tools: Array<{ status: string; n: number }>;
    runs: Array<Record<string, unknown>>;
    maxSeq: number;
  };
}

export function id(): string {
  return crypto.randomUUID();
}
