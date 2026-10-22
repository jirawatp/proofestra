import { describe, it, expect } from "vitest";
import { digestOf, stableStringify } from "../../src/shared/ids.js";

describe("stableStringify", () => {
  it("sorts object keys deterministically", () => {
    const a = stableStringify({ a: 1, b: { d: 4, c: 3 } });
    const b = stableStringify({ b: { c: 3, d: 4 }, a: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":{"c":3,"d":4}}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => stableStringify({ x: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => stableStringify({ x: Number.NaN })).toThrow();
  });

  it("digest is identical for key-reordered payloads", () => {
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(digestOf({ a: 1, b: 2 })).not.toBe(digestOf({ a: 1, b: 3 }));
  });
});
