import { randomUUID, createHash } from "node:crypto";

export function newUuid(): string {
  return randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestOf(payload: unknown): string {
  return `sha256:${sha256Hex(stableStringify(payload))}`;
}

/**
 * Deterministic JSON serialization: object keys sorted alphabetically, no extra
 * whitespace. Used for idempotency key digests and tool argument digests.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number cannot be stably serialized");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((key) => JSON.stringify(key) + ":" + stableStringify(obj[key]))
        .join(",") +
      "}"
    );
  }
  if (typeof value === "undefined") {
    return "null";
  }
  throw new Error(`cannot stably serialize ${typeof value}`);
}
