import { describe, expect, it } from "vitest";
import { settleUploadSuccess } from "../../src/web/composerOrder.js";

interface Card {
  localId: string;
  serverId: string | null;
  state: "uploading" | "ready";
}
const ready = (c: Card): Card => ({ ...c, state: "ready", serverId: "S1" });

describe("settleUploadSuccess (duplicate card race)", () => {
  it("initial empty composer: a rehydrated duplicate added mid-upload is dropped and one ready card remains in place", () => {
    // 1. The first file's local card is added to an empty composer.
    let cards: Card[] = [{ localId: "local-a", serverId: null, state: "uploading" }];
    // 2. Hydration lists the server draft list and appends the still-uploading
    //    server row (localId = serverId) because the local card cannot match yet.
    cards = [...cards, { localId: "S1", serverId: "S1", state: "uploading" }];
    expect(cards).toHaveLength(2);
    // 3. The 201 arrives.
    const settled = settleUploadSuccess(cards, "local-a", "S1", ready);
    expect(settled).toEqual([{ localId: "local-a", serverId: "S1", state: "ready" }]);
    expect(new Set(settled.map((c) => c.serverId)).size).toBe(settled.length);
  });

  it("preserves the order of the other cards and the local card's position", () => {
    const cards: Card[] = [
      { localId: "k1", serverId: "K1", state: "ready" },
      { localId: "local-b", serverId: null, state: "uploading" },
      { localId: "k2", serverId: "K2", state: "ready" },
      { localId: "S1", serverId: "S1", state: "uploading" },
    ];
    const settled = settleUploadSuccess(cards, "local-b", "S1", ready);
    expect(settled.map((c) => c.localId)).toEqual(["k1", "local-b", "k2"]);
    expect(settled.map((c) => c.serverId)).toEqual(["K1", "S1", "K2"]);
    expect(settled[1]!.state).toBe("ready");
  });

  it("also drops a card that only matches by serverId, and is a plain mark-ready without duplicates", () => {
    const dupBySid: Card[] = [
      { localId: "local-c", serverId: null, state: "uploading" },
      { localId: "reloaded-x", serverId: "S1", state: "uploading" },
    ];
    expect(settleUploadSuccess(dupBySid, "local-c", "S1", ready).map((c) => c.localId)).toEqual(["local-c"]);
    const clean: Card[] = [
      { localId: "a", serverId: "A", state: "ready" },
      { localId: "local-d", serverId: null, state: "uploading" },
    ];
    expect(settleUploadSuccess(clean, "local-d", "S1", ready)).toEqual([
      { localId: "a", serverId: "A", state: "ready" },
      { localId: "local-d", serverId: "S1", state: "ready" },
    ]);
  });

  it("a missing local card (removed during upload) leaves every card untouched, including the rehydrated server row", () => {
    const cards: Card[] = [
      { localId: "k1", serverId: "K1", state: "ready" },
      { localId: "S1", serverId: "S1", state: "uploading" },
    ];
    expect(settleUploadSuccess(cards, "gone", "S1", ready)).toEqual(cards);
  });
});
