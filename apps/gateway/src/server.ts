import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  PROTOCOL,
  CommandSchema,
  ErrorCodes,
  FaultNameSchema,
  HelloSchema,
  PongSchema,
  SnapshotSchema,
  SubscribeSchema,
  WS_PROTOCOL,
  httpStatusForCode,
  isOwnerVisibleEvent,
  type DurableEvent,
  type EphemeralPreview,
} from "@pa/contracts";
import {
  AppStore,
  DomainError,
  isDomainError,
  signCursor,
} from "@pa/persistence";
import { AgentRuntime, redactValue } from "@pa/runtime";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { z } from "zod";
import { assertBindPolicy, healthBody, type GatewayConfig } from "./config.js";

export type GatewayHandle = {
  baseUrl: string;
  port: number;
  config: GatewayConfig;
  store: AppStore;
  runtime: AgentRuntime;
  stop: () => Promise<void>;
};

const limitsSchema = z.object({
  name: FaultNameSchema,
  delayMs: z.number().int().nonnegative().optional(),
  replayDelayMs: z.number().int().nonnegative().optional(),
});

const socketFrameSchema = z.union([HelloSchema, SubscribeSchema, PongSchema]);

export async function startGateway(
  config: GatewayConfig,
): Promise<GatewayHandle> {
  assertBindPolicy(config.host, config.allowUnsafeLan);
  const secrets = [config.openaiApiKey].filter((value) => value.length >= 8);
  const store = new AppStore(config.dataDir, {
    cursorTtlMs: config.cursorTtlMs,
  });
  store.acquire("personal-agent-gateway", process.pid);
  store.bootstrapOwner();
  const runtime = new AgentRuntime({
    store,
    fixturesDir: config.fixturesDir,
    dataDir: config.dataDir,
    approvalTtlMs: config.approvalTtlMs,
    toolTimeoutMs: config.toolTimeoutMs,
    openai: config.openaiApiKey
      ? {
          apiKey: config.openaiApiKey,
          baseUrl: config.openaiBaseUrl || undefined,
          model: config.openaiModel,
        }
      : null,
    secrets,
  });
  const sockets = new Set<(event: DurableEvent) => void>();
  const previews = new Set<(frame: EphemeralPreview) => void>();
  const socketAuthorizations = new Set<() => boolean>();
  const publish = (events: DurableEvent[]) => {
    for (const event of events) {
      if (event.type === "device.revoked") {
        for (const check of socketAuthorizations) check();
      }
      const scrubbed = {
        ...event,
        payload: redactValue(event.payload, secrets) as Record<string, unknown>,
      };
      for (const socket of sockets) socket(scrubbed);
    }
  };
  runtime.onEvent((event) => publish([event]));
  runtime.onEphemeral((frame) => {
    for (const listener of previews) listener(frame);
  });
  await runtime.startup();
  const sweep = setInterval(() => {
    try {
      if (!store.heartbeat()) return;
      for (const check of socketAuthorizations) check();
      publish(store.expireApprovals());
    } catch (error) {
      log(
        "sweep failed",
        { message: error instanceof Error ? error.message : "unknown" },
        secrets,
      );
    }
  }, config.sweepMs);
  sweep.unref?.();

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      sendError(res, error, secrets);
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      pathname = url.pathname;
      if (
        [...url.searchParams.keys()].some(
          (key) => key === "token" || key === "access_token",
        )
      ) {
        log("rejected websocket query credential", { path: pathname }, secrets);
        socket.write(
          "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      if (pathname !== "/v1/ws") {
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => acceptSocket(ws));
  });

  await new Promise<void>((resolve) =>
    server.listen(config.port, config.host, resolve),
  );
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : config.port;
  const baseUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${port}`;

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    applyCors(req, res, config);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.has("token") || url.searchParams.has("access_token")) {
      sendJson(res, 400, {
        error: {
          code: ErrorCodes.TOKEN_QUERY_FORBIDDEN,
          message: "不要把令牌放在查询字符串里。",
        },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/health") {
      sendJson(res, 200, healthBody(config));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/pairing/mint") {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, {
          error: {
            code: ErrorCodes.LOOPBACK_ONLY,
            message: "配对码只能在网关本机签发。",
          },
        });
        return;
      }
      sendJson(res, 200, store.mintPairing(config.pairingTtlMs));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/pairing/redeem") {
      const body = z
        .object({
          code: z.string().min(4),
          deviceLabel: z.string().min(1).max(80),
          kind: z.enum(["cli", "desktop", "mobile", "test"]),
        })
        .parse(await readBody(req));
      const redeemed = store.redeemPairing(
        body.code,
        body.deviceLabel,
        body.kind,
        config.deviceTokenTtlMs,
      );
      sendJson(res, 200, redeemed);
      return;
    }
    if (url.pathname.startsWith("/v1/test/")) {
      if (!config.testHooks) {
        sendJson(res, 404, {
          error: {
            code: ErrorCodes.TEST_HOOKS_DISABLED,
            message: "测试钩子未开启。",
          },
        });
        return;
      }
      await handleTest(req, res, url);
      return;
    }
    const auth = authenticate(req);
    if (!auth) {
      sendJson(res, 401, {
        error: {
          code: ErrorCodes.UNAUTHORIZED,
          message: "设备令牌无效、过期或已吊销。",
        },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/snapshot") {
      sendJson(res, 200, SnapshotSchema.parse(store.snapshot(auth)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/events") {
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        sendJson(res, 400, {
          error: {
            code: ErrorCodes.CURSOR_MALFORMED,
            message: "缺少游标。全量状态请读取 snapshot。",
          },
        });
        return;
      }
      const checked = store.checkCursor(cursor, auth.userId);
      if (!checked.ok) {
        sendJson(res, httpStatusForCode(checked.code), {
          error: { code: checked.code, message: cursorMessage(checked.code) },
        });
        return;
      }
      sendJson(res, 200, store.replay(auth, checked.claims.seq));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/commands") {
      const parsed = CommandSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        sendJson(res, 400, {
          error: { code: ErrorCodes.MALFORMED, message: "命令格式不正确。" },
        });
        return;
      }
      if (
        parsed.data.type === "message.submit" &&
        parsed.data.payload.providerMode === "live" &&
        !config.openaiApiKey
      ) {
        sendJson(res, 409, {
          error: {
            code: ErrorCodes.PROVIDER_NOT_CONFIGURED,
            message: "未配置实况模型，没有改用演示提供方。",
          },
        });
        return;
      }
      const outcome = store.handleCommand(auth, parsed.data, {
        toolBudget: config.toolBudget,
        maxModelSteps: config.maxModelSteps,
        executionBudgetMs: config.executionBudgetMs,
        approvalTtlMs: config.approvalTtlMs,
      });
      publish(outcome.events);
      if (
        runtime.faults.shouldExitAfterApproval() &&
        outcome.kickRunId &&
        !outcome.replayed
      ) {
        process.kill(process.pid, "SIGKILL");
      }
      if (outcome.kickRunId) await runtime.kick(outcome.kickRunId);
      if (runtime.faults.dropResponses > 0) {
        runtime.faults.dropResponses -= 1;
        res.destroy();
        return;
      }
      sendJson(res, outcome.httpStatus, {
        protocol: PROTOCOL,
        commandId: parsed.data.commandId,
        idempotencyKey: parsed.data.idempotencyKey,
        replayed: outcome.replayed,
        result: outcome.body,
      });
      return;
    }
    sendJson(res, 404, {
      error: { code: ErrorCodes.NOT_FOUND, message: "没有这个接口。" },
    });
  }

  async function handleTest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method === "GET" && url.pathname === "/v1/test/summary") {
      sendJson(res, 200, store.summary());
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/test/fault") {
      const body = limitsSchema.parse(await readBody(req));
      runtime.faults.set(body.name, {
        delayMs: body.delayMs,
        replayDelayMs: body.replayDelayMs,
      });
      sendJson(res, 200, { ok: true, name: body.name });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/test/release") {
      runtime.faults.release();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/test/reload") {
      await runtime.reload();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/v1/test/isolated-principal"
    ) {
      const body = z
        .object({ label: z.string().min(1).max(80).default("隔离主体") })
        .parse(await readBody(req));
      sendJson(
        res,
        200,
        store.issueIsolatedPrincipal(body.label, config.deviceTokenTtlMs),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/test/sign-cursor") {
      const body = z
        .object({
          seq: z.number().int(),
          principalId: z.string(),
          exp: z.number().int(),
          epoch: z.string().optional(),
        })
        .parse(await readBody(req));
      const cursor = signCursor(
        {
          v: 1,
          epoch: body.epoch ?? store.epoch(),
          seq: body.seq,
          principalId: body.principalId,
          exp: body.exp,
        },
        store.cursorSecret(),
      );
      sendJson(res, 200, { cursor });
      return;
    }
    sendJson(res, 404, {
      error: { code: ErrorCodes.NOT_FOUND, message: "没有这个测试钩子。" },
    });
  }

  function authenticate(req: IncomingMessage) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return null;
    return store.authenticate(token);
  }

  function acceptSocket(ws: WebSocket): void {
    let auth: ReturnType<AppStore["authenticate"]> = null;
    let unsubscribe: (() => void) | null = null;
    const timer = setInterval(() => {
      send({ type: "ping", nonce: String(Date.now()) });
    }, 10_000);
    timer.unref?.();
    ws.on("message", (raw) => {
      void handleFrame(raw).catch((error: unknown) => {
        log(
          "websocket frame failed",
          { message: error instanceof Error ? error.message : "unknown" },
          secrets,
        );
        disconnect();
        ws.close(1011, "Internal error");
      });
    });
    ws.on("error", () => {
      disconnect();
      ws.terminate();
    });
    ws.on("close", disconnect);

    async function handleFrame(raw: RawData): Promise<void> {
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        send({
          type: "error",
          code: ErrorCodes.MALFORMED,
          message: "无法解析消息。",
        });
        return;
      }
      const parsed = socketFrameSchema.safeParse(message);
      if (!parsed.success) {
        send({
          type: "error",
          code: ErrorCodes.MALFORMED,
          message: "消息格式不正确。",
        });
        return;
      }
      const record = parsed.data;
      if (!auth) {
        if (record.type !== "hello") return rejectAuth("请先发送 hello。");
        auth = store.authenticate(record.token);
        if (!auth) return rejectAuth();
        socketAuthorizations.add(isAuthorized);
        send({
          type: "hello.ok",
          protocol: WS_PROTOCOL,
          deviceId: auth.deviceId,
          userId: auth.userId,
        });
        return;
      }
      if (!isAuthorized()) return;
      if (record.type === "pong") return;
      if (record.type !== "subscribe" || unsubscribe) {
        send({
          type: "error",
          code: ErrorCodes.MALFORMED,
          message: "该消息不适用于当前连接状态。",
        });
        return;
      }
      const current = auth;
      const checked = record.cursor
        ? store.checkCursor(record.cursor, current.userId)
        : null;
      if (checked && !checked.ok) {
        send({
          type: "error",
          code: checked.code,
          message: cursorMessage(checked.code),
        });
        return;
      }
      const buffered: DurableEvent[] = [];
      let live = false;
      const hasSessionGrant = (sessionId: string) =>
        Boolean(
          store.db
            .prepare(
              "SELECT 1 FROM session_grants WHERE session_id=? AND device_id=? AND user_id=?",
            )
            .get(sessionId, current.deviceId, current.userId),
        );
      const fan = (event: DurableEvent) => {
        if (event.userId !== current.userId || !isAuthorized()) return;
        if (
          !isOwnerVisibleEvent(event.type) &&
          (!event.sessionId || !hasSessionGrant(event.sessionId))
        ) {
          return;
        }
        if (live) send({ type: "event", event });
        else buffered.push(event);
      };
      sockets.add(fan);
      const previewFan = (frame: EphemeralPreview) => {
        if (!isAuthorized()) return;
        const run = store.getRun(frame.runId);
        if (run && hasSessionGrant(String(run.session_id))) {
          send({ type: "ephemeral", ephemeral: frame });
        }
      };
      previews.add(previewFan);
      unsubscribe = () => {
        sockets.delete(fan);
        previews.delete(previewFan);
      };
      await runtime.faults.delayReplay();
      if (!isAuthorized()) return;
      let watermarkSeq: number;
      let watermarkCursor: string | null;
      let replayed = 0;
      if (checked) {
        const replay = store.replay(current, checked.claims.seq);
        watermarkSeq = replay.watermarkSeq;
        watermarkCursor = replay.watermarkCursor;
        replayed = replay.events.length;
        for (const event of replay.events) send({ type: "event", event });
      } else {
        const snapshot = store.snapshot(current);
        watermarkSeq = snapshot.watermarkSeq;
        watermarkCursor = snapshot.watermarkCursor;
        send({ type: "snapshot", snapshot });
      }
      live = true;
      for (const event of buffered) {
        if (event.seq > watermarkSeq) fan(event);
      }
      buffered.length = 0;
      send({ type: "subscribed", watermarkCursor, replayed });
    }

    function send(frame: Record<string, unknown>): void {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    }

    function isAuthorized(): boolean {
      if (!auth || ws.readyState !== ws.OPEN) return false;
      if (store.isActiveDevice(auth)) return true;
      rejectAuth();
      return false;
    }

    function rejectAuth(message = "设备令牌无效、过期或已吊销。"): void {
      send({ type: "hello.error", code: ErrorCodes.UNAUTHORIZED, message });
      disconnect();
      ws.close(1008, "Unauthorized");
    }

    function disconnect(): void {
      clearInterval(timer);
      socketAuthorizations.delete(isAuthorized);
      unsubscribe?.();
      unsubscribe = null;
      auth = null;
    }
  }

  return {
    baseUrl,
    port,
    config,
    store,
    runtime,
    async stop() {
      clearInterval(sweep);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.close();
      store.close();
    },
  };
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): void {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigin(origin, config.corsOrigin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function allowedOrigin(origin: string, configured: string): boolean {
  if (origin === configured) return true;
  try {
    const url = new URL(origin);
    return (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000)
      throw new DomainError(ErrorCodes.MALFORMED, "请求体过大。");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  error: unknown,
  secrets: string[],
): void {
  if (isDomainError(error)) {
    sendJson(res, httpStatusForCode(error.code), {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof z.ZodError) {
    sendJson(res, 400, {
      error: { code: ErrorCodes.MALFORMED, message: "请求格式不正确。" },
    });
    return;
  }
  if (error instanceof SyntaxError) {
    sendJson(res, 400, {
      error: { code: ErrorCodes.MALFORMED, message: "JSON 无法解析。" },
    });
    return;
  }
  log(
    "request failed",
    { message: error instanceof Error ? error.message : "unknown" },
    secrets,
  );
  if (!res.headersSent) {
    sendJson(res, 500, {
      error: { code: "INTERNAL", message: "网关内部错误。" },
    });
  }
}

function cursorMessage(code: string): string {
  switch (code) {
    case ErrorCodes.CURSOR_FUTURE:
      return "游标超前于当前日志。";
    case ErrorCodes.CURSOR_EXPIRED:
      return "游标已过期。请重新读取快照。";
    case ErrorCodes.CURSOR_UNAUTHORIZED:
      return "游标不属于当前身份。";
    default:
      return "游标无法识别。";
  }
}

function log(
  message: string,
  fields: Record<string, unknown>,
  secrets: string[],
): void {
  const payload = redactValue({ msg: message, ...fields }, secrets);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
