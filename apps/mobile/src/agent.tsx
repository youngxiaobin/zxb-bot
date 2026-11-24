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
let stopClientSubscription: (() => void) | undefined;
let connectingClient: PersonalAgentClient | null = null;
let selection = 0;
let storageTail = Promise.resolve();

type SavedCredentials = NonNullable<
  Awaited<ReturnType<typeof secureCredentials.load>>
>;

function emit(): void {
  for (const listener of listeners) listener();
}

export function getClient(): PersonalAgentClient | null {
  return client;
}

export async function connectWithPair(
  baseUrl: string,
  code: string,
): Promise<void> {
  const url = validateGatewayUrl(baseUrl);
  const requested = ++selection;
  const scratchCreds = new MemoryCredentialStore();
  const scratch = new PersonalAgentClient({
    baseUrl: url,
    credentials: scratchCreds,
    persistence: new MemoryProjectionStore(),
  });
  await scratch.redeem({
    code: code.trim(),
    deviceLabel: "手机",
    kind: "mobile",
  });
  const saved = await scratchCreds.load();
  if (!saved?.token) throw new Error("配对没有返回设备令牌。");
  await installCredentials(saved, requested);
}

export async function connectWithToken(
  baseUrl: string,
  token: string,
): Promise<void> {
  const url = validateGatewayUrl(baseUrl);
  const requested = ++selection;
  const scratchCreds = new MemoryCredentialStore();
  const probe = new PersonalAgentClient({
    baseUrl: url,
    credentials: scratchCreds,
    persistence: new MemoryProjectionStore(),
  });
  await probe.adoptToken(token);
  const saved = await scratchCreds.load();
  if (!saved?.token) throw new Error("设备令牌未通过验证。");
  await installCredentials(saved, requested);
}

export async function disconnectGateway(): Promise<void> {
  ++selection;
  await inStorageOrder(async () => {
    await secureCredentials.clear();
    replaceClient(null);
    await clearSavedProjection();
  });
}

export function useProjection(): Projection {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => client?.getSnapshot() ?? EMPTY,
    () => client?.getSnapshot() ?? EMPTY,
  );
}

export function startMobileAgent(): () => void {
  void restoreGateway().catch(() => undefined);
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") void syncCurrentGateway().catch(() => undefined);
  });
  return () => subscription.remove();
}

async function syncCurrentGateway(): Promise<void> {
  const current = client;
  if (!current) await restoreGateway();
  else if (current.getSnapshot().connection === "live") await current.resync();
  else if (current.getSnapshot().connection !== "unauthorized") {
    await connectSelectedClient(current);
  }
}

async function restoreGateway(): Promise<void> {
  const requested = selection;
  const restored = await inStorageOrder(async () => {
    if (client || requested !== selection) return null;
    const saved = await secureCredentials.load();
    if (!saved?.token || client || requested !== selection) return null;
    const baseUrl = validateGatewayUrl(saved.baseUrl);
    const next = await createSecureClient({ ...saved, baseUrl });
    if (requested !== selection) return null;
    replaceClient(next);
    return next;
  });
  if (restored) await connectSelectedClient(restored);
}

async function installCredentials(
  saved: SavedCredentials,
  requested: number,
): Promise<void> {
  const next = await inStorageOrder(async () => {
    if (requested !== selection) throw new Error("连接设置已更改，请重试。");
    const replacement = await createSecureClient(saved);
    await clearSavedProjection();
    await secureCredentials.save(completeCredentials(saved));
    replaceClient(replacement);
    return replacement;
  });
  // 临时断网时保留已验证的凭据，SDK 会重连，回到前台也会重试。
  await connectSelectedClient(next).catch(() => undefined);
}

async function createSecureClient(saved: SavedCredentials) {
  const credentials = new MemoryCredentialStore();
  let identity = completeCredentials(saved);
  await credentials.save(identity);
  const next: PersonalAgentClient = new PersonalAgentClient({
    baseUrl: saved.baseUrl,
    credentials,
    persistence: {
      load: () =>
        inStorageOrder(async () => {
          if (client !== next || !identity.userId || !identity.deviceId)
            return null;
          const cached = await secureProjection.load().catch(() => null);
          const self = cached?.projection.self;
          return self?.userId === identity.userId &&
            self.deviceId === identity.deviceId
            ? cached
            : null;
        }),
      save: (value) =>
        inStorageOrder(async () => {
          if (client !== next) return;
          const self = value.projection.self;
          if (
            self &&
            (self.userId !== identity.userId ||
              self.deviceId !== identity.deviceId)
          ) {
            const confirmed = { ...identity, ...self };
            await secureCredentials.save(confirmed);
            identity = confirmed;
          }
          await secureProjection.save(value);
        }).catch(() => undefined),
    },
  });
  return next;
}

function replaceClient(next: PersonalAgentClient | null): void {
  const previous = client;
  stopClientSubscription?.();
  client = next;
  stopClientSubscription = next?.subscribe(emit);
  emit();
  void previous?.forget().catch(() => undefined);
}

async function connectSelectedClient(next: PersonalAgentClient): Promise<void> {
  if (client !== next || connectingClient === next) return;
  connectingClient = next;
  try {
    await next.connect();
  } finally {
    if (connectingClient === next) connectingClient = null;
  }
}

function clearSavedProjection(): Promise<void> {
  return secureProjection.save({
    version: EMPTY.version,
    cursor: null,
    projection: EMPTY,
  });
}

function inStorageOrder<T>(operation: () => Promise<T>): Promise<T> {
  // 切换连接和写入投影共用同一顺序，旧连接无法覆盖新设备的数据。
  const result = storageTail.then(operation);
  storageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function completeCredentials(saved: SavedCredentials) {
  return {
    ...saved,
    deviceId: saved.deviceId ?? "",
    userId: saved.userId ?? "",
  };
}
