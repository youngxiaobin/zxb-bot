import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import {
  MemoryCredentialStore,
  MemoryProjectionStore,
  PersonalAgentClient,
  emptyProjection,
  validateGatewayUrl,
  type Projection,
} from "@pa/sdk";
import { secureCredentials, secureProjection } from "./storage";

const EMPTY = emptyProjection();
let client: PersonalAgentClient | null = null;
const listeners = new Set<() => void>();
let watching = false;

function emit(): void {
  for (const listener of listeners) listener();
}

export function getClient(): PersonalAgentClient | null {
  return client;
}

function watchAppState(next: PersonalAgentClient): void {
  if (watching) return;
  watching = true;
  AppState.addEventListener("change", (state) => {
    if (state === "active" && client === next) {
      void next.resync().catch(() => undefined);
    }
  });
}

async function activate(next: PersonalAgentClient): Promise<void> {
  const snap = next.getSnapshot();
  if (snap.connection !== "live") {
    const message = snap.lastError?.message ?? "设备令牌无效、过期或已吊销。";
    await next.forget();
    throw new Error(message);
  }
  client = next;
  emit();
  watchAppState(next);
}

export async function connectWithPair(
  baseUrl: string,
  code: string,
): Promise<void> {
  const url = validateGatewayUrl(baseUrl);
  const scratchCreds = new MemoryCredentialStore();
  const scratch = new PersonalAgentClient({
    baseUrl: url,
    credentials: scratchCreds,
    persistence: new MemoryProjectionStore(),
  });
  try {
    await scratch.redeem({
      code: code.trim(),
      deviceLabel: "手机",
      kind: "mobile",
    });
    await scratch.connect();
  } catch (error) {
    await scratch.forget();
    throw error;
  }
  const saved = await scratchCreds.load();
  await scratch.forget();
  if (!saved?.token) throw new Error("配对没有返回设备令牌。");
  await installToken(url, saved.token);
}

export async function connectWithToken(
  baseUrl: string,
  token: string,
): Promise<void> {
  const url = validateGatewayUrl(baseUrl);
  const trimmed = token.trim();
  const probe = new PersonalAgentClient({
    baseUrl: url,
    credentials: new MemoryCredentialStore(),
    persistence: new MemoryProjectionStore(),
  });
  try {
    await probe.adoptToken(trimmed);
  } catch (error) {
    await probe.forget();
    throw error;
  }
  await probe.forget();
  await installToken(url, trimmed);
}

async function installToken(url: string, token: string): Promise<void> {
  await client?.forget();
  const next = new PersonalAgentClient({
    baseUrl: url,
    credentials: secureCredentials,
    persistence: secureProjection,
  });
  try {
    await next.adoptToken(token);
    await next.connect();
    await activate(next);
  } catch (error) {
    await next.forget();
    throw error;
  }
}

export async function disconnectGateway(): Promise<void> {
  await client?.forget();
  client = null;
  emit();
}

export function useProjection(): Projection {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const stop = client?.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stop?.();
      };
    },
    () => client?.getSnapshot() ?? EMPTY,
    () => client?.getSnapshot() ?? EMPTY,
  );
}
