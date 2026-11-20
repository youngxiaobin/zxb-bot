import { createHmac, timingSafeEqual } from "node:crypto";

export type CursorClaims = {
  v: 1;
  epoch: string;
  seq: number;
  principalId: string;
  exp: number;
};

export function signCursor(claims: CursorClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `pa1.${body}.${mac}`;
}

export type CursorCheck =
  | { ok: true; claims: CursorClaims }
  | {
      ok: false;
      code:
        | "CURSOR_MALFORMED"
        | "CURSOR_EXPIRED"
        | "CURSOR_UNAUTHORIZED"
        | "CURSOR_FUTURE";
    };

export function verifyCursor(
  token: string,
  secret: string,
  expected: {
    epoch: string;
    principalId: string;
    maxSeq: number;
    nowMs: number;
  },
): CursorCheck {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "pa1" || !parts[1] || !parts[2]) {
    return { ok: false, code: "CURSOR_MALFORMED" };
  }
  const expectedMac = createHmac("sha256", secret)
    .update(parts[1])
    .digest("base64url");
  const left = Buffer.from(parts[2]);
  const right = Buffer.from(expectedMac);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, code: "CURSOR_MALFORMED" };
  }
  let claims: CursorClaims;
  try {
    claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as CursorClaims;
  } catch {
    return { ok: false, code: "CURSOR_MALFORMED" };
  }
  if (
    claims.v !== 1 ||
    typeof claims.seq !== "number" ||
    !Number.isInteger(claims.seq) ||
    claims.seq < 0
  ) {
    return { ok: false, code: "CURSOR_MALFORMED" };
  }
  if (claims.principalId !== expected.principalId)
    return { ok: false, code: "CURSOR_UNAUTHORIZED" };
  if (claims.epoch !== expected.epoch || claims.exp < expected.nowMs)
    return { ok: false, code: "CURSOR_EXPIRED" };
  if (claims.seq > expected.maxSeq) return { ok: false, code: "CURSOR_FUTURE" };
  return { ok: true, claims };
}
