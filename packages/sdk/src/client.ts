import {
  CommandSchema,
  ErrorCodes,
  PROTOCOL,
  PROJECTION_VERSION,
  type Command,
  type CommandReceipt,
  ClientFrameSchema,
  CommandReceiptSchema,
  DurableEventSchema,
  HelloSchema,
  SnapshotSchema,
  SubscribeSchema,
} from "@pa/contracts";
import { emptyProjection, type Projection } from "./projection.js";
import {
  applyEphemeral,
  applyEvent,
  applySnapshot,
  projectionFromStored,
  withConnection,
  withDraft,
} from "./reduce.js";

export interface CredentialStore {
  load(): Promise<{
    baseUrl: string;
    token: string;
    deviceId?: string;
    userId?: string;
  } | null>;
  save(value: {
    baseUrl: string;
    token: string;
    deviceId: string;
    userId: string;
  }): Promise<void>;
  clear(): Promise<void>;
}

export interface ProjectionPersistence {
  load(): Promise<{
    version: number;
    cursor: string | null;
    projection: Projection;
  } | null>;
  save(value: {
    version: number;
    cursor: string | null;
    projection: Projection;
  }): Promise<void>;
}

export interface HttpTransport {
  request(input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }>;
}

export interface AgentSocket {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}

export interface SocketFactory {
  connect(url: string): AgentSocket;
}

export class MemoryCredentialStore implements CredentialStore {
  private value: {
    baseUrl: string;
    token: string;
    deviceId?: string;
    userId?: string;
  } | null = null;
  async load() {
    return this.value;
  }
  async save(value: {
    baseUrl: string;
    token: string;
    deviceId: string;
    userId: string;
  }) {
    this.value = value;
  }
  async clear() {
    this.value = null;
  }
}

export class MemoryProjectionStore implements ProjectionPersistence {
  private value: {
    version: number;
    cursor: string | null;
    projection: Projection;
  } | null = null;
  async load() {
    return this.value;
  }
  async save(value: {
    version: number;
    cursor: string | null;
    projection: Projection;
  }) {
    this.value = value;
  }
}

const fetchTransport: HttpTransport = {
  async request(input) {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
    });
    return { status: response.status, body: await response.text() };
  },
};

function browserSocket(url: string): AgentSocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (cb) => socket.addEventListener("open", () => cb()),
    onMessage: (cb) => {
      socket.addEventListener("message", (event) => cb(String(event.data)));
    },
    onClose: (cb) => socket.addEventListener("close", () => cb()),
  };
}

export class PersonalAgentClient {
  private projection: Projection = emptyProjection();
  private listeners = new Set<() => void>();
  private socket: AgentSocket | null = null;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private persistEpoch = 0;

  constructor(
    private readonly options: {
      baseUrl: string;
      credentials: CredentialStore;
      persistence?: ProjectionPersistence;
      transport?: HttpTransport;
      sockets?: SocketFactory;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Projection => this.projection;

  getBaseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, "");
  }

  async setDraft(sessionId: string, text: string): Promise<void> {
    this.commit(withDraft(this.projection, sessionId, text));
  }

  async redeem(input: {
    code: string;
    deviceLabel: string;
    kind: "cli" | "desktop" | "mobile" | "test";
  }): Promise<void> {
    const response = await this.requestPublic("/v1/pairing/redeem", input);
    const body = response as {
      token: string;
      deviceId: string;
      userId: string;
    };
    await this.options.credentials.save({
      baseUrl: this.getBaseUrl(),
      token: body.token,
      deviceId: body.deviceId,
      userId: body.userId,
    });
  }

  async connect(): Promise<void> {
    this.disposed = false;
    const stored = await this.options.persistence?.load();
    const restored = projectionFromStored(stored);
    if (restored)
      this.commit({
        ...restored,
        connection: "connecting",
        sensitiveReady: false,
      });
    else this.commit(withConnection(this.projection, "connecting"));
    await this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.commit(withConnection(this.projection, "idle"));
  }

  async forget(): Promise<void> {
    this.persistEpoch += 1;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.disconnect();
    await this.options.credentials.clear();
    this.commit(emptyProjection());
    await this.options.persistence?.save({
      version: PROJECTION_VERSION,
      cursor: null,
      projection: emptyProjection(),
    });
  }

