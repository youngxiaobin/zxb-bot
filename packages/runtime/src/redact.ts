const SECRET_KEY =
  /api[-_]?key|token|secret|password|authorization|credential/i;

export function redactValue(value: unknown, secrets: string[]): unknown {
  const hidden = secrets.filter((secret) => secret.length >= 8);
  const scrub = (input: unknown): unknown => {
    if (typeof input === "string") {
      let text = input;
      for (const secret of hidden) text = text.split(secret).join("[redacted]");
      return text;
    }
    if (Array.isArray(input)) return input.map((item) => scrub(item));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(
        input as Record<string, unknown>,
      )) {
        out[key] = SECRET_KEY.test(key) ? "[redacted]" : scrub(item);
      }
      return out;
    }
    return input;
  };
  return scrub(value);
}
