// Focused regression tests for the composer opaque-ready-id order
// store. The exact production regression they guard against is the
// mixed-8 reload order loss:
//
//   1. User's current tab arranged 8 ready attachments in this order:
//      unknown.bin, docx, pdf, mp4, wav, zip, txt, png.
//   2. User reloads. The initial render has `composerAttachments === []`.
//   3. Without the `shouldPersistComposerOrder` hydration gate, the
//      order-write effect runs on that empty render and persists `[]`
//      to `proofestra:composer-order:v1`.
//   4. The async `listAttachments(activeId)` resolves AFTER the
//      overwrite, merges 8 server rows in the server's default
//      `ORDER BY created_at`, and the UI shows the regression where
//      the mixed-8 reorders to `pdf, mp4, zip, wav, txt, png,
//      unknown.bin, docx`.
//
// We test the SAME sequence through the pure helpers:
//   - `shouldPersistComposerOrder` is the gate.
//   - `writeComposerOrder` and `readComposerOrder` round-trip the
//     opaque ids under `proofestra:composer-order:v1`.
//   - `orderServerListByLocal` is the merge the rehydration effect
//     applies after the fetch resolves.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  COMPOSER_ORDER_STORAGE_KEY,
  readComposerOrder,
  writeComposerOrder,
  orderServerListByLocal,
  shouldPersistComposerOrder,
} from "../../src/web/composerOrder.js";
import type { AttachmentDto } from "../../src/web/api.js";

// Minimal in-memory `localStorage` + `window` stub. Vitest runs with
// `environment: "node"` so there is no real `window` by default.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
  get length(): number {
    return this.store.size;
  }
  key(_i: number): string | null {
    return null;
  }
}

function installWindow(): MemoryStorage {
  const storage = new MemoryStorage();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = { localStorage: storage };
  return storage;
}

function uninstallWindow(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
}

function fakeDto(id: string, displayName: string, mime = "application/octet-stream"): AttachmentDto {
  return {
    id,
    conversation_id: "11111111-1111-4111-8111-111111111111",
    sanitized_display_name: displayName,
    sniffed_mime: mime,
    kind: "binary",
    byte_size: 100,
    content_sha256: "0".repeat(64),
    extraction_status: "unsupported",
    extraction_coverage: { extracted_chars: 0, truncated: false, label: "download only" },
    state: "ready",
    created_at: new Date().toISOString(),
    bound_at: null,
    failure: null,
  };
}

const CONV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Mixed-8 fixture matching the production regression.
const idUnknown = "11111111-1111-4111-8111-111111111111";
const idDocx = "22222222-2222-4222-8222-222222222222";
const idPdf = "33333333-3333-4333-8333-333333333333";
const idMp4 = "44444444-4444-4444-8444-444444444444";
const idWav = "55555555-5555-4555-8555-555555555555";
const idZip = "66666666-6666-4666-8666-666666666666";
const idTxt = "77777777-7777-4777-8777-777777777777";
const idPng = "88888888-8888-4888-8888-888888888888";

const SAVED_MIXED8_ORDER = [idUnknown, idDocx, idPdf, idMp4, idWav, idZip, idTxt, idPng];
const SERVER_DEFAULT_ORDER = [idPdf, idMp4, idZip, idWav, idTxt, idPng, idUnknown, idDocx];