  async adoptToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed.length < 8 || /\s/.test(trimmed)) {
      throw new Error("设备令牌格式不正确。");
    }
    await this.options.credentials.save({
      baseUrl: this.getBaseUrl(),
      token: trimmed,
      deviceId: "",
      userId: "",
    });
    const transport = this.options.transport ?? fetchTransport;
    let response: { status: number; body: string };
    try {
      response = await transport.request({
        url: `${this.getBaseUrl()}/v1/snapshot`,
        method: "GET",
        headers: { authorization: `Bearer ${trimmed}` },
      });
    } catch {
      await this.options.credentials.clear();
      throw new Error("无法连接 Gateway。");
    }
    if (response.status === 401) {
      await this.options.credentials.clear();
      throw new Error(readError(response.body));
    }
    if (response.status >= 400) {
      await this.options.credentials.clear();
      throw new Error("无法用这枚设备令牌读取快照。");
    }
  }

  async resync(): Promise<void> {
    const snapshot = SnapshotSchema.parse(await this.request("/v1/snapshot"));
    this.commit(
      applySnapshot(
        { ...this.projection, drafts: this.projection.drafts },
        snapshot,
      ),
    );
    await this.persist();
  }

  async send(command: Command): Promise<CommandReceipt> {
    const sensitive =
      command.type === "approval.decide" || command.type === "run.cancel";
    if (sensitive && this.projection.connection !== "live") {
      throw Object.assign(new Error("离线时不能审批或取消，请求不会排队。"), {
        code: ErrorCodes.OFFLINE,
      });
    }
    const body = JSON.stringify(command);
    let response: { status: number; body: string };
    try {
      response = await this.authorized(body);
    } catch {
      response = await this.authorized(body);
    }
    const parsed = JSON.parse(response.body) as {
      error?: { code: string; message: string };
    };
    if (response.status >= 400) {
      throw Object.assign(new Error(parsed.error?.message ?? "命令失败"), {
        code: parsed.error?.code ?? "MALFORMED",
        status: response.status,
      });
    }
    return CommandReceiptSchema.parse(JSON.parse(response.body));
  }

  async openSession(
    title?: string,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<CommandReceipt> {
    return this.send(
      command("session.open", idempotencyKey, title ? { title } : {}),
    );
  }

  async resumeSession(
    sessionId: string,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<CommandReceipt> {
    const receipt = await this.send(
      command("session.resume", idempotencyKey, { sessionId }),
    );
    await this.resync();
    return receipt;
  }

  async submit(input: {
    sessionId: string;
    text: string;
    providerMode: "demo" | "live";
    idempotencyKey?: string;
    commandId?: string;
  }): Promise<CommandReceipt> {
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    const commandId = input.commandId ?? idempotencyKey;
    return this.send({
      protocol: PROTOCOL,
      commandId,
      idempotencyKey,
      type: "message.submit",
      payload: {
        sessionId: input.sessionId,
        text: input.text,
        providerMode: input.providerMode,
      },
    });
  }

  async decide(input: {
    approvalId: string;
    decision: "approve" | "reject";
    expectedVersion: number;
    paramsHash: string;
    idempotencyKey?: string;
  }): Promise<CommandReceipt> {
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    return this.send({
      protocol: PROTOCOL,
      commandId: idempotencyKey,
      idempotencyKey,
      type: "approval.decide",
      payload: {
        approvalId: input.approvalId,
        decision: input.decision,
        expectedVersion: input.expectedVersion,
        paramsHash: input.paramsHash,
      },
    });
  }

  async cancel(
    runId: string,
    idempotencyKey = crypto.randomUUID(),
  ): Promise<CommandReceipt> {
    return this.send(command("run.cancel", idempotencyKey, { runId }));
  }

  async waitFor(
    predicate: (projection: Projection) => boolean,
    timeoutMs = 8000,
  ): Promise<Projection> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate(this.projection)) return this.projection;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("等待投影超时");
  }

  private async authorized(body: string) {
    const creds = await this.options.credentials.load();
    if (!creds?.token)
      throw Object.assign(new Error("尚未配对"), {
        code: ErrorCodes.UNAUTHORIZED,
      });
    const transport = this.options.transport ?? fetchTransport;
    return transport.request({
      url: `${this.getBaseUrl()}/v1/commands`,
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.token}`,
        "content-type": "application/json",
      },
      body,
    });
  }

  private async request(pathname: string): Promise<unknown> {
    const creds = await this.options.credentials.load();
    if (!creds?.token)
      throw Object.assign(new Error("尚未配对"), {
        code: ErrorCodes.UNAUTHORIZED,
      });
    const transport = this.options.transport ?? fetchTransport;
    const response = await transport.request({
      url: `${this.getBaseUrl()}${pathname}`,
      method: "GET",
      headers: { authorization: `Bearer ${creds.token}` },
    });
    return JSON.parse(response.body);
  }

  private async requestPublic(
    pathname: string,
    body: unknown,
  ): Promise<unknown> {
    const transport = this.options.transport ?? fetchTransport;
    const response = await transport.request({
      url: `${this.getBaseUrl()}${pathname}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status >= 400) {
      const parsed = JSON.parse(response.body) as {
        error?: { message?: string };
      };
      throw new Error(parsed.error?.message ?? "请求失败");
    }
    return JSON.parse(response.body);
  }

  private async openSocket(): Promise<void> {
    const creds = await this.options.credentials.load();
    if (!creds?.token) {
      this.commit(withConnection(this.projection, "unauthorized"));
      return;
    }
    const url = `${this.getBaseUrl().replace(/^http/, "ws")}/v1/ws`;
    const factory = this.options.sockets ?? { connect: browserSocket };
    const socket = factory.connect(url);
    this.socket = socket;
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接超时")), 5000);
      const stop = this.subscribe(() => {
        if (
          this.projection.connection === "live" ||
          this.projection.connection === "unauthorized"
        ) {
          clearTimeout(timer);
          stop();
          resolve();
        }
      });
    });
    socket.onMessage((data) => this.onFrame(data));
    socket.onClose(() => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.disposed) return;
      this.commit(withConnection(this.projection, "reconnecting"));
      this.scheduleReconnect();
    });
    socket.onOpen(() => {
      socket.send(
        JSON.stringify(
          HelloSchema.parse({
            type: "hello",
            protocol: "pa.ws.v1",
            token: creds.token,
          }),
        ),
      );
    });
    await opened;
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const delay = Math.min(3000, 200 * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      void this.openSocket().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private onFrame(data: string): void {
    if (this.disposed) return;
    const frame = ClientFrameSchema.parse(JSON.parse(data));
    if (frame.type === "ping") {
      this.socket?.send(JSON.stringify({ type: "pong", nonce: frame.nonce }));
      return;
    }
    if (frame.type === "hello.ok") {
      this.commit({
        ...this.projection,
        self: { userId: frame.userId, deviceId: frame.deviceId },
      });
      const cursor = this.projection.cursor;
      this.socket?.send(
        JSON.stringify(SubscribeSchema.parse({ type: "subscribe", cursor })),
      );
      return;
    }
    if (frame.type === "hello.error") {
      this.commit({
        ...withConnection(this.projection, "unauthorized"),
        lastError: { code: frame.code, message: frame.message },
      });
      return;
    }
    if (frame.type === "snapshot") {
      this.commit(
        withConnection(applySnapshot(this.projection, frame.snapshot), "live"),
      );
      this.attempt = 0;
      void this.persist();
      return;
    }
    if (frame.type === "event") {
      const event = DurableEventSchema.parse(frame.event);
      this.commit(withConnection(applyEvent(this.projection, event), "live"));
      void this.persist();
      if (this.projection.lastError?.code === "PROJECTION_CAP")
        void this.resync();
      return;
    }
    if (frame.type === "ephemeral") {
      this.commit(
        applyEphemeral(
          this.projection,
          frame.ephemeral.runId,
          frame.ephemeral.text,
        ),
      );
      return;
    }
    if (frame.type === "subscribed") {
      const cursor = frame.watermarkCursor ?? this.projection.cursor;
      this.commit(withConnection({ ...this.projection, cursor }, "live"));
      this.attempt = 0;
      void this.persist();
      return;
    }
    if (frame.type === "error") {
      this.commit({
        ...this.projection,
        lastError: { code: frame.code, message: frame.message },
      });
      if (
        frame.code === "CURSOR_EXPIRED" ||
        frame.code === "CURSOR_FUTURE" ||
        frame.code === "CURSOR_MALFORMED"
      ) {
        void this.resync();
      }
    }
  }

  private commit(next: Projection): void {
    if (next === this.projection) return;
    this.projection = next;
    for (const listener of this.listeners) listener();
  }

  private async persist(): Promise<void> {
    if (!this.options.persistence) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    const epoch = this.persistEpoch;
    this.persistTimer = setTimeout(() => {
      if (epoch !== this.persistEpoch) return;
      void this.options.persistence?.save({
        version: PROJECTION_VERSION,
        cursor: this.projection.cursor,
        projection: {
          ...this.projection,
          ephemeralByRun: {},
          connection: "idle",
          sensitiveReady: false,
        },
      });
    }, 30);
  }
}

function readError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // 响应不是 JSON 时使用固定说明，避免把凭据写进错误文本。
  }
  return "设备令牌无效、过期或已吊销。";
}

function command(
  type: "session.open" | "session.resume" | "run.cancel",
  idempotencyKey: string,
  payload: Record<string, unknown>,
): Command {
  return CommandSchema.parse({
    protocol: PROTOCOL,
    commandId: idempotencyKey,
    idempotencyKey,
    type,
    payload,
  });
}

export type { Projection };
