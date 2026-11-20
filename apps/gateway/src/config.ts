import fs from "node:fs";
import path from "node:path";
import {
  CHECKPOINT_COMPAT,
  PROTOCOL,
  SCHEMA_VERSION,
  WORKFLOW_VERSION,
} from "@pa/contracts";

export type GatewayConfig = {
  host: string;
  port: number;
  dataDir: string;
  fixturesDir: string;
  allowUnsafeLan: boolean;
  testHooks: boolean;
  corsOrigin: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  toolBudget: number;
  maxModelSteps: number;
  executionBudgetMs: number;
  toolTimeoutMs: number;
  approvalTtlMs: number;
  cursorTtlMs: number;
  pairingTtlMs: number;
  deviceTokenTtlMs: number;
  sweepMs: number;
};

export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  return {
    host: env.PA_HOST ?? "127.0.0.1",
    port: integer(env, "PA_PORT", 47471),
    dataDir: path.resolve(env.PA_DATA_DIR ?? "./data"),
    fixturesDir: path.resolve(env.PA_FIXTURES_DIR ?? "./fixtures"),
    allowUnsafeLan: env.PA_ALLOW_UNSAFE_LAN === "1",
    testHooks: env.PA_TEST_HOOKS === "1",
    corsOrigin: env.PA_CORS_ORIGIN ?? "http://127.0.0.1:47331",
    openaiApiKey: env.OPENAI_API_KEY ?? "",
    openaiBaseUrl: env.OPENAI_BASE_URL ?? "",
    openaiModel: env.OPENAI_MODEL ?? "gpt-4o-mini",
    toolBudget: integer(env, "PA_TOOL_BUDGET", 30),
    maxModelSteps: integer(env, "PA_MAX_MODEL_STEPS", 30),
    executionBudgetMs: integer(env, "PA_EXECUTION_BUDGET_MS", 120_000),
    toolTimeoutMs: integer(env, "PA_TOOL_TIMEOUT_MS", 20_000),
    approvalTtlMs: integer(env, "PA_APPROVAL_TTL_MS", 600_000),
    cursorTtlMs: integer(env, "PA_CURSOR_TTL_MS", 86_400_000),
    pairingTtlMs: integer(env, "PA_PAIRING_TTL_MS", 300_000),
    deviceTokenTtlMs: integer(env, "PA_DEVICE_TOKEN_TTL_MS", 2_592_000_000),
    sweepMs: integer(env, "PA_SWEEP_MS", 1000),
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function assertBindPolicy(host: string, allowUnsafeLan: boolean): void {
  if (!isLoopbackHost(host) && !allowUnsafeLan) {
    throw new Error(
      "UNSAFE_LAN_DISABLED: 非回环地址必须显式设置 PA_ALLOW_UNSAFE_LAN=1。明文局域网没有 TLS。",
    );
  }
}

export function healthBody(config: GatewayConfig): Record<string, unknown> {
  return {
    ok: true,
    service: "personal-agent-gateway",
    protocol: PROTOCOL,
    workflowVersion: WORKFLOW_VERSION,
    checkpointCompat: CHECKPOINT_COMPAT,
    schemaVersion: SCHEMA_VERSION,
    node: process.version,
    unsafeLan: config.allowUnsafeLan && !isLoopbackHost(config.host),
    testHooks: config.testHooks,
    providers: { demo: true, liveConfigured: config.openaiApiKey.length > 0 },
    singleExecutor: true,
    checkpointFencing: "app-lock-only",
  };
}
