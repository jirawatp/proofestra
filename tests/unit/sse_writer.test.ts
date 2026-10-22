// SseWriter: framing, monotonic sequence guard, heartbeat, and fail-closed
// behaviour when the underlying socket write throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SseWriter } from "../../src/server/sse.js";
import type { EventEnvelope } from "../../src/shared/types.js";

const ev = (sequence: number, type = "run.updated", data: unknown = { n: sequence }): EventEnvelope =>
  ({ run_id: "run-1", sequence, type, at: "2026-01-01T00:00:00.000Z", data }) as EventEnvelope;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SseWriter", () => {
  it("frames an event as id/event/data lines ending with a blank line", () => {
    const chunks: string[] = [];
    const w = new SseWriter((c) => chunks.push(c));
    expect(w.send(ev(1))).toBe(true);
    expect(chunks).toHaveLength(1);
    const lines = chunks[0]!.split("\n");
    expect(lines[0]).toBe("id: 1");
    expect(lines[1]).toBe("event: run.updated");
    expect(JSON.parse(lines[2]!.replace(/^data: /, ""))).toEqual({
      run_id: "run-1",
      sequence: 1,
      type: "run.updated",
      at: "2026-01-01T00:00:00.000Z",
      data: { n: 1 },
    });
    expect(chunks[0]!.endsWith("\n\n")).toBe(true);
    expect(w.maxSequenceSent).toBe(1);
    w.close();
  });

  it("drops duplicate and backward sequences but accepts gaps forward", () => {
    const chunks: string[] = [];
    const w = new SseWriter((c) => chunks.push(c));
    expect(w.send(ev(2))).toBe(true);
    expect(w.send(ev(2))).toBe(false);
    expect(w.send(ev(1))).toBe(false);
    expect(w.send(ev(5))).toBe(true);
    expect(chunks).toHaveLength(2);
    expect(w.maxSequenceSent).toBe(5);
    w.close();
  });

  it("writes a comment heartbeat on the configured interval until closed", () => {
    const chunks: string[] = [];
    const w = new SseWriter((c) => chunks.push(c), 1_000);
    vi.advanceTimersByTime(3_000);
    expect(chunks).toEqual([": heartbeat\n\n", ": heartbeat\n\n", ": heartbeat\n\n"]);
    w.close();
    vi.advanceTimersByTime(5_000);
    expect(chunks).toHaveLength(3);
  });

  it("uses a 15 s default heartbeat", () => {
    const chunks: string[] = [];
    const w = new SseWriter((c) => chunks.push(c));
    vi.advanceTimersByTime(14_999);
    expect(chunks).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(chunks).toHaveLength(1);
    w.close();
  });

  it("closes itself when a heartbeat write throws and stops beating", () => {
    let calls = 0;
    const w = new SseWriter(() => {
      calls += 1;
      throw new Error("EPIPE");
    }, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(w.isClosed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(calls).toBe(1);
  });

  it("closes and reports false when an event write throws, without advancing the sequence", () => {
    let fail = false;
    const chunks: string[] = [];
    const w = new SseWriter((c) => {
      if (fail) throw new Error("socket gone");
      chunks.push(c);
    });
    expect(w.send(ev(1))).toBe(true);
    fail = true;
    expect(w.send(ev(2))).toBe(false);
    expect(w.isClosed).toBe(true);
    expect(w.maxSequenceSent).toBe(1);
  });

  it("refuses sends after close and close is idempotent", () => {
    const chunks: string[] = [];
    const w = new SseWriter((c) => chunks.push(c), 500);
    expect(w.isClosed).toBe(false);
    w.close();
    w.close();
    expect(w.isClosed).toBe(true);
    expect(w.send(ev(1))).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(chunks).toEqual([]);
  });

  it("does not write a heartbeat after close even if the interval already fired", () => {
    const chunks: string[] = [];
    const w = new SseWriter((c) => chunks.push(c), 100);
    w.close();
    vi.advanceTimersByTime(1_000);
    expect(chunks).toEqual([]);
  });
});

describe("SseWriter timer edge cases", () => {
  it("works with a timer handle that has no unref (non-Node timers)", () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, "setInterval").mockReturnValue(7 as unknown as NodeJS.Timeout);
    const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    try {
      const w = new SseWriter(() => undefined);
      w.close();
      expect(clear).toHaveBeenCalledWith(7);
    } finally {
      spy.mockRestore();
      clear.mockRestore();
    }
  });

  it("a heartbeat tick that races with close writes nothing", () => {
    vi.useRealTimers();
    let tick: () => void = () => undefined;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
      tick = fn;
      return { unref() {} } as unknown as NodeJS.Timeout;
    }) as never);
    const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    try {
      const chunks: string[] = [];
      const w = new SseWriter((c) => chunks.push(c));
      w.close();
      tick();
      expect(chunks).toEqual([]);
    } finally {
      spy.mockRestore();
      clear.mockRestore();
    }
  });
});
