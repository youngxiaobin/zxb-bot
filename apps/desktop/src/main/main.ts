import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { CommandSchema, PROTOCOL } from "@pa/contracts";
import {
  MemoryCredentialStore,
  MemoryProjectionStore,
  PersonalAgentClient,
  validateGatewayUrl,
} from "@pa/sdk";

const credentials = new MemoryCredentialStore();
let active = new PersonalAgentClient({
  baseUrl: "http://127.0.0.1:47471",
  credentials,
  persistence: new MemoryProjectionStore(),
});

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
  await credentials.save(saved);
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
      preload: path.join(app.getAppPath(), "dist/preload/preload.js"),
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

app.whenReady().then(async () => {
  await restoreCredentials();
  ipcMain.handle("pa:getSnapshot", () => active.getSnapshot());
  ipcMain.handle("pa:command", async (_event, input: unknown) => {
    const record = input as { type?: string; idempotencyKey?: string };
    const idempotencyKey = record.idempotencyKey ?? crypto.randomUUID();
    const command = CommandSchema.parse({
      protocol: PROTOCOL,
      commandId: idempotencyKey,
      idempotencyKey,
      ...(input as object),
    });
    return active.send(command);
  });
  ipcMain.handle("pa:forget", async () => {
    await active.forget();
    const file = credentialFile();
    if (fs.existsSync(file)) fs.rmSync(file);
  });
  ipcMain.handle("pa:mint", async (_event, baseUrl: string) => {
    const response = await fetch(`${baseUrl}/v1/pairing/mint`, {
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
});

async function replaceClient(
  baseUrl: string,
  setup: (next: PersonalAgentClient) => Promise<void>,
): Promise<void> {
  const url = validateGatewayUrl(baseUrl);
  const scratchCreds = new MemoryCredentialStore();
  const scratch = new PersonalAgentClient({
    baseUrl: url,
    credentials: scratchCreds,
    persistence: new MemoryProjectionStore(),
  });
  try {
    await setup(scratch);
    await scratch.connect();
  } catch (error) {
    await scratch.forget();
    throw error;
  }
  const snap = scratch.getSnapshot();
  if (snap.connection !== "live") {
    const message = snap.lastError?.message ?? "设备令牌无效、过期或已吊销。";
    await scratch.forget();
    throw new Error(message);
  }
  const fresh = await scratchCreds.load();
  await scratch.forget();
  if (!fresh?.token) throw new Error("没有得到设备令牌。");
  await active.forget();
  const file = credentialFile();
  if (fs.existsSync(file)) fs.rmSync(file);
  const next = new PersonalAgentClient({
    baseUrl: url,
    credentials,
    persistence: new MemoryProjectionStore(),
  });
  await next.adoptToken(fresh.token);
  await next.connect();
  active = next;
  const self = next.getSnapshot().self;
  if (self) {
    const full = {
      baseUrl: url,
      token: fresh.token,
      deviceId: self.deviceId,
      userId: self.userId,
    };
    await credentials.save(full);
    saveCredentials(full);
  }
}
