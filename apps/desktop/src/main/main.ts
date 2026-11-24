import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CommandSchema, PROTOCOL } from "@pa/contracts";
import {
  MemoryCredentialStore,
  MemoryProjectionStore,
  PersonalAgentClient,
  validateGatewayUrl,
  type CredentialStore,
  type SocketFactory,
} from "@pa/sdk";
import WebSocket from "ws";

const DEFAULT_GATEWAY = "http://127.0.0.1:47471";
const sockets: SocketFactory = {
  connect(url) {
    const socket = new WebSocket(url);
    // 连接错误之后还会收到 close，由 SDK 统一处理重连。
    socket.on("error", () => {});
    return {
      send: (data) => socket.send(data),
      close: () => socket.close(),
      onOpen: (callback) => socket.on("open", callback),
      onMessage: (callback) =>
        socket.on("message", (data) => callback(String(data))),
      onClose: (callback) => socket.on("close", callback),
    };
  },
};
let active = createClient(DEFAULT_GATEWAY);
let unsubscribeActive = active.subscribe(publishSnapshot);

function credentialFile(): string {
  return path.join(app.getPath("userData"), "credentials.bin");
}

async function restoreCredentials(): Promise<void> {
  const file = credentialFile();
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file);
  const text = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(raw)
    : raw.toString("utf8");
  const saved = JSON.parse(text) as {
    baseUrl: string;
    token: string;
    deviceId: string;
    userId: string;
  };
  const credentials = new MemoryCredentialStore();
  await credentials.save(saved);
  const restored = createClient(validateGatewayUrl(saved.baseUrl), credentials);
  setActive(restored);
  await restored.connect();
}

function saveCredentials(value: {
  baseUrl: string;
  token: string;
  deviceId: string;
  userId: string;
}): void {
  const text = JSON.stringify(value);
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text)
    : Buffer.from(text);
  fs.writeFileSync(credentialFile(), payload, { mode: 0o600 });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist/electron/preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.PA_DESKTOP_DEV_URL ?? "file:";
    if (!url.startsWith(allowed) && !url.startsWith("file:"))
      event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const devUrl = process.env.PA_DESKTOP_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else
    void win.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("pa:getSnapshot", () => active.getSnapshot());
  ipcMain.handle("pa:command", async (_event, input: unknown) => {
    const record = input as { idempotencyKey?: string } | null;
    const idempotencyKey = record?.idempotencyKey ?? randomUUID();
    const command = CommandSchema.parse({
      ...record,
      protocol: PROTOCOL,
      commandId: idempotencyKey,
      idempotencyKey,
    });
    return active.send(command);
  });
  ipcMain.handle("pa:forget", async () => {
    await active.forget();
    const file = credentialFile();
    if (fs.existsSync(file)) fs.rmSync(file);
  });
  ipcMain.handle("pa:mint", async (_event, baseUrl: string) => {
    const url = validateGatewayUrl(baseUrl);
    const response = await fetch(`${url}/v1/pairing/mint`, {
      method: "POST",
    });
    if (!response.ok) throw new Error("只能在网关本机申请配对码");
    return response.json();
  });
  ipcMain.handle(
    "pa:redeem",
    async (
      _event,
      input: { baseUrl: string; code: string; deviceLabel: string },
    ) => {
      await replaceClient(input.baseUrl, async (next) => {
        await next.redeem({
          code: input.code,
          deviceLabel: input.deviceLabel,
          kind: "desktop",
        });
      });
    },
  );
  ipcMain.handle(
    "pa:adopt",
    async (_event, input: { baseUrl: string; token: string }) => {
      await replaceClient(input.baseUrl, async (next) => {
        await next.adoptToken(input.token);
      });
    },
  );
  createWindow();
  void restoreCredentials().catch((error: unknown) => {
    console.error(
      "无法恢复桌面 Gateway 连接",
      error instanceof Error ? error.message : "未知错误",
    );
  });
});

app.on("window-all-closed", () => app.quit());

async function replaceClient(
  baseUrl: string,
  setup: (next: PersonalAgentClient) => Promise<void>,
): Promise<void> {
  const url = validateGatewayUrl(baseUrl);
  const credentials = new MemoryCredentialStore();
  const next = createClient(url, credentials);
  try {
    await setup(next);
    await next.connect();
    const snapshot = next.getSnapshot();
    if (snapshot.connection !== "live" || !snapshot.self) {
      throw new Error(
        snapshot.lastError?.message ?? "设备令牌无效、过期或已吊销。",
      );
    }
    const saved = await credentials.load();
    if (!saved?.token) throw new Error("没有得到设备令牌。");
    const full = { baseUrl: url, token: saved.token, ...snapshot.self };
    await credentials.save(full);
    saveCredentials(full);
  } catch (error) {
    await next.forget();
    throw error;
  }
  const previous = active;
  setActive(next);
  await previous.forget();
}

function createClient(
  baseUrl: string,
  credentials: CredentialStore = new MemoryCredentialStore(),
) {
  return new PersonalAgentClient({
    baseUrl,
    credentials,
    persistence: new MemoryProjectionStore(),
    sockets,
  });
}

function setActive(next: PersonalAgentClient): void {
  unsubscribeActive();
  active = next;
  unsubscribeActive = active.subscribe(publishSnapshot);
  publishSnapshot();
}

function publishSnapshot(): void {
  const snapshot = active.getSnapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send("pa:snapshot", snapshot);
    }
  }
}
