// Opaque per-conversation ordered list of READY attachment ids. The UI
// persists ONLY this list — never file bytes, display names, mime types,
// extracted text, or secrets. The server's `/attachments` list is still
// the source of truth; this storage records only the ORDER in which the
// current tab arranged those ids, which is otherwise non-deterministic
// after a hard reload because the backend sorts by `created_at` (ties
// are broken differently in Chrome / Safari / Firefox). On merge the
// server list wins for identity; the local order wins for arrangement.
//
// Extracted from `App.tsx` so the pure helpers can be unit-tested
// without a DOM harness.

import type { AttachmentDto } from "./api";

export const COMPOSER_ORDER_STORAGE_KEY = "proofestra:composer-order:v1";

interface ComposerOrderStorage {
  version: 1;
  byConversation: Record<string, string[]>;
}

export function readComposerOrder(): Record<string, string[]> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return {};
    const raw = window.localStorage.getItem(COMPOSER_ORDER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<ComposerOrderStorage>;
    if (parsed?.version !== 1 || typeof parsed.byConversation !== "object" || parsed.byConversation === null) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [cid, ids] of Object.entries(parsed.byConversation)) {
      if (typeof cid !== "string" || !Array.isArray(ids)) continue;
      // Enforce: UUID-shaped strings only, length-bounded, no duplicates.
      const safe: string[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        if (typeof id !== "string" || id.length < 8 || id.length > 64) continue;
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        safe.push(id);
        if (safe.length >= 16) break;
      }
      if (safe.length > 0) out[cid] = safe;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeComposerOrder(conversationId: string, orderedReadyIds: string[]): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const current = readComposerOrder();
    const next: ComposerOrderStorage = {
      version: 1,
      byConversation: { ...current, [conversationId]: orderedReadyIds.slice(0, 16) },
    };
    window.localStorage.setItem(COMPOSER_ORDER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private browsing / quota exceeded / disabled storage — degrade silently.
  }
}

export function orderServerListByLocal(
  serverItems: AttachmentDto[],
  localOrder: string[] | undefined,
): AttachmentDto[] {
  if (!localOrder || localOrder.length === 0) return serverItems;
  const byId = new Map<string, AttachmentDto>();
  for (const dto of serverItems) byId.set(dto.id, dto);
  const ordered: AttachmentDto[] = [];
  const seen = new Set<string>();
  // First: items in the local order that still exist on the server.
  for (const id of localOrder) {
    const dto = byId.get(id);
    if (!dto) continue;
    ordered.push(dto);
    seen.add(id);
  }
  // Then: any server items the local order did not mention (first time
  // seeing them on this tab, or they came from a different tab).
  for (const dto of serverItems) {
    if (seen.has(dto.id)) continue;
    ordered.push(dto);
  }
  return ordered;
}

/**
 * Hydration-aware gate for the opaque-ready-id order persister. Returns
 * true only when BOTH:
 *   - the active conversation is non-null, AND
 *   - the composer rehydration effect has completed for THIS exact
 *     active conversation (`hydratedForConversationId === activeId`).
 *
 * The regression this guards against:
 *   1. User opens a tab with a saved order of 8 ready ids under
 *      `proofestra:composer-order:v1`.
 *   2. The initial render has `composerAttachments === []`.
 *   3. Without the gate, the order-write effect fires on this first
 *      render and persists `[]` to the saved key.
 *   4. The async `listAttachments(activeId)` resolves AFTER that
 *      overwrite, merges 8 server rows in the server's default
 *      `ORDER BY created_at`, and the UI shows a scrambled order on
 *      next reload — the exact mixed-8 regression where
 *      `unknown.bin, docx, pdf, mp4, wav, zip, txt, png` reordered to
 *      `pdf, mp4, zip, wav, txt, png, unknown.bin, docx`.
 *
 * The flip side — a hydrated conversation whose active id just changed
 * to a new conversation — also returns false, which prevents a slow
 * in-flight update from the previous chat from clobbering the new
 * chat's saved order under its own key.
 */
export function shouldPersistComposerOrder(
  activeConversationId: string | null,
  hydratedForConversationId: string | null,
): boolean {
  if (activeConversationId === null) return false;
  if (hydratedForConversationId === null) return false;
  return hydratedForConversationId === activeConversationId;
}

/**
 * Settle a successful upload in the composer list. If hydration (the draft
 * list fetched right after a chat was created for the first file) added the
 * still-`uploading` SERVER row as a second card the local card could not match
 * yet, both cards would share `dto.id` after the 201 and Send would fail with
 * `duplicate attachment id`. Every OTHER card whose `serverId` or `localId`
 * equals the returned id is dropped, and the local card is marked ready IN ITS
 * ORIGINAL POSITION, so the composer order is preserved.
 */
export function settleUploadSuccess<T extends { localId: string; serverId: string | null }>(
  cards: readonly T[],
  localId: string,
  dtoId: string,
  markReady: (card: T) => T,
): T[] {
  // The local card was removed meanwhile: nothing to settle, and the rehydrated
  // server row is then the only card for that draft, so it must stay.
  if (!cards.some((c) => c.localId === localId)) return [...cards];
  return cards
    .filter((c) => c.localId === localId || (c.serverId !== dtoId && c.localId !== dtoId))
    .map((c) => (c.localId === localId ? markReady(c) : c));
}

