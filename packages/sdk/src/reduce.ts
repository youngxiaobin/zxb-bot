import type {
  ApprovalView,
  DurableEvent,
  RunView,
  Snapshot,
  SpecialistView,
  ToolView,
} from "@pa/contracts";
import { emptyProjection, type Projection } from "./projection.js";

const EVENT_CAP = 4000;

export function applySnapshot(
  current: Projection,
  snapshot: Snapshot,
): Projection {
  const messages: Projection["messages"] = {};
  for (const message of snapshot.messages) {
    const list = messages[message.sessionId] ?? [];
    list.push(message);
    messages[message.sessionId] = list;
  }
  const runs: Record<string, RunView> = {};
  for (const run of snapshot.runs) runs[run.id] = run;
  const tools: Record<string, ToolView> = {};
  for (const tool of snapshot.tools) tools[tool.id] = tool;
  const specialists: Record<string, SpecialistView[]> = {};
  for (const task of snapshot.specialists) {
    const list = specialists[task.rootRunId] ?? [];
    list.push(task);
    specialists[task.rootRunId] = list;
  }
  return {
    ...current,
    version: 1,
    cursor: snapshot.watermarkCursor,
    self: { userId: snapshot.userId, deviceId: snapshot.deviceId },
    sessions: snapshot.sessions,
    messages,
    runs,
    tools,
    specialists,
    approvals: snapshot.approvals,
    outcomes: snapshot.outcomes,
    ephemeralByRun: {},
    lastError: null,
    eventIds: [],
    sensitiveReady: current.connection === "live",
  };
}

export function applyEvent(
  current: Projection,
  event: DurableEvent,
): Projection {
  if (current.eventIds.includes(event.eventId)) return current;
  const eventIds = [...current.eventIds, event.eventId];
  const needsResync = eventIds.length > EVENT_CAP;
  let next: Projection = {
    ...current,
    cursor: event.cursor,
    eventIds: needsResync ? eventIds.slice(-EVENT_CAP) : eventIds,
    lastError: needsResync
      ? {
          code: "PROJECTION_CAP",
          message: "本地事件索引已截断，需要重新读取快照。",
        }
      : current.lastError,
  };
  const payload = event.payload;
  if (event.type === "session.opened" || event.type === "session.resumed") {
    const id = String(payload.sessionId ?? event.sessionId ?? "");
    if (id && !next.sessions.some((session) => session.id === id)) {
      next = {
        ...next,
        sessions: [
          ...next.sessions,
          {
            id,
            title: String(payload.title ?? "已恢复的会话"),
            channelId: event.channelId ?? "",
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
          },
        ],
      };
    }
  }
  if (
    event.type === "message.user.created" ||
    event.type === "message.assistant.completed"
  ) {
    const sessionId = String(payload.sessionId ?? event.sessionId ?? "");
    const message = {
      id: String(payload.messageId),
      sessionId,
      runId: payload.runId ? String(payload.runId) : event.runId,
      role:
        event.type === "message.user.created"
          ? ("user" as const)
          : ("assistant" as const),
      content: String(payload.text ?? payload.content ?? ""),
      createdAt: event.createdAt,
    };
    const list = next.messages[sessionId] ?? [];
    if (!list.some((item) => item.id === message.id)) {
      next = {
        ...next,
        messages: { ...next.messages, [sessionId]: [...list, message] },
      };
    }
    if (event.type === "message.assistant.completed" && event.runId) {
      const ephemeral = { ...next.ephemeralByRun };
      delete ephemeral[event.runId];
      next = { ...next, ephemeralByRun: ephemeral };
    }
  }
  if (
    event.runId &&
    (event.type.startsWith("run.") || event.type === "message.user.created")
  ) {
    const previous = next.runs[event.runId];
    const status = statusFromEvent(event.type, previous?.status ?? "running");
    next = {
      ...next,
      runs: {
        ...next.runs,
        [event.runId]: {
          id: event.runId,
          sessionId: String(event.sessionId ?? previous?.sessionId ?? ""),
          kind: "root",
          parentRunId: previous?.parentRunId ?? null,
          specialistRole: previous?.specialistRole ?? null,
          status,
          resultCode: payload.resultCode
            ? String(payload.resultCode)
            : (previous?.resultCode ?? null),
          providerMode:
            payload.providerMode === "live"
              ? "live"
              : (previous?.providerMode ?? "demo"),
          stage: previous?.stage ?? "working",
          budgetTotal: Number(
            payload.budgetTotal ?? previous?.budgetTotal ?? 30,
          ),
          budgetReserved: previous?.budgetReserved ?? 0,
          budgetUsed: previous?.budgetUsed ?? 0,
          modelSteps: Number(payload.modelSteps ?? previous?.modelSteps ?? 0),
          errorCode: previous?.errorCode ?? null,
          errorMessage: previous?.errorMessage ?? null,
          createdAt: previous?.createdAt ?? event.createdAt,
          updatedAt: event.createdAt,
        },
      },
    };
  }
  if (event.type.startsWith("tool.") && payload.toolCallId) {
    const id = String(payload.toolCallId);
    const previous = next.tools[id];
    const tool: ToolView = {
      id,
      runId: event.runId ?? previous?.runId ?? "",
      rootRunId: event.runId ?? previous?.rootRunId ?? "",
      toolName: String(payload.toolName ?? previous?.toolName ?? ""),
      toolVersion: String(payload.toolVersion ?? previous?.toolVersion ?? ""),
      resource: String(payload.resource ?? previous?.resource ?? ""),
      params: payload.params ?? previous?.params ?? null,
      paramsHash: String(payload.paramsHash ?? previous?.paramsHash ?? ""),
      status: payload.status
        ? String(payload.status)
        : toolStatus(event.type, previous?.status ?? "intent"),
      sideEffect: Boolean(payload.sideEffect ?? previous?.sideEffect ?? false),
      errorCode: payload.errorCode
        ? String(payload.errorCode)
        : (previous?.errorCode ?? null),
      errorMessage: payload.message
        ? String(payload.message)
        : (previous?.errorMessage ?? null),
      result: payload.result ?? previous?.result ?? null,
    };
    next = { ...next, tools: { ...next.tools, [id]: tool } };
  }
  if (event.type.startsWith("specialist.") && event.runId) {
    const role = String(payload.role ?? "");
    const list = next.specialists[event.runId] ?? [];
    const specialist: SpecialistView = {
      id: String(payload.taskId ?? event.taskId ?? role),
      rootRunId: event.runId,
      role,
      status:
        event.type === "specialist.completed"
          ? "completed"
          : event.type === "specialist.failed"
            ? "failed"
            : "running",
      errorCode: payload.errorCode ? String(payload.errorCode) : null,
      errorMessage: payload.message ? String(payload.message) : null,
      output: payload.output ?? null,
    };
    next = {
      ...next,
      specialists: {
        ...next.specialists,
        [event.runId]: [
          ...list.filter((item) => item.role !== role),
          specialist,
        ],
      },
    };
  }
  if (
    event.type === "approval.requested" &&
    event.runId &&
    next.runs[event.runId]
  ) {
    next = {
      ...next,
      runs: {
        ...next.runs,
        [event.runId]: {
          ...next.runs[event.runId],
          status: "awaiting_approval",
          updatedAt: event.createdAt,
        },
      },
    };
  }
  if (event.type.startsWith("approval.")) {
    const id = String(payload.approvalId);
    const previous = next.approvals.find((item) => item.id === id);
    const approval: ApprovalView = {
      id,
      runId: String(payload.runId ?? event.runId ?? previous?.runId ?? ""),
      sessionId: String(
        payload.sessionId ?? event.sessionId ?? previous?.sessionId ?? "",
      ),
      toolCallId: String(payload.toolCallId ?? previous?.toolCallId ?? ""),
      toolName: String(payload.toolName ?? previous?.toolName ?? ""),
      toolVersion: String(payload.toolVersion ?? previous?.toolVersion ?? ""),
      resource: String(payload.resource ?? previous?.resource ?? ""),
      params: payload.params ?? previous?.params ?? null,
      paramsHash: String(payload.paramsHash ?? previous?.paramsHash ?? ""),
      status:
        event.type === "approval.requested"
          ? "pending"
          : event.type === "approval.expired"
            ? "expired"
            : String(payload.decision ?? "resolved"),
      decision: payload.decision
        ? String(payload.decision)
        : (previous?.decision ?? null),
      version: Number(payload.version ?? previous?.version ?? 1),
      expiresAt: String(payload.expiresAt ?? previous?.expiresAt ?? ""),
    };
    next = {
      ...next,
      approvals: [...next.approvals.filter((item) => item.id !== id), approval],
    };
  }
  if (event.type === "run.outcome") {
    const effect: "none" | "applied" | "unknown" =
      payload.effect === "applied" || payload.effect === "unknown"
        ? payload.effect
        : "none";
    const outcome = {
      runId: String(payload.runId),
      sessionId: payload.sessionId
        ? String(payload.sessionId)
        : event.sessionId,
      resultCode: String(payload.resultCode ?? ""),
      effect,
      resource: payload.resource ? String(payload.resource) : null,
      excerpt: String(payload.excerpt ?? ""),
    };
    const ephemeral = { ...next.ephemeralByRun };
    delete ephemeral[outcome.runId];
    next = {
      ...next,
      outcomes: [
        ...next.outcomes.filter((item) => item.runId !== outcome.runId),
        outcome,
      ],
      ephemeralByRun: ephemeral,
    };
  }
  return next;
}