function mixed8ServerItems(): AttachmentDto[] {
  // Server's "default" order mirrors the exact scrambled order the
  // production regression surfaced on reload.
  return [
    fakeDto(idPdf, "doc.pdf", "application/pdf"),
    fakeDto(idMp4, "clip.mp4", "video/mp4"),
    fakeDto(idZip, "bundle.zip", "application/zip"),
    fakeDto(idWav, "audio.wav", "audio/wav"),
    fakeDto(idTxt, "notes.txt", "text/plain"),
    fakeDto(idPng, "image.png", "image/png"),
    fakeDto(idUnknown, "unknown.bin", "application/octet-stream"),
    fakeDto(idDocx, "report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
  ];
}

describe("shouldPersistComposerOrder — hydration gate", () => {
  it("refuses to persist when activeId is null", () => {
    expect(shouldPersistComposerOrder(null, null)).toBe(false);
    expect(shouldPersistComposerOrder(null, CONV_A)).toBe(false);
  });
  it("refuses to persist when hydratedForConversationId is null (initial empty render)", () => {
    expect(shouldPersistComposerOrder(CONV_A, null)).toBe(false);
  });
  it("refuses to persist when activeId !== hydratedForConversationId (chat switch in flight)", () => {
    expect(shouldPersistComposerOrder(CONV_B, CONV_A)).toBe(false);
  });
  it("permits persistence only once hydration completes for the active conversation", () => {
    expect(shouldPersistComposerOrder(CONV_A, CONV_A)).toBe(true);
    expect(shouldPersistComposerOrder(CONV_B, CONV_B)).toBe(true);
  });
});

describe("mixed-8 initial-empty-then-rehydrate reload regression", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = installWindow();
  });
  afterEach(() => {
    uninstallWindow();
  });

  it("preserves the saved mixed-8 order across a reload when the write effect is correctly gated", () => {
    // Preload: a prior session persisted the mixed-8 order.
    writeComposerOrder(CONV_A, SAVED_MIXED8_ORDER);
    expect(storage.getItem(COMPOSER_ORDER_STORAGE_KEY)).toContain(idUnknown);

    // --- Reload begins ---
    // Step 1: the initial render fires the order-write effect with an
    // empty composer. The gate (shouldPersistComposerOrder) MUST return
    // false here because hydration has not completed.
    const activeIdOnMount: string | null = CONV_A;
    const hydratedForOnMount: string | null = null;
    expect(shouldPersistComposerOrder(activeIdOnMount, hydratedForOnMount)).toBe(false);
    // Simulate: because the gate refused, writeComposerOrder is NEVER
    // called. The saved order survives.
    const orderAfterInitialRender = readComposerOrder();
    expect(orderAfterInitialRender[CONV_A]).toEqual(SAVED_MIXED8_ORDER);

    // Step 2: the async `listAttachments(activeId)` resolves. The
    // rehydration effect merges the server list using the saved order.
    const serverItems = mixed8ServerItems();
    const orderedByLocal = orderServerListByLocal(serverItems, orderAfterInitialRender[CONV_A]);
    const displayedOrder = orderedByLocal.map((dto) => dto.id);
    expect(displayedOrder).toEqual(SAVED_MIXED8_ORDER);

    // Step 3: the hydration ref flips. The next composerAttachments
    // state change allows the write effect to persist the merged
    // order, which is identical to the saved order.
    const hydratedForAfterMerge: string | null = CONV_A;
    expect(shouldPersistComposerOrder(activeIdOnMount, hydratedForAfterMerge)).toBe(true);
    writeComposerOrder(CONV_A, displayedOrder);
    const orderAfterRehydrate = readComposerOrder();
    expect(orderAfterRehydrate[CONV_A]).toEqual(SAVED_MIXED8_ORDER);
  });

  it("documents the pre-fix regression: an un-gated write BEFORE rehydration clobbers the saved order with []", () => {
    // Preload the saved order.
    writeComposerOrder(CONV_A, SAVED_MIXED8_ORDER);

    // Simulate the pre-fix behaviour: the effect wrote the empty
    // composer immediately on initial render, without the gate.
    writeComposerOrder(CONV_A, []);

    // The saved order is now wiped under this conversation key.
    const after = readComposerOrder();
    expect(after[CONV_A]).toBeUndefined();

    // The rehydration merge then falls back to the server default order,
    // which is the scrambled sequence the user saw in production.
    const serverItems = mixed8ServerItems();
    const orderedByLocal = orderServerListByLocal(serverItems, after[CONV_A]);
    const displayedOrder = orderedByLocal.map((dto) => dto.id);
    expect(displayedOrder).toEqual(SERVER_DEFAULT_ORDER);
    // Spelled out: `pdf, mp4, zip, wav, txt, png, unknown.bin, docx`
    // is NOT the user's mixed-8 arrangement.
    expect(displayedOrder).not.toEqual(SAVED_MIXED8_ORDER);
  });

  it("chat switch: a slow in-flight write for conversation A cannot clobber conversation B's saved order", () => {
    writeComposerOrder(CONV_A, [idPdf, idPng]);
    writeComposerOrder(CONV_B, [idMp4, idDocx, idWav]);

    // User switches from A to B. The rehydration effect for B has not
    // yet completed; the gate must refuse while hydratedFor === A but
    // activeId === B.
    expect(shouldPersistComposerOrder(CONV_B, CONV_A)).toBe(false);

    // Confirm no write occurs — storage still holds both saved orders.
    const snapshot = readComposerOrder();
    expect(snapshot[CONV_A]).toEqual([idPdf, idPng]);
    expect(snapshot[CONV_B]).toEqual([idMp4, idDocx, idWav]);
  });

  it("storage caps at 16 ids per conversation and strips malformed entries", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) =>
      `${(i + 1).toString().padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    const seventeen = [...sixteen, "99999999-9999-4999-8999-999999999999"];
    writeComposerOrder(CONV_A, seventeen);
    const back = readComposerOrder();
    expect(back[CONV_A]?.length).toBe(16);
    expect(back[CONV_A]).toEqual(sixteen);
  });

  it("filters path separators, HTML metacharacters, control bytes, and length outliers on read", () => {
    // Pretend an attacker (or a bad migration) injected shapes that
    // would have let a file name, path, or script fragment slip into
    // the stored list. The reader's shape filter MUST drop them.
    // Opaque-id-shaped strings (`[A-Za-z0-9_-]{8,64}`) are the only
    // thing we ever persist and the only thing we accept on read.
    const injected = JSON.stringify({
      version: 1,
      byConversation: {
        [CONV_A]: [
          idPdf,
          "../../etc/passwd", // path separator
          "<script>alert(1)</script>", // HTML metacharacters
          "has space inside", // whitespace
          "has/slash", // path separator
          "has\\back", // Windows separator
          "has.dot", // not in charset
          "a", // too short
          "x".repeat(65), // too long
          "control\u0001byte", // control + non-allowed char
          idPng,
          idMp4,
        ],
      },
    });
    storage.setItem(COMPOSER_ORDER_STORAGE_KEY, injected);
    const back = readComposerOrder();
    expect(back[CONV_A]).toEqual([idPdf, idPng, idMp4]);
  });
});
