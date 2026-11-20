import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CHECKPOINT_COMPAT,
  EVENT_PROTOCOL,
  WORKFLOW_VERSION,
  type ApprovalView,
  type Command,
  type DurableEvent,
  type MessageView,
  type OutcomeView,
  type RunView,
  type SessionView,
  type Snapshot,
  type SpecialistView,
  type ToolView,
  isOwnerVisibleEvent,
} from "@pa/contracts";
import type Database from "better-sqlite3";
import { signCursor, verifyCursor, type CursorCheck } from "./cursor.js";
import { DomainError } from "./errors.js";
import { commandPayloadHash } from "./hash.js";
import {
  MIGRATION_NAME,
  MIGRATION_SQL,
  MIGRATION_VERSION,
  migrationChecksum,
} from "./migrations.js";
import { openAppDatabase, pidAlive } from "./open.js";

type SqlRow = Record<string, unknown>;

export type AuthContext = {
  userId: string;
  deviceId: string;
  channelId: string;
  kind: string;
};

export type Limits = {
  toolBudget: number;
  maxModelSteps: number;
  executionBudgetMs: number;
  approvalTtlMs: number;
};

export type CommandOutcome = {
  httpStatus: number;
  body: unknown;
  events: DurableEvent[];
  kickRunId: string | null;
  replayed: boolean;
};

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newId(): string {
  return randomUUID();
}

export class AppStore {
  readonly db: Database.Database;
  fenceToken = 0;
  private cursorTtlMs: number;

