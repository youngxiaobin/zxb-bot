import type {
  ApprovalView,
  MessageView,
  OutcomeView,
  RunView,
  SessionView,
  SpecialistView,
  ToolView,
} from "@pa/contracts";
import { PROJECTION_VERSION } from "@pa/contracts";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline"
  | "unauthorized";

export type Projection = {
  version: typeof PROJECTION_VERSION;
  connection: ConnectionState;
  cursor: string | null;
  self: { userId: string; deviceId: string } | null;
  sessions: SessionView[];
  messages: Record<string, MessageView[]>;
  runs: Record<string, RunView>;
  tools: Record<string, ToolView>;
  specialists: Record<string, SpecialistView[]>;
  approvals: ApprovalView[];
  outcomes: OutcomeView[];
  ephemeralByRun: Record<string, string>;
  drafts: Record<string, string>;
  lastError: { code: string; message: string } | null;
  eventIds: string[];
  sensitiveReady: boolean;
};

export function emptyProjection(): Projection {
  return {
    version: PROJECTION_VERSION,
    connection: "idle",
    cursor: null,
    self: null,
    sessions: [],
    messages: {},
    runs: {},
    tools: {},
    specialists: {},
    approvals: [],
    outcomes: [],
    ephemeralByRun: {},
    drafts: {},
    lastError: null,
    eventIds: [],
    sensitiveReady: false,
  };
}
