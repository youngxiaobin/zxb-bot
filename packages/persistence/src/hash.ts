import { createHash } from "node:crypto";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function commandPayloadHash(input: {
  type: string;
  payload: unknown;
}): string {
  const payload = input.payload as Record<string, unknown>;
  return sha256Json({
    protocol: "pa.command.v1",
    operation: input.type,
    targetSessionId:
      typeof payload.sessionId === "string" ? payload.sessionId : null,
    targetRunId: typeof payload.runId === "string" ? payload.runId : null,
    targetApprovalId:
      typeof payload.approvalId === "string" ? payload.approvalId : null,
    payload: input.payload,
  });
}
