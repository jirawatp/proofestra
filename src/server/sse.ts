// Server-Sent Events writer with heartbeats, resume support, and monotonic
// sequence guards. Writes raw SSE frames to a Node writable stream obtained
// from Fastify.

import type { EventEnvelope } from "../shared/types.js";

export class SseWriter {
  private closed = false;
  private lastSent = 0;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly write: (chunk: string) => void, heartbeatMs = 15_000) {
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      try {
        this.write(`: heartbeat\n\n`);
      } catch {
        this.close();
      }
    }, heartbeatMs);
    this.heartbeat.unref?.();
  }

  send(event: EventEnvelope): boolean {
    if (this.closed) return false;
    // Drop events that are out of order or already sent so the client always
    // sees monotonically increasing sequence ids. Replays after reconnect are
    // delivered in order by the caller; late emissions from a mutated bus
    // past the resume point are suppressed here.
    if (event.sequence <= this.lastSent) return false;
    const payload = {
      run_id: event.run_id,
      sequence: event.sequence,
      type: event.type,
      at: event.at,
      data: event.data,
    };
    const lines = [
      `id: ${event.sequence}`,
      `event: ${event.type}`,
      `data: ${JSON.stringify(payload)}`,
      "",
      "",
    ].join("\n");
    try {
      this.write(lines);
      this.lastSent = event.sequence;
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get maxSequenceSent(): number {
    return this.lastSent;
  }
}