export function applyEphemeral(
  current: Projection,
  runId: string,
  text: string,
): Projection {
  return {
    ...current,
    ephemeralByRun: { ...current.ephemeralByRun, [runId]: text },
  };
}

export function withConnection(
  current: Projection,
  connection: Projection["connection"],
): Projection {
  return { ...current, connection, sensitiveReady: connection === "live" };
}

export function withDraft(
  current: Projection,
  sessionId: string,
  text: string,
): Projection {
  return { ...current, drafts: { ...current.drafts, [sessionId]: text } };
}

export function projectionFromStored(stored: unknown): Projection | null {
  if (!stored || typeof stored !== "object") return null;
  const value = stored as {
    version?: number;
    projection?: Projection;
    cursor?: string | null;
  };
  if (value.version !== 1 || !value.projection) return null;
  return {
    ...emptyProjection(),
    ...value.projection,
    cursor: value.cursor ?? value.projection.cursor,
    ephemeralByRun: {},
    connection: "idle",
    sensitiveReady: false,
  };
}

function statusFromEvent(
  type: string,
  fallback: RunView["status"],
): RunView["status"] {
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled" || type === "run.cancel_accepted")
    return "cancelled";
  if (type === "run.timed_out") return "timed_out";
  if (type === "approval.requested") return "awaiting_approval";
  if (type === "run.started") return "running";
  return fallback;
}

function toolStatus(type: string, fallback: string): string {
  if (type === "tool.completed") return "succeeded";
  if (type === "tool.failed") return "failed";
  if (type === "tool.blocked") return "blocked";
  if (type === "tool.outcome_unknown") return "outcome_unknown";
  if (type === "tool.started")
    return fallback === "intent" ? "intent" : fallback;
  return fallback;
}