  constructor(
    readonly dataDir: string,
    options: { cursorTtlMs: number },
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "sandbox", "notes"), { recursive: true });
    this.db = openAppDatabase(path.join(dataDir, "app.sqlite"));
    this.cursorTtlMs = options.cursorTtlMs;
    this.migrate();
  }

  migrate(): void {
    const existing = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    if (!existing) {
      this.db.exec(MIGRATION_SQL);
      this.db
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(MIGRATION_VERSION, MIGRATION_NAME, migrationChecksum(), nowIso());
      this.db.pragma(`user_version = ${MIGRATION_VERSION}`);
    } else {
      const row = this.db
        .prepare(
          "SELECT version, checksum FROM schema_migrations WHERE version=?",
        )
        .get(MIGRATION_VERSION) as
        | { version: number; checksum: string }
        | undefined;
      if (!row || row.checksum !== migrationChecksum()) {
        throw new DomainError(
          "SCHEMA_MISMATCH",
          "数据库迁移校验和不匹配。不会自动改写已有库。",
        );
      }
    }
    const fk = this.db.pragma("foreign_key_check") as unknown[];
    if (fk.length > 0) {
      throw new DomainError("FOREIGN_KEY_CHECK", "foreign_key_check 未通过");
    }
    const journal = this.db.pragma("journal_mode", { simple: true });
    if (String(journal).toLowerCase() !== "wal") {
      throw new DomainError("SQLITE_MODE", "未能启用 WAL");
    }
    this.ensureMeta();
    const workflow = this.meta("workflow_version");
    const compat = this.meta("checkpoint_compat");
    if (workflow !== WORKFLOW_VERSION || compat !== CHECKPOINT_COMPAT) {
      throw new DomainError(
        "WORKFLOW_MISMATCH",
        `工作流或检查点兼容版本不匹配（库 ${workflow}/${compat}，代码 ${WORKFLOW_VERSION}/${CHECKPOINT_COMPAT}）。没有自动恢复。`,
      );
    }
  }

  private ensureMeta(): void {
    const set = (key: string, value: string) => {
      const current = this.meta(key);
      if (!current) {
        this.db
          .prepare("INSERT INTO meta(key, value) VALUES (?, ?)")
          .run(key, value);
      }
    };
    set("epoch", newId());
    set("cursor_secret", randomBytes(32).toString("base64url"));
    set("workflow_version", WORKFLOW_VERSION);
    set("checkpoint_compat", CHECKPOINT_COMPAT);
    set("schema_version", "1");
  }

  meta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  epoch(): string {
    return this.meta("epoch") ?? "";
  }

  cursorSecret(): string {
    return this.meta("cursor_secret") ?? "";
  }

  transaction<T>(fn: () => T): T {
    const token = this.fenceToken;
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT fencing_token FROM executor_lock WHERE id=1")
        .get() as { fencing_token: number } | undefined;
      if (!row || row.fencing_token !== token) {
        throw new DomainError(
          "FENCE_LOST",
          "执行器租约已失效，本进程停止写入。",
        );
      }
      return fn();
    })();
  }

  acquire(ownerId: string, pid: number): void {
    const token = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT fencing_token, pid FROM executor_lock WHERE id=1")
        .get() as { fencing_token: number; pid: number } | undefined;
      if (row && pidAlive(row.pid)) {
        throw new DomainError(
          "EXECUTOR_BUSY",
          "已有活动的网关执行器持有锁。本设计只支持单执行器。",
        );
      }
      const next = (row?.fencing_token ?? 0) + 1;
      if (!row) {
        this.db
          .prepare(
            "INSERT INTO executor_lock(id, fencing_token, owner_id, pid, heartbeat_at) VALUES (1, ?, ?, ?, ?)",
          )
          .run(next, ownerId, pid, nowIso());
      } else {
        this.db
          .prepare(
            "UPDATE executor_lock SET fencing_token=?, owner_id=?, pid=?, heartbeat_at=? WHERE id=1",
          )
          .run(next, ownerId, pid, nowIso());
      }
      return next;
    })();
    this.fenceToken = token;
  }

  release(): void {
    if (!this.fenceToken) return;
    this.db
      .prepare(
        "UPDATE executor_lock SET pid=0, heartbeat_at=? WHERE id=1 AND fencing_token=?",
      )
      .run(new Date(0).toISOString(), this.fenceToken);
    this.fenceToken = 0;
  }

  heartbeat(): boolean {
    const info = this.db
      .prepare(
        "UPDATE executor_lock SET heartbeat_at=? WHERE id=1 AND fencing_token=?",
      )
      .run(nowIso(), this.fenceToken);
    return info.changes === 1;
  }

  close(): void {
    this.release();
    this.db.close();
  }

  bootstrapOwner(): string {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM users LIMIT 1").get() as
        | { id: string }
        | undefined;
      if (existing) return existing.id;
      const id = newId();
      this.db
        .prepare(
          "INSERT INTO users(id, display_name, created_at) VALUES (?, ?, ?)",
        )
        .run(id, "所有者", nowIso());
      return id;
    });
  }

  mintPairing(ttlMs: number): { code: string; expiresAt: string } {
    return this.transaction(() => {
      const user = this.db.prepare("SELECT id FROM users LIMIT 1").get() as {
        id: string;
      };
      const code = Array.from(
        randomBytes(8),
        (byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length],
      ).join("");
      const expiresAt = nowIso(Date.now() + ttlMs);
      this.db
        .prepare(
          "INSERT INTO pairing_grants(id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(newId(), user.id, sha256(code), nowIso(), expiresAt);
      return { code, expiresAt };
    });
  }

  redeemPairing(
    code: string,
    label: string,
    kind: string,
    tokenTtlMs: number,
  ): {
    token: string;
    deviceId: string;
    userId: string;
    channelId: string;
    expiresAt: string;
  } {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM pairing_grants WHERE code_hash=?")
        .get(sha256(code)) as SqlRow | undefined;
      if (!row) throw new DomainError("PAIRING_INVALID", "配对码无效。");
      if (row.consumed_at)
        throw new DomainError("PAIRING_CONSUMED", "配对码已使用。");
      if (String(row.expires_at) <= nowIso())
        throw new DomainError("PAIRING_EXPIRED", "配对码已过期。");
      const userId = String(row.user_id);
      const deviceId = newId();
      const channelId = newId();
      const token = randomBytes(32).toString("base64url");
      const expiresAt = nowIso(Date.now() + tokenTtlMs);
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO devices(id, user_id, label, kind, token_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deviceId,
          userId,
          label.slice(0, 80),
          kind,
          sha256(token),
          createdAt,
          expiresAt,
        );
      this.db
        .prepare(
          "INSERT INTO channels(id, user_id, device_id, kind, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(channelId, userId, deviceId, kind, createdAt);
      this.db
        .prepare(
          "UPDATE pairing_grants SET consumed_at=?, consumed_by_device_id=? WHERE id=? AND consumed_at IS NULL",
        )
        .run(createdAt, deviceId, row.id);
      return { token, deviceId, userId, channelId, expiresAt };
    });
  }

  issueIsolatedPrincipal(
    label: string,
    tokenTtlMs: number,
  ): { token: string; userId: string; deviceId: string; channelId: string } {
    return this.transaction(() => {
      const userId = newId();
      const deviceId = newId();
      const channelId = newId();
      const token = randomBytes(32).toString("base64url");
      const createdAt = nowIso();
      this.db
        .prepare(
          "INSERT INTO users(id, display_name, created_at) VALUES (?, ?, ?)",
        )
        .run(userId, label.slice(0, 80), createdAt);
      this.db
        .prepare(
          `INSERT INTO devices(id, user_id, label, kind, token_hash, created_at, expires_at)
           VALUES (?, ?, ?, 'test', ?, ?, ?)`,
        )
        .run(
          deviceId,
          userId,
          label.slice(0, 80),
          sha256(token),
          createdAt,
          nowIso(Date.now() + tokenTtlMs),
        );
      this.db
        .prepare(
          "INSERT INTO channels(id, user_id, device_id, kind, created_at) VALUES (?, ?, ?, 'test', ?)",
        )
        .run(channelId, userId, deviceId, createdAt);
      return { token, userId, deviceId, channelId };
    });
  }

  authenticate(token: string): AuthContext | null {
    const row = this.db
      .prepare(
        `SELECT d.id as device_id, d.user_id, d.expires_at, d.revoked_at, c.id as channel_id, d.kind
         FROM devices d JOIN channels c ON c.device_id=d.id WHERE d.token_hash=?`,
      )
      .get(sha256(token)) as SqlRow | undefined;
    if (!row || row.revoked_at) return null;
    if (String(row.expires_at) <= nowIso()) return null;
    return {
      userId: String(row.user_id),
      deviceId: String(row.device_id),
      channelId: String(row.channel_id),
      kind: String(row.kind),
    };
  }

  handleCommand(
    auth: AuthContext,
    command: Command,
    limits: Limits,
  ): CommandOutcome {
    try {
      return this.transaction(() => {
        const hash = commandPayloadHash(command);
        const existing = this.db
          .prepare(
            "SELECT * FROM command_receipts WHERE user_id=? AND idempotency_key=?",
          )
          .get(auth.userId, command.idempotencyKey) as SqlRow | undefined;
        if (existing) {
          if (String(existing.payload_hash) !== hash) {
            throw new DomainError(
              "PAYLOAD_CONFLICT",
              "同一幂等键对应了不同的命令内容。",
            );
          }
          return {
            httpStatus: Number(existing.http_status),
            body: JSON.parse(String(existing.response_json)),
            events: [],
            kickRunId: null,
            replayed: true,
          };
        }
        const produced = this.applyCommand(auth, command, limits);
        this.db
          .prepare(
            `INSERT INTO command_receipts(user_id, idempotency_key, command_id, payload_hash, http_status, response_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            auth.userId,
            command.idempotencyKey,
            command.commandId,
            hash,
            produced.httpStatus,
            JSON.stringify(produced.body),
            nowIso(),
          );
        return produced;
      });
    } catch (error) {
      const coded = error as { code?: string };
      if (
        coded.code !== "SQLITE_CONSTRAINT_PRIMARYKEY" &&
        coded.code !== "SQLITE_CONSTRAINT"
      )
        throw error;
      const hash = commandPayloadHash(command);
      const existing = this.db
        .prepare(
          "SELECT * FROM command_receipts WHERE user_id=? AND idempotency_key=?",
        )
        .get(auth.userId, command.idempotencyKey) as SqlRow | undefined;
      if (!existing) throw error;
      if (String(existing.payload_hash) !== hash) {
        throw new DomainError(
          "PAYLOAD_CONFLICT",
          "同一幂等键对应了不同的命令内容。",
        );
      }
      return {
        httpStatus: Number(existing.http_status),
        body: JSON.parse(String(existing.response_json)),
        events: [],
        kickRunId: null,
        replayed: true,
      };
    }
  }

  private applyCommand(
    auth: AuthContext,
    command: Command,
    limits: Limits,
  ): CommandOutcome {
    switch (command.type) {
      case "session.open":
        return this.openSession(auth, command.payload.title);
      case "session.resume":
        return this.resumeSession(auth, command.payload.sessionId);
      case "message.submit":
        return this.submitMessage(auth, command.payload, limits);
      case "run.cancel":
        return this.cancelRun(auth, command.payload.runId);
      case "approval.decide":
        return this.resolveApproval(auth, command.payload);
      case "device.revoke":
        return this.revokeDevice(auth, command.payload.deviceId);
      default:
        throw new DomainError("MALFORMED", "未知命令。");
    }
  }

  private openSession(
    auth: AuthContext,
    title: string | undefined,
  ): CommandOutcome {
    const id = newId();
    const createdAt = nowIso();
    const sessionTitle = title?.trim() || "未命名会话";
    this.db
      .prepare(
        "INSERT INTO sessions(id, user_id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, auth.userId, auth.channelId, sessionTitle, createdAt, createdAt);
    this.db
      .prepare(
        "INSERT INTO session_grants(session_id, user_id, device_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, auth.userId, auth.deviceId, createdAt);
    const events = [
      this.addEvent({
        userId: auth.userId,
        channelId: auth.channelId,
        sessionId: id,
        type: "session.opened",
        payload: { sessionId: id, title: sessionTitle },
      }),
    ];
    return {
      httpStatus: 200,
      body: { sessionId: id, title: sessionTitle },
      events,
      kickRunId: null,
      replayed: false,
    };
  }

  private resumeSession(auth: AuthContext, sessionId: string): CommandOutcome {
    const session = this.ownedSession(auth.userId, sessionId);
    if (!session) throw new DomainError("NOT_FOUND", "会话不存在。");
    this.db
      .prepare(
        "INSERT INTO session_grants(session_id, user_id, device_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(sessionId, auth.userId, auth.deviceId, nowIso());
    const events = [
      this.addEvent({
        userId: auth.userId,
        channelId: auth.channelId,
        sessionId,
        type: "session.resumed",
        payload: { sessionId, deviceId: auth.deviceId },
      }),
    ];
    return {
      httpStatus: 200,
      body: { sessionId, granted: true },
      events,
      kickRunId: null,
      replayed: false,
    };
  }

  private submitMessage(
    auth: AuthContext,
    payload: { sessionId: string; text: string; providerMode: "demo" | "live" },
    limits: Limits,
  ): CommandOutcome {
    if (!this.hasGrant(auth, payload.sessionId)) {
      throw new DomainError(
        "SESSION_NOT_GRANTED",
        "当前设备还不能在这个会话里发言。请先显式恢复会话。",
      );
    }
    const active = this.db
      .prepare(
        "SELECT id FROM runs WHERE session_id=? AND kind='root' AND status IN ('queued','running','awaiting_approval')",
      )
      .get(payload.sessionId) as { id: string } | undefined;
    if (active)
      throw new DomainError("SESSION_BUSY", "这个会话已有进行中的根运行。");
    const createdAt = nowIso();
    const messageId = newId();
    const runId = newId();
    const script = scriptOf(payload.text);
    this.db
      .prepare(
        "INSERT INTO messages(id, session_id, user_id, run_id, role, content, created_at) VALUES (?, ?, ?, NULL, 'user', ?, ?)",
      )
      .run(messageId, payload.sessionId, auth.userId, payload.text, createdAt);
    const session = this.ownedSession(auth.userId, payload.sessionId);
    if (!session) throw new DomainError("NOT_FOUND", "会话不存在。");
    this.db
      .prepare(
        `INSERT INTO runs(
          id, session_id, user_id, channel_id, root_message_id, kind, parent_run_id, specialist_role,
          status, result_code, provider_mode, script, stage, budget_total, budget_reserved, budget_used,
          model_steps, max_model_steps, execution_budget_ms, execution_used_ms, active_deadline_at,
          cancel_requested_at, output_draft, terminal_at, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'root', NULL, NULL, 'running', NULL, ?, ?, 'created', ?, 0, 0, 0, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        runId,
        payload.sessionId,
        auth.userId,
        String(session?.channel_id),
        messageId,
        payload.providerMode,
        script,
        limits.toolBudget,
        limits.maxModelSteps,
        limits.executionBudgetMs,
        createdAt,
        createdAt,
      );
    this.db
      .prepare("UPDATE messages SET run_id=? WHERE id=?")
      .run(runId, messageId);
    this.db
      .prepare(
        "UPDATE sessions SET updated_at=?, title=CASE WHEN title='未命名会话' THEN ? ELSE title END WHERE id=?",
      )
      .run(createdAt, payload.text.slice(0, 24), payload.sessionId);
    const events = [
      this.addEvent({
        userId: auth.userId,
        channelId: auth.channelId,
        sessionId: payload.sessionId,
        runId,
        type: "message.user.created",
        payload: {
          messageId,
          sessionId: payload.sessionId,
          runId,
          text: payload.text,
        },
      }),
      this.addEvent({
        userId: auth.userId,
        channelId: auth.channelId,
        sessionId: payload.sessionId,
        runId,
        type: "run.started",
        payload: {
          runId,
          sessionId: payload.sessionId,
          providerMode: payload.providerMode,
          script,
          budgetTotal: limits.toolBudget,
        },
      }),
    ];
    return {
      httpStatus: 202,
      body: { accepted: true, runId, sessionId: payload.sessionId },
      events,
      kickRunId: runId,
      replayed: false,
    };
  }

  private cancelRun(auth: AuthContext, runId: string): CommandOutcome {
    const run = this.getRun(runId);
    if (!run || run.user_id !== auth.userId || run.kind !== "root") {
      throw new DomainError("NOT_FOUND", "运行不存在。");
    }
    if (run.status === "cancelled") {
      return {
        httpStatus: 200,
        body: { runId, accepted: true, alreadyCancelled: true },
        events: [],
        kickRunId: null,
        replayed: false,
      };
    }
    if (["completed", "failed", "timed_out"].includes(String(run.status))) {
      return {
        httpStatus: 200,
        body: {
          runId,
          accepted: false,
          message: "运行已经结束。取消不能撤销已经发生的副作用。",
          status: run.status,
        },
        events: [],
        kickRunId: null,
        replayed: false,
      };
    }
    const stamp = nowIso();
    this.db
      .prepare(
        "UPDATE runs SET status='cancelled', result_code='user_cancelled', cancel_requested_at=?, terminal_at=?, updated_at=?, active_deadline_at=NULL WHERE id=?",
      )
      .run(stamp, stamp, stamp, runId);
    const events = [
      this.addEvent({
        userId: auth.userId,
        channelId: auth.channelId,
        sessionId: String(run.session_id),
        runId,
        type: "run.cancel_accepted",
        payload: {
          runId,
          message:
            "已接受取消。这只阻止新的工具调用，不能撤销已经开始的副作用。",
        },
      }),
      this.addEvent({
        userId: auth.userId,
        channelId: auth.channelId,
        sessionId: String(run.session_id),
        runId,
        type: "run.cancelled",
        payload: { runId, resultCode: "user_cancelled" },
      }),
      this.addEvent({
        userId: auth.userId,
        channelId: null,
        sessionId: String(run.session_id),
        runId,
        type: "run.outcome",
        payload: {
          runId,
          sessionId: String(run.session_id),
          resultCode: "user_cancelled",
          effect: "none",
          resource: null,
          excerpt: "已接受取消。尚未执行的写入不会开始。",
        },
      }),
    ];
    return {
      httpStatus: 200,
      body: { runId, accepted: true, stopped: false },
      events,
      kickRunId: null,
      replayed: false,
    };
  }

  private resolveApproval(
    auth: AuthContext,
    payload: {
      approvalId: string;
      decision: "approve" | "reject";
      expectedVersion: number;
      paramsHash: string;
    },
  ): CommandOutcome {
    const approval = this.db
      .prepare("SELECT * FROM approvals WHERE id=?")
      .get(payload.approvalId) as SqlRow | undefined;
    if (!approval || approval.user_id !== auth.userId)
      throw new DomainError("NOT_FOUND", "审批不存在。");
    const run = this.getRun(String(approval.run_id));
    if (!run) throw new DomainError("NOT_FOUND", "运行不存在。");
    if (String(approval.status) === "pending") {
      if (Number(approval.version) !== payload.expectedVersion) {
        throw new DomainError("STALE_APPROVAL_VERSION", "审批版本已变化。");
      }
      if (String(approval.params_hash) !== payload.paramsHash) {
        throw new DomainError(
          "APPROVAL_BINDING_MISMATCH",
          "参数与审批绑定时不一致，需要新的审批。",
        );
      }
      if (String(approval.expires_at) <= nowIso()) {
        throw new DomainError("APPROVAL_EXPIRED", "审批已过期。");
      }
      if (run.cancel_requested_at || run.status === "cancelled") {
        throw new DomainError("RUN_CANCELLED", "运行已取消，不能再接受审批。");
      }
      const stamp = nowIso();
      const info = this.db
        .prepare(
          `UPDATE approvals SET status=?, decision=?, version=version+1, decided_by_device_id=?, resolved_at=?
           WHERE id=? AND status='pending' AND version=? AND params_hash=?`,
        )
        .run(
          payload.decision === "approve" ? "approved" : "rejected",
          payload.decision,
          auth.deviceId,
          stamp,
          payload.approvalId,
          payload.expectedVersion,
          payload.paramsHash,
        );
      if (info.changes !== 1)
        throw new DomainError("DECISION_CONFLICT", "审批已被其他设备处理。");
      if (payload.decision === "approve") {
        this.db
          .prepare(
            "UPDATE tool_calls SET status='ready', updated_at=? WHERE id=? AND status='awaiting_approval'",
          )
          .run(stamp, approval.tool_call_id);
      } else {
        this.finishReservedTool(
          String(approval.tool_call_id),
          "rejected",
          "approval_rejected",
          "审批被拒绝，写入没有执行。",
        );
      }
      const events = [
        this.addEvent({
          userId: auth.userId,
          channelId: null,
          sessionId: String(approval.session_id),
          runId: String(approval.run_id),
          type: "approval.resolved",
          payload: {
            approvalId: payload.approvalId,
            decision: payload.decision,
            toolCallId: approval.tool_call_id,
            toolName: approval.tool_name,
            resource: approval.resource,
            paramsHash: approval.params_hash,
            runId: approval.run_id,
            sessionId: approval.session_id,
          },
        }),
      ];
      if (payload.decision === "reject") {
        events.push(
          this.addEvent({
            userId: auth.userId,
            channelId: null,
            sessionId: String(approval.session_id),
            runId: String(approval.run_id),
            taskId: String(approval.tool_call_id),
            type: "tool.failed",
            payload: {
              toolCallId: approval.tool_call_id,
              toolName: approval.tool_name,
              resource: approval.resource,
              status: "rejected",
              errorCode: "approval_rejected",
              message: "审批被拒绝，写入没有执行。",
            },
          }),
        );
      }
      return {
        httpStatus: 200,
        body: {
          outcome: "applied",
          approvalId: payload.approvalId,
          decision: payload.decision,
          runId: approval.run_id,
        },
        events,
        kickRunId: String(approval.run_id),
        replayed: false,
      };
    }
    if (
      approval.decision === payload.decision &&
      approval.params_hash === payload.paramsHash
    ) {
      return {
        httpStatus: 200,
        body: {
          outcome: "idempotent",
          approvalId: payload.approvalId,
          decision: payload.decision,
          runId: approval.run_id,
        },
        events: [],
        kickRunId: null,
        replayed: false,
      };
    }
    throw new DomainError("DECISION_CONFLICT", "审批已经以相反的决定结束。");
  }

  private revokeDevice(auth: AuthContext, deviceId: string): CommandOutcome {
    const row = this.db
      .prepare("SELECT * FROM devices WHERE id=? AND user_id=?")
      .get(deviceId, auth.userId) as SqlRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "设备不存在。");
    if (!row.revoked_at) {
      this.db
        .prepare("UPDATE devices SET revoked_at=? WHERE id=?")
        .run(nowIso(), deviceId);
    }
    const events = [
      this.addEvent({
        userId: auth.userId,
        channelId: null,
        sessionId: null,
        runId: null,
        type: "device.revoked",
        payload: { deviceId },
      }),
    ];
    return {
      httpStatus: 200,
      body: { deviceId, revoked: true },
      events,
      kickRunId: null,
      replayed: false,
    };
  }

  expireApprovals(now = nowIso()): DurableEvent[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT * FROM approvals WHERE status='pending' AND expires_at<=?",
        )
        .all(now) as SqlRow[];
      const events: DurableEvent[] = [];
      for (const approval of rows) {
        const stamp = nowIso();
        const info = this.db
          .prepare(
            "UPDATE approvals SET status='expired', decision='expire', resolved_at=? WHERE id=? AND status='pending'",
          )
          .run(stamp, approval.id);
        if (info.changes !== 1) continue;
        this.finishReservedTool(
          String(approval.tool_call_id),
          "cancelled",
          "approval_expired",
          "审批过期，写入没有执行。",
        );
        const run = this.getRun(String(approval.run_id));
        if (
          run &&
          ["running", "awaiting_approval", "queued"].includes(
            String(run.status),
          )
        ) {
          this.db
            .prepare(
              "UPDATE runs SET status='failed', result_code='approval_expired', error_code='approval_expired', error_message=?, terminal_at=?, updated_at=? WHERE id=?",
            )
            .run("审批已过期，调用已终止，没有续期。", stamp, stamp, run.id);
        }
        events.push(
          this.addEvent({
            userId: String(approval.user_id),
            channelId: null,
            sessionId: String(approval.session_id),
            runId: String(approval.run_id),
            type: "approval.expired",
            payload: {
              approvalId: approval.id,
              runId: approval.run_id,
              resource: approval.resource,
              message: "审批已过期，写入没有执行。",
            },
          }),
        );
        events.push(
          this.addEvent({
            userId: String(approval.user_id),
            channelId: null,
            sessionId: String(approval.session_id),
            runId: String(approval.run_id),
            type: "run.outcome",
            payload: {
              runId: approval.run_id,
              sessionId: approval.session_id,
              resultCode: "approval_expired",
              effect: "none",
              resource: approval.resource,
              excerpt: "审批已过期，写入没有执行。",
            },
          }),
        );
      }
      return events;
    });
  }

  getRun(id: string): SqlRow | null {
    return (
      (this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as
        | SqlRow
        | undefined) ?? null
    );
  }

  patchRun(id: string, patch: Record<string, string | number | null>): void {
    const work = () => this.patchRunUnchecked(id, patch);
    if (this.db.inTransaction) work();
    else this.transaction(work);
  }

  private patchRunUnchecked(
    id: string,
    patch: Record<string, string | number | null>,
  ): void {
    const allowed = new Set([
      "status",
      "result_code",
      "stage",
      "output_draft",
      "terminal_at",
      "error_code",
      "error_message",
      "active_deadline_at",
      "execution_used_ms",
      "cancel_requested_at",
      "updated_at",
    ]);
    const keys = Object.keys(patch).filter(
      (key) => allowed.has(key) && key !== "updated_at",
    );
    if (keys.length === 0) return;
    const sets = [...keys.map((key) => `${key}=?`), "updated_at=?"].join(", ");
    this.db
      .prepare(`UPDATE runs SET ${sets} WHERE id=?`)
      .run(...keys.map((key) => patch[key]), nowIso(), id);
  }

  recordModelStep(rootRunId: string): boolean {
    const work = () => {
      const info = this.db
        .prepare(
          "UPDATE runs SET model_steps=model_steps+1, updated_at=? WHERE id=? AND model_steps < max_model_steps",
        )
        .run(nowIso(), rootRunId);
      return info.changes === 1;
    };
    if (this.db.inTransaction) return work();
    return this.transaction(work);
  }

  armDeadline(runId: string, nowMs = Date.now()): void {
    const run = this.getRun(runId);
    if (!run || run.active_deadline_at) return;
    const remaining = Math.max(
      0,
      Number(run.execution_budget_ms) - Number(run.execution_used_ms),
    );
    this.patchRun(runId, {
      active_deadline_at: new Date(nowMs + remaining).toISOString(),
    });
  }

  pauseDeadline(runId: string, nowMs = Date.now()): void {
    const run = this.getRun(runId);
    if (!run?.active_deadline_at) return;
    const left = Math.max(
      0,
      Date.parse(String(run.active_deadline_at)) - nowMs,
    );
    const used = Number(run.execution_budget_ms) - left;
    this.patchRun(runId, { execution_used_ms: used, active_deadline_at: null });
  }

  ensureExpert(input: { root: SqlRow; role: string; isolatedInput: unknown }): {
    task: SqlRow;
    runId: string;
    created: boolean;
  } {
    const existing = this.db
      .prepare("SELECT * FROM expert_tasks WHERE root_run_id=? AND role=?")
      .get(input.root.id, input.role) as SqlRow | undefined;
    if (existing)
      return {
        task: existing,
        runId: String(existing.expert_run_id),
        created: false,
      };
    const createdAt = nowIso();
    const runId = newId();
    const taskId = newId();
    this.db
      .prepare(
        `INSERT INTO runs(
          id, session_id, user_id, channel_id, root_message_id, kind, parent_run_id, specialist_role,
          status, result_code, provider_mode, script, stage, budget_total, budget_reserved, budget_used,
          model_steps, max_model_steps, execution_budget_ms, execution_used_ms, active_deadline_at,
          cancel_requested_at, output_draft, terminal_at, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'expert', ?, ?, 'running', NULL, ?, ?, 'working', 0, 0, 0, 0, 0, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        runId,
        input.root.session_id,
        input.root.user_id,
        input.root.channel_id,
        input.root.root_message_id,
        input.root.id,
        input.role,
        input.root.provider_mode,
        input.root.script,
        input.root.execution_budget_ms,
        createdAt,
        createdAt,
      );
    this.db
      .prepare(
        `INSERT INTO expert_tasks(id, root_run_id, expert_run_id, user_id, session_id, role, status, input_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        taskId,
        input.root.id,
        runId,
        input.root.user_id,
        input.root.session_id,
        input.role,
        JSON.stringify(input.isolatedInput),
        createdAt,
        createdAt,
      );
    const task = this.db
      .prepare("SELECT * FROM expert_tasks WHERE id=?")
      .get(taskId) as SqlRow;
    return { task, runId, created: true };
  }

  finishExpert(
    taskId: string,
    patch: {
      status: string;
      output?: unknown;
      errorCode?: string;
      errorMessage?: string;
    },
  ): void {
    const task = this.db
      .prepare("SELECT * FROM expert_tasks WHERE id=?")
      .get(taskId) as SqlRow;
    this.db
      .prepare(
        "UPDATE expert_tasks SET status=?, output_json=?, error_code=?, error_message=?, updated_at=? WHERE id=?",
      )
      .run(
        patch.status,
        patch.output === undefined
          ? task.output_json
          : JSON.stringify(patch.output),
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        nowIso(),
        taskId,
      );
    if (task.expert_run_id) {
      const status = patch.status === "completed" ? "completed" : "failed";
      this.db
        .prepare(
          "UPDATE runs SET status=?, error_code=?, error_message=?, terminal_at=?, updated_at=? WHERE id=?",
        )
        .run(
          status,
          patch.errorCode ?? null,
          patch.errorMessage ?? null,
          nowIso(),
          nowIso(),
          task.expert_run_id,
        );
    }
  }

  beginTool(input: {
    logicalKey: string;
    runId: string;
    rootRunId: string;
    userId: string;
    sessionId: string;
    toolName: string;
    toolVersion: string;
    params: unknown;
    paramsHash: string;
    resource: string;
    sideEffect: boolean;
    requiresApproval: boolean;
    approvalTtlMs: number;
  }):
    | { blocked: true; event: DurableEvent }
    | {
        blocked: false;
        tool: SqlRow;
        created: boolean;
        events: DurableEvent[];
      } {
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT * FROM tool_calls WHERE root_run_id=? AND logical_key=?",
        )
        .get(input.rootRunId, input.logicalKey) as SqlRow | undefined;
      if (existing)
        return { blocked: false, tool: existing, created: false, events: [] };
      const reserved = this.db
        .prepare(
          "UPDATE runs SET budget_reserved=budget_reserved+1, updated_at=? WHERE id=? AND budget_reserved < budget_total",
        )
        .run(nowIso(), input.rootRunId);
      if (reserved.changes !== 1) {
        const event = this.addEvent({
          userId: input.userId,
          channelId: null,
          sessionId: input.sessionId,
          runId: input.rootRunId,
          type: "tool.blocked",
          payload: {
            logicalKey: input.logicalKey,
            toolName: input.toolName,
            code: "BUDGET_EXHAUSTED",
            message: "根预算已用尽，这次工具调用没有开始。",
          },
        });
        return { blocked: true, event };
      }
      const id = newId();
      const createdAt = nowIso();
      const status = input.requiresApproval ? "awaiting_approval" : "intent";
      this.db
        .prepare(
          `INSERT INTO tool_calls(
            id, logical_key, run_id, root_run_id, user_id, session_id, tool_name, tool_version,
            params_json, params_hash, resource, status, side_effect, attempt, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.logicalKey,
          input.runId,
          input.rootRunId,
          input.userId,
          input.sessionId,
          input.toolName,
          input.toolVersion,
          JSON.stringify(input.params),
          input.paramsHash,
          input.resource,
          status,
          input.sideEffect ? 1 : 0,
          createdAt,
          createdAt,
        );
      const events: DurableEvent[] = [
        this.addEvent({
          userId: input.userId,
          channelId: null,
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: id,
          type: "tool.started",
          payload: {
            toolCallId: id,
            logicalKey: input.logicalKey,
            toolName: input.toolName,
            toolVersion: input.toolVersion,
            resource: input.resource,
            params: input.params,
            paramsHash: input.paramsHash,
            sideEffect: input.sideEffect,
            status,
          },
        }),
      ];
      if (input.requiresApproval) {
        const approvalId = newId();
        const expiresAt = nowIso(Date.now() + input.approvalTtlMs);
        this.db
          .prepare(
            `INSERT INTO approvals(
              id, user_id, run_id, session_id, tool_call_id, tool_name, tool_version, params_hash,
              params_json, resource, status, version, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
          )
          .run(
            approvalId,
            input.userId,
            input.rootRunId,
            input.sessionId,
            id,
            input.toolName,
            input.toolVersion,
            input.paramsHash,
            JSON.stringify(input.params),
            input.resource,
            expiresAt,
            createdAt,
          );
        this.db
          .prepare("UPDATE tool_calls SET approval_id=? WHERE id=?")
          .run(approvalId, id);
        this.patchRun(input.rootRunId, {
          status: "awaiting_approval",
          stage: "awaiting_write",
        });
        this.pauseDeadline(input.rootRunId);
        events.push(
          this.addEvent({
            userId: input.userId,
            channelId: null,
            sessionId: input.sessionId,
            runId: input.rootRunId,
            taskId: id,
            type: "approval.requested",
            payload: {
              approvalId,
              runId: input.rootRunId,
              sessionId: input.sessionId,
              toolCallId: id,
              toolName: input.toolName,
              toolVersion: input.toolVersion,
              resource: input.resource,
              params: input.params,
              paramsHash: input.paramsHash,
              version: 1,
              expiresAt,
            },
          }),
        );
      }
      const tool = this.db
        .prepare("SELECT * FROM tool_calls WHERE id=?")
        .get(id) as SqlRow;
      return { blocked: false, tool, created: true, events };
    });
  }

  claimTool(
    toolId: string,
    fromStatus: string,
    claimToken: string,
  ): { claimed: boolean; reason?: string } {
    return this.transaction(() => {
      const tool = this.db
        .prepare("SELECT * FROM tool_calls WHERE id=?")
        .get(toolId) as SqlRow | undefined;
      if (!tool) return { claimed: false, reason: "missing" };
      const root = this.getRun(String(tool.root_run_id));
      if (
        root?.cancel_requested_at &&
        Number(tool.side_effect) === 1 &&
        fromStatus !== "dispatching"
      ) {
        this.finishReservedTool(
          toolId,
          "cancelled",
          "user_cancelled",
          "取消生效于副作用之前，写入没有执行。",
        );
        return { claimed: false, reason: "cancelled" };
      }
      const info = this.db
        .prepare(
          "UPDATE tool_calls SET status='dispatching', dispatch_claim_token=?, updated_at=? WHERE id=? AND status=?",
        )
        .run(claimToken, nowIso(), toolId, fromStatus);
      return { claimed: info.changes === 1 };
    });
  }

  finishTool(
    toolId: string,
    claimToken: string,
    status: string,
    extra: { result?: unknown; errorCode?: string; errorMessage?: string },
  ): boolean {
    return this.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE tool_calls SET status=?, result_json=?, error_code=?, error_message=?, updated_at=?
           WHERE id=? AND status='dispatching' AND dispatch_claim_token=?`,
        )
        .run(
          status,
          extra.result === undefined ? null : JSON.stringify(extra.result),
          extra.errorCode ?? null,
          extra.errorMessage ?? null,
          nowIso(),
          toolId,
          claimToken,
        );
      if (info.changes !== 1) return false;
      this.countBudget(toolId);
      return true;
    });
  }

  private finishReservedTool(
    toolId: string,
    status: string,
    errorCode: string,
    errorMessage: string,
  ): void {
    const info = this.db
      .prepare(
        "UPDATE tool_calls SET status=?, error_code=?, error_message=?, updated_at=? WHERE id=? AND status IN ('intent','awaiting_approval','ready','dispatching')",
      )
      .run(status, errorCode, errorMessage, nowIso(), toolId);
    if (info.changes === 1) this.countBudget(toolId);
  }

  private countBudget(toolId: string): void {
    const tool = this.db
      .prepare("SELECT * FROM tool_calls WHERE id=?")
      .get(toolId) as SqlRow | undefined;
    if (!tool || Number(tool.budget_counted) === 1) return;
    this.db
      .prepare(
        "UPDATE tool_calls SET budget_counted=1 WHERE id=? AND budget_counted=0",
      )
      .run(toolId);
    this.db
      .prepare(
        "UPDATE runs SET budget_used=budget_used+1, updated_at=? WHERE id=?",
      )
      .run(nowIso(), tool.root_run_id);
  }

  reconcileDispatching(): DurableEvent[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM tool_calls WHERE status='dispatching'")
        .all() as SqlRow[];
      const events: DurableEvent[] = [];
      for (const tool of rows) {
        this.db
          .prepare(
            "UPDATE tool_calls SET status='outcome_unknown', error_code='crash_while_dispatching', error_message=?, updated_at=? WHERE id=? AND status='dispatching'",
          )
          .run(
            "进程在副作用边界中断，结果没有入库。不会自动重放。",
            nowIso(),
            tool.id,
          );
        this.countBudget(String(tool.id));
        events.push(
          this.addEvent({
            userId: String(tool.user_id),
            channelId: null,
            sessionId: String(tool.session_id),
            runId: String(tool.root_run_id),
            taskId: String(tool.id),
            type: "tool.outcome_unknown",
            payload: {
              toolCallId: tool.id,
              logicalKey: tool.logical_key,
              resource: tool.resource,
              message: "副作用结果未知，系统不会自动再执行一次。",
            },
          }),
        );
      }
      return events;
    });
  }

  insertEffect(
    toolCallId: string,
    rootRunId: string,
    kind: string,
    effectPath: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO effect_log(tool_call_id, root_run_id, kind, path, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(toolCallId, rootRunId, kind, effectPath, nowIso());
  }

  effectCount(kind = "write"): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM effect_log WHERE kind=?")
      .get(kind) as { n: number };
    return Number(row.n);
  }

  addEvent(input: {
    userId: string;
    channelId: string | null;
    sessionId: string | null;
    runId?: string | null;
    taskId?: string | null;
    type: DurableEvent["type"];
    payload: Record<string, unknown>;
  }): DurableEvent {
    const eventId = newId();
    const createdAt = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO events(event_id, user_id, channel_id, session_id, run_id, task_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.userId,
        input.channelId,
        input.sessionId,
        input.runId ?? null,
        input.taskId ?? null,
        input.type,
        JSON.stringify(input.payload),
        createdAt,
      );
    const seq = Number(info.lastInsertRowid);
    const cursor = signCursor(
      {
        v: 1,
        epoch: this.epoch(),
        seq,
        principalId: input.userId,
        exp: Date.now() + this.cursorTtlMs,
      },
      this.cursorSecret(),
    );
    return {
      protocol: EVENT_PROTOCOL,
      eventId,
      seq,
      cursor,
      userId: input.userId,
      channelId: input.channelId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      type: input.type,
      createdAt,
      payload: input.payload,
    };
  }

  maxSeq(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) as seq FROM events")
      .get() as { seq: number };
    return Number(row.seq);
  }

  checkCursor(
    token: string,
    principalId: string,
    nowMs = Date.now(),
  ): CursorCheck {
    return verifyCursor(token, this.cursorSecret(), {
      epoch: this.epoch(),
      principalId,
      maxSeq: this.maxSeq(),
      nowMs,
    });
  }

  issueCursor(
    principalId: string,
    seq: number,
    exp = Date.now() + this.cursorTtlMs,
  ): string {
    return signCursor(
      { v: 1, epoch: this.epoch(), seq, principalId, exp },
      this.cursorSecret(),
    );
  }

  snapshot(auth: AuthContext): Snapshot {
    return this.transaction(() => this.buildSnapshot(auth));
  }

  replay(
    auth: AuthContext,
    afterSeq: number,
  ): {
    events: DurableEvent[];
    watermarkSeq: number;
    watermarkCursor: string | null;
  } {
    return this.transaction(() => {
      const watermarkSeq = this.maxSeq();
      const events = this.visibleEvents(auth, afterSeq, watermarkSeq);
      return {
        events,
        watermarkSeq,
        watermarkCursor:
          watermarkSeq === 0
            ? null
            : this.issueCursor(auth.userId, watermarkSeq),
      };
    });
  }

  private buildSnapshot(auth: AuthContext): Snapshot {
    const watermarkSeq = this.maxSeq();
    const sessions = this.grantedSessions(auth).map(mapSession);
    const sessionIds = sessions.map((session) => session.id);
    const messages = sessionIds.length
      ? this.messagesFor(auth.userId, sessionIds).map(mapMessage)
      : [];
    const runs = sessionIds.length
      ? this.runsFor(auth.userId, sessionIds).map(mapRun)
      : [];
    const runIds = runs.map((run) => run.id);
    const tools = runIds.length ? this.toolsFor(runIds).map(mapTool) : [];
    const specialists = runIds.length
      ? this.specialistsFor(runIds).map(mapSpecialist)
      : [];
    const approvals = (
      this.db
        .prepare("SELECT * FROM approvals WHERE user_id=? ORDER BY created_at")
        .all(auth.userId) as SqlRow[]
    ).map(mapApproval);
    const outcomeRows = this.db
      .prepare(
        "SELECT payload_json, seq FROM events WHERE user_id=? AND type='run.outcome' ORDER BY seq",
      )
      .all(auth.userId) as Array<{ payload_json: string }>;
    const outcomeMap = new Map<string, OutcomeView>();
    for (const row of outcomeRows) {
      const payload = JSON.parse(row.payload_json) as OutcomeView;
      outcomeMap.set(payload.runId, payload);
    }
    return {
      protocol: EVENT_PROTOCOL,
      watermarkSeq,
      watermarkCursor:
        watermarkSeq === 0 ? null : this.issueCursor(auth.userId, watermarkSeq),
      deviceId: auth.deviceId,
      userId: auth.userId,
      sessions,
      messages,
      runs,
      tools,
      specialists,
      approvals,
      outcomes: [...outcomeMap.values()],
    };
  }

  private visibleEvents(
    auth: AuthContext,
    afterSeq: number,
    upToSeq: number,
  ): DurableEvent[] {
    const granted = new Set(
      this.grantedSessions(auth).map((session) => String(session.id)),
    );
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE user_id=? AND seq>? AND seq<=? ORDER BY seq",
      )
      .all(auth.userId, afterSeq, upToSeq) as SqlRow[];
    const events: DurableEvent[] = [];
    for (const row of rows) {
      if (
        !isOwnerVisibleEvent(String(row.type)) &&
        !(row.session_id && granted.has(String(row.session_id)))
      ) {
        continue;
      }
      events.push(this.hydrateEvent(row));
    }
    return events;
  }

  private hydrateEvent(row: SqlRow): DurableEvent {
    const seq = Number(row.seq);
    return {
      protocol: EVENT_PROTOCOL,
      eventId: String(row.event_id),
      seq,
      cursor: this.issueCursor(String(row.user_id), seq),
      userId: String(row.user_id),
      channelId: row.channel_id ? String(row.channel_id) : null,
      sessionId: row.session_id ? String(row.session_id) : null,
      runId: row.run_id ? String(row.run_id) : null,
      taskId: row.task_id ? String(row.task_id) : null,
      type: String(row.type) as DurableEvent["type"],
      createdAt: String(row.created_at),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    };
  }

  getMessage(id: string): SqlRow | null {
    return (
      (this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as
        | SqlRow
        | undefined) ?? null
    );
  }

  listExpertTasks(rootRunId: string): SqlRow[] {
    return this.db
      .prepare("SELECT * FROM expert_tasks WHERE root_run_id=? ORDER BY role")
      .all(rootRunId) as SqlRow[];
  }

  activeRootIds(): string[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE kind='root' AND status IN ('queued','running','awaiting_approval') ORDER BY created_at",
        )
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  assistantMessageForRun(runId: string): SqlRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM messages WHERE run_id=? AND role='assistant' LIMIT 1",
        )
        .get(runId) as SqlRow | undefined) ?? null
    );
  }

  insertAssistantMessage(input: { run: SqlRow; content: string }): string {
    const existing = this.assistantMessageForRun(String(input.run.id));
    if (existing) return String(existing.id);
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO messages(id, session_id, user_id, run_id, role, content, created_at) VALUES (?, ?, ?, ?, 'assistant', ?, ?)",
      )
      .run(
        id,
        input.run.session_id,
        input.run.user_id,
        input.run.id,
        input.content,
        nowIso(),
      );
    return id;
  }

  effectRows(): Array<{
    effectKey: string;
    runId: string;
    approvalId: string | null;
    toolCallId: string;
    kind: string;
    file: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT e.tool_call_id, e.root_run_id, e.kind, e.path, a.id AS approval_id
         FROM effect_log e
         LEFT JOIN approvals a ON a.tool_call_id = e.tool_call_id
         ORDER BY e.id`,
      )
      .all() as Array<{
      tool_call_id: string;
      root_run_id: string;
      kind: string;
      path: string;
      approval_id: string | null;
    }>;
    return rows.map((row) => ({
      effectKey: `${row.tool_call_id}:${row.kind}`,
      runId: String(row.root_run_id),
      approvalId: row.approval_id ? String(row.approval_id) : null,
      toolCallId: String(row.tool_call_id),
      kind: String(row.kind),
      file: String(row.path).split("/").at(-1) ?? String(row.path),
    }));
  }

  summary(): Record<string, unknown> {
    const effects = this.effectCount("write");
    const tools = this.db
      .prepare("SELECT status, COUNT(*) as n FROM tool_calls GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    const runs = this.db
      .prepare(
        "SELECT id, status, budget_reserved, budget_used, result_code FROM runs WHERE kind='root'",
      )
      .all();
    return {
      effects,
      effectRows: this.effectRows(),
      tools,
      runs,
      maxSeq: this.maxSeq(),
    };
  }

  private grantedSessions(auth: AuthContext): SqlRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sessions s
         JOIN session_grants g ON g.session_id=s.id AND g.device_id=?
         WHERE s.user_id=? ORDER BY s.created_at`,
      )
      .all(auth.deviceId, auth.userId) as SqlRow[];
  }

  private hasGrant(auth: AuthContext, sessionId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 as ok FROM session_grants WHERE session_id=? AND device_id=? AND user_id=?",
      )
      .get(sessionId, auth.deviceId, auth.userId);
    return Boolean(row);
  }

  private ownedSession(userId: string, sessionId: string): SqlRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM sessions WHERE id=? AND user_id=?")
        .get(sessionId, userId) as SqlRow | undefined) ?? null
    );
  }

  private messagesFor(userId: string, sessionIds: string[]): SqlRow[] {
    const marks = sessionIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE user_id=? AND session_id IN (${marks}) ORDER BY created_at`,
      )
      .all(userId, ...sessionIds) as SqlRow[];
  }

  private runsFor(userId: string, sessionIds: string[]): SqlRow[] {
    const marks = sessionIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE user_id=? AND session_id IN (${marks}) ORDER BY created_at`,
      )
      .all(userId, ...sessionIds) as SqlRow[];
  }

  private toolsFor(runIds: string[]): SqlRow[] {
    const marks = runIds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM tool_calls WHERE root_run_id IN (${marks})`)
      .all(...runIds) as SqlRow[];
  }

  private specialistsFor(runIds: string[]): SqlRow[] {
    const marks = runIds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM expert_tasks WHERE root_run_id IN (${marks})`)
      .all(...runIds) as SqlRow[];
  }
}

function scriptOf(text: string): string {
  if (text.startsWith("/budget-burn")) return "budget_burn";
  if (text.startsWith("/partial-fail")) return "partial_fail";
  if (text.startsWith("/slow-read")) return "slow_read";
  return "standard";
}

function mapSession(row: SqlRow): SessionView {
  return {
    id: String(row.id),
    title: String(row.title),
    channelId: String(row.channel_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMessage(row: SqlRow): MessageView {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    runId: row.run_id ? String(row.run_id) : null,
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

function mapRun(row: SqlRow): RunView {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    kind: row.kind === "expert" ? "expert" : "root",
    parentRunId: row.parent_run_id ? String(row.parent_run_id) : null,
    specialistRole: row.specialist_role ? String(row.specialist_role) : null,
    status: String(row.status) as RunView["status"],
    resultCode: row.result_code ? String(row.result_code) : null,
    providerMode: row.provider_mode === "live" ? "live" : "demo",
    stage: String(row.stage),
    budgetTotal: Number(row.budget_total),
    budgetReserved: Number(row.budget_reserved),
    budgetUsed: Number(row.budget_used),
    modelSteps: Number(row.model_steps),
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTool(row: SqlRow): ToolView {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    rootRunId: String(row.root_run_id),
    toolName: String(row.tool_name),
    toolVersion: String(row.tool_version),
    resource: String(row.resource),
    params: JSON.parse(String(row.params_json)),
    paramsHash: String(row.params_hash),
    status: String(row.status),
    sideEffect: Number(row.side_effect) === 1,
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
  };
}

function mapSpecialist(row: SqlRow): SpecialistView {
  return {
    id: String(row.id),
    rootRunId: String(row.root_run_id),
    role: String(row.role),
    status: String(row.status),
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    output: row.output_json ? JSON.parse(String(row.output_json)) : null,
  };
}

function mapApproval(row: SqlRow): ApprovalView {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    toolVersion: String(row.tool_version),
    resource: String(row.resource),
    params: JSON.parse(String(row.params_json)),
    paramsHash: String(row.params_hash),
    status: String(row.status),
    decision: row.decision ? String(row.decision) : null,
    version: Number(row.version),
    expiresAt: String(row.expires_at),
  };
}

export function loadStore(dataDir: string, cursorTtlMs: number): AppStore {
  return new AppStore(dataDir, { cursorTtlMs });
}
