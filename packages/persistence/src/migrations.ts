import { createHash } from "node:crypto";

export const MIGRATION_VERSION = 1;
export const MIGRATION_NAME = "001_init";

export const MIGRATION_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE channels (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
);

CREATE TABLE pairing_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_device_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE sessions (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (channel_id, user_id) REFERENCES channels(id, user_id)
);

CREATE TABLE messages (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  run_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id)
);
CREATE INDEX messages_session_created ON messages(session_id, created_at);

CREATE TABLE runs (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('root', 'expert')),
  parent_run_id TEXT,
  specialist_role TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_approval','completed','failed','cancelled','timed_out')),
  result_code TEXT,
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('demo','live')),
  script TEXT NOT NULL,
  stage TEXT NOT NULL,
  budget_total INTEGER NOT NULL,
  budget_reserved INTEGER NOT NULL DEFAULT 0,
  budget_used INTEGER NOT NULL DEFAULT 0,
  model_steps INTEGER NOT NULL DEFAULT 0,
  max_model_steps INTEGER NOT NULL,
  execution_budget_ms INTEGER NOT NULL,
  execution_used_ms INTEGER NOT NULL DEFAULT 0,
  active_deadline_at TEXT,
  cancel_requested_at TEXT,
  output_draft TEXT,
  terminal_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id),
  FOREIGN KEY (parent_run_id) REFERENCES runs(id),
  FOREIGN KEY (root_message_id, user_id) REFERENCES messages(id, user_id)
);
CREATE INDEX runs_session ON runs(session_id, created_at);
CREATE UNIQUE INDEX runs_one_active_root ON runs(session_id)
  WHERE kind = 'root' AND status IN ('queued','running','awaiting_approval');

CREATE TRIGGER runs_message_session_guard
BEFORE INSERT ON runs
WHEN NOT EXISTS (
  SELECT 1 FROM messages m
  WHERE m.id = NEW.root_message_id AND m.user_id = NEW.user_id AND m.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'run/message/session mismatch');
END;

CREATE TABLE session_grants (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, device_id),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id),
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
);

CREATE TABLE tool_calls (
  id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  root_run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  params_json TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intent','awaiting_approval','ready','dispatching','succeeded','failed','rejected','cancelled','outcome_unknown')),
  side_effect INTEGER NOT NULL CHECK (side_effect IN (0,1)),
  attempt INTEGER NOT NULL,
  approval_id TEXT,
  dispatch_claim_token TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  budget_counted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  UNIQUE (root_run_id, logical_key),
  FOREIGN KEY (run_id, user_id) REFERENCES runs(id, user_id),
  FOREIGN KEY (root_run_id, user_id) REFERENCES runs(id, user_id),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id)
);
CREATE INDEX tool_calls_root_status ON tool_calls(root_run_id, status);

CREATE TRIGGER tool_run_session_guard
BEFORE INSERT ON tool_calls
WHEN NOT EXISTS (
  SELECT 1 FROM runs r
  WHERE r.id = NEW.run_id AND r.user_id = NEW.user_id AND r.session_id = NEW.session_id
)
OR NOT EXISTS (
  SELECT 1 FROM runs root
  WHERE root.id = NEW.root_run_id AND root.user_id = NEW.user_id AND root.session_id = NEW.session_id AND root.kind = 'root'
)
BEGIN
  SELECT RAISE(ABORT, 'tool/run/session mismatch');
END;

CREATE TABLE approvals (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  params_json TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  decision TEXT,
  version INTEGER NOT NULL,
  decided_by_device_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (id),
  UNIQUE (id, user_id),
  FOREIGN KEY (run_id, user_id) REFERENCES runs(id, user_id),
  FOREIGN KEY (tool_call_id, user_id) REFERENCES tool_calls(id, user_id),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id)
);
CREATE UNIQUE INDEX approvals_one_pending ON approvals(tool_call_id) WHERE status = 'pending';
CREATE INDEX approvals_user_status ON approvals(user_id, status);

CREATE TABLE expert_tasks (
  id TEXT NOT NULL,
  root_run_id TEXT NOT NULL,
  expert_run_id TEXT,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (root_run_id, role),
  FOREIGN KEY (root_run_id, user_id) REFERENCES runs(id, user_id),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  session_id TEXT,
  run_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_user_seq ON events(user_id, seq);
CREATE INDEX events_session_seq ON events(session_id, seq);

CREATE TABLE command_receipts (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE effect_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_call_id TEXT NOT NULL,
  root_run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id)
);
CREATE INDEX effect_log_root ON effect_log(root_run_id);

CREATE TABLE executor_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fencing_token INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  heartbeat_at TEXT NOT NULL
);
`;

export function migrationChecksum(): string {
  return createHash("sha256").update(MIGRATION_SQL).digest("hex");
}
