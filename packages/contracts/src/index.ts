import { z } from "zod";

export const PROTOCOL = "pa.command.v1" as const;
export const EVENT_PROTOCOL = "pa.event.v1" as const;
export const WS_PROTOCOL = "pa.ws.v1" as const;
export const WORKFLOW_VERSION = "pa-workflow.v1" as const;
export const CHECKPOINT_COMPAT = "langgraph-sqlite-saver.v1" as const;
export const SCHEMA_VERSION = 1 as const;
export const PROJECTION_VERSION = 1 as const;
export const MAX_EXPERT_FANOUT = 2 as const;
export const DEFAULT_TOOL_BUDGET = 30 as const;

export const TOOL_LIST = "list_fixtures" as const;
export const TOOL_READ = "read_fixture" as const;
export const TOOL_WRITE = "write_demo_note" as const;
export const TOOL_LIST_VERSION = "list-fixtures.v1" as const;
export const TOOL_READ_VERSION = "read-fixture.v1" as const;
export const TOOL_WRITE_VERSION = "write-demo-note.v1" as const;

export const ErrorCodes = {
  MALFORMED: "MALFORMED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  PAYLOAD_CONFLICT: "PAYLOAD_CONFLICT",
  SESSION_BUSY: "SESSION_BUSY",
  SESSION_NOT_GRANTED: "SESSION_NOT_GRANTED",
  CURSOR_MALFORMED: "CURSOR_MALFORMED",
  CURSOR_FUTURE: "CURSOR_FUTURE",
  CURSOR_EXPIRED: "CURSOR_EXPIRED",
  CURSOR_UNAUTHORIZED: "CURSOR_UNAUTHORIZED",
  STALE_APPROVAL_VERSION: "STALE_APPROVAL_VERSION",
  APPROVAL_BINDING_MISMATCH: "APPROVAL_BINDING_MISMATCH",
  DECISION_CONFLICT: "DECISION_CONFLICT",
  APPROVAL_EXPIRED: "APPROVAL_EXPIRED",
  RUN_CANCELLED: "RUN_CANCELLED",
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  FENCE_LOST: "FENCE_LOST",
  PAIRING_INVALID: "PAIRING_INVALID",
  PAIRING_CONSUMED: "PAIRING_CONSUMED",
  PAIRING_EXPIRED: "PAIRING_EXPIRED",
  LOOPBACK_ONLY: "LOOPBACK_ONLY",
  UNSAFE_LAN_DISABLED: "UNSAFE_LAN_DISABLED",
  TOKEN_QUERY_FORBIDDEN: "TOKEN_QUERY_FORBIDDEN",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  RUN_DEADLINE: "RUN_DEADLINE",
  MODEL_STEP_LIMIT: "MODEL_STEP_LIMIT",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  PATH_REJECTED: "PATH_REJECTED",
  TEST_HOOKS_DISABLED: "TEST_HOOKS_DISABLED",
  OFFLINE: "OFFLINE",
  EXECUTOR_BUSY: "EXECUTOR_BUSY",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

const protocolField = z.literal(PROTOCOL);
const commandMeta = {
  protocol: protocolField,
  commandId: IdSchema,
  idempotencyKey: IdSchema,
};

export const CommandSchema = z.discriminatedUnion("type", [
  z.object({
    ...commandMeta,
    type: z.literal("session.open"),
    payload: z.object({ title: z.string().min(1).max(80).optional() }).strict(),
  }),
  z.object({
    ...commandMeta,
    type: z.literal("session.resume"),
    payload: z.object({ sessionId: IdSchema }).strict(),
  }),
  z.object({
    ...commandMeta,
    type: z.literal("message.submit"),
    payload: z
      .object({
        sessionId: IdSchema,
        text: z.string().min(1).max(16_000),
        providerMode: z.enum(["demo", "live"]),
      })
      .strict(),
  }),
  z.object({
    ...commandMeta,
    type: z.literal("run.cancel"),
    payload: z.object({ runId: IdSchema }).strict(),
  }),
  z.object({
    ...commandMeta,
    type: z.literal("approval.decide"),
    payload: z
      .object({
        approvalId: IdSchema,
        decision: z.enum(["approve", "reject"]),
        expectedVersion: z.number().int().positive(),
        paramsHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  }),
  z.object({
    ...commandMeta,
    type: z.literal("device.revoke"),
    payload: z.object({ deviceId: IdSchema }).strict(),
  }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command["type"];

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const CommandReceiptSchema = z.object({
  protocol: z.literal(PROTOCOL),
  commandId: IdSchema,
  idempotencyKey: IdSchema,
  replayed: z.boolean(),
  result: z.unknown(),
});
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const OWNER_VISIBLE_EVENTS = [
  "approval.requested",
  "approval.resolved",
  "approval.expired",
  "run.outcome",
  "device.revoked",
] as const;

export const EventTypeSchema = z.enum([
  "session.opened",
  "session.resumed",
  "message.user.created",
  "run.started",
  "run.model_step",
  "specialist.started",
  "specialist.completed",
  "specialist.failed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.blocked",
  "tool.outcome_unknown",
  "approval.requested",
  "approval.resolved",
  "approval.expired",
  "message.assistant.completed",
  "run.cancel_accepted",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.timed_out",
  "run.outcome",
  "device.revoked",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const DurableEventSchema = z.object({
  protocol: z.literal(EVENT_PROTOCOL),
  eventId: IdSchema,
  seq: z.number().int().positive(),
  cursor: z.string().min(8),
  userId: IdSchema,
  channelId: IdSchema.nullable(),
  sessionId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  taskId: IdSchema.nullable(),
  type: EventTypeSchema,
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type DurableEvent = z.infer<typeof DurableEventSchema>;

export const EphemeralPreviewSchema = z.object({
  type: z.literal("ephemeral.preview"),
  runId: IdSchema,
  text: z.string(),
});
export type EphemeralPreview = z.infer<typeof EphemeralPreviewSchema>;

export const SessionViewSchema = z.object({
  id: IdSchema,
  title: z.string(),
  channelId: IdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const MessageViewSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema.nullable(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});
export const RunViewSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  kind: z.enum(["root", "expert"]),
  parentRunId: IdSchema.nullable(),
  specialistRole: z.string().nullable(),
  status: z.enum([
    "queued",
    "running",
    "awaiting_approval",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  resultCode: z.string().nullable(),
  providerMode: z.enum(["demo", "live"]),
  stage: z.string(),
  budgetTotal: z.number().int(),
  budgetReserved: z.number().int(),
  budgetUsed: z.number().int(),
  modelSteps: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ToolViewSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  rootRunId: IdSchema,
  toolName: z.string(),
  toolVersion: z.string(),
  resource: z.string(),
  params: z.unknown(),
  paramsHash: z.string(),
  status: z.string(),
  sideEffect: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  result: z.unknown().nullable(),
});
export const SpecialistViewSchema = z.object({
  id: IdSchema,
  rootRunId: IdSchema,
  role: z.string(),
  status: z.string(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  output: z.unknown().nullable(),
});
export const ApprovalViewSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  sessionId: IdSchema,
  toolCallId: IdSchema,
  toolName: z.string(),
  toolVersion: z.string(),
  resource: z.string(),
  params: z.unknown(),
  paramsHash: z.string(),
  status: z.string(),
  decision: z.string().nullable(),
  version: z.number().int(),
  expiresAt: z.string(),
});
export const OutcomeViewSchema = z.object({
  runId: IdSchema,
  sessionId: IdSchema.nullable(),
  resultCode: z.string(),
  effect: z.enum(["none", "applied", "unknown"]),
  resource: z.string().nullable(),
  excerpt: z.string(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;
export type MessageView = z.infer<typeof MessageViewSchema>;
export type RunView = z.infer<typeof RunViewSchema>;
export type ToolView = z.infer<typeof ToolViewSchema>;
export type SpecialistView = z.infer<typeof SpecialistViewSchema>;
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;
export type OutcomeView = z.infer<typeof OutcomeViewSchema>;

export const SnapshotSchema = z.object({
  protocol: z.literal(EVENT_PROTOCOL),
  watermarkCursor: z.string().nullable(),
  watermarkSeq: z.number().int().nonnegative(),
  deviceId: IdSchema,
  userId: IdSchema,
  sessions: z.array(SessionViewSchema),
  messages: z.array(MessageViewSchema),
  runs: z.array(RunViewSchema),
  tools: z.array(ToolViewSchema),
  specialists: z.array(SpecialistViewSchema),
  approvals: z.array(ApprovalViewSchema),
  outcomes: z.array(OutcomeViewSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello.ok"),
    protocol: z.literal(WS_PROTOCOL),
    deviceId: IdSchema,
    userId: IdSchema,
  }),
  z.object({
    type: z.literal("hello.error"),
    code: z.string(),
    message: z.string(),
  }),
  z.object({ type: z.literal("ping"), nonce: z.string() }),
  z.object({
    type: z.literal("subscribed"),
    watermarkCursor: z.string().nullable(),
    replayed: z.number().int(),
  }),
  z.object({ type: z.literal("snapshot"), snapshot: SnapshotSchema }),
  z.object({ type: z.literal("event"), event: DurableEventSchema }),
  z.object({ type: z.literal("ephemeral"), ephemeral: EphemeralPreviewSchema }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(WS_PROTOCOL),
  token: z.string().min(20),
});
export const SubscribeSchema = z.object({
  type: z.literal("subscribe"),
  cursor: z.string().min(8).nullable().optional(),
});
export const PongSchema = z.object({
  type: z.literal("pong"),
  nonce: z.string(),
});

export const FaultNameSchema = z.enum([
  "clear",
  "effect_succeed_then_crash_before_result",
  "exit_after_approval_before_resume",
  "skip_checkpoint_advance",
  "delay_before_tool_effect",
  "hold_before_effect",
  "hold_after_effect",
  "drop_response_once",
  "delay_replay",
]);
export type FaultName = z.infer<typeof FaultNameSchema>;

export function isOwnerVisibleEvent(type: string): boolean {
  return (OWNER_VISIBLE_EVENTS as readonly string[]).includes(type);
}

export function httpStatusForCode(code: string): number {
  switch (code) {
    case ErrorCodes.MALFORMED:
    case ErrorCodes.CURSOR_MALFORMED:
    case ErrorCodes.TOKEN_QUERY_FORBIDDEN:
    case ErrorCodes.PAIRING_INVALID:
      return 400;
    case ErrorCodes.UNAUTHORIZED:
      return 401;
    case ErrorCodes.FORBIDDEN:
    case ErrorCodes.CURSOR_UNAUTHORIZED:
    case ErrorCodes.SESSION_NOT_GRANTED:
    case ErrorCodes.LOOPBACK_ONLY:
      return 403;
    case ErrorCodes.NOT_FOUND:
    case ErrorCodes.TEST_HOOKS_DISABLED:
      return 404;
    case ErrorCodes.PAYLOAD_CONFLICT:
    case ErrorCodes.SESSION_BUSY:
    case ErrorCodes.CURSOR_FUTURE:
    case ErrorCodes.STALE_APPROVAL_VERSION:
    case ErrorCodes.APPROVAL_BINDING_MISMATCH:
    case ErrorCodes.DECISION_CONFLICT:
    case ErrorCodes.RUN_CANCELLED:
    case ErrorCodes.PROVIDER_NOT_CONFIGURED:
    case ErrorCodes.PAIRING_CONSUMED:
      return 409;
    case ErrorCodes.CURSOR_EXPIRED:
    case ErrorCodes.PAIRING_EXPIRED:
    case ErrorCodes.APPROVAL_EXPIRED:
      return 410;
    case ErrorCodes.FENCE_LOST:
    case ErrorCodes.EXECUTOR_BUSY:
      return 503;
    default:
      return 400;
  }
}
