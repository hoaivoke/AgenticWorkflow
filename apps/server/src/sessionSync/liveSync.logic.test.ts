import { describe, expect, it } from "@effect/vitest";

import {
  messagesToAppend,
  nextImportedMessageIndex,
  planTurnItemOrderRepair,
  type StoredMessage,
  type SyncMessage,
} from "./liveSync.logic.ts";

const user = (text: string): SyncMessage => ({ role: "user", text });
const agent = (text: string): SyncMessage => ({ role: "assistant", text });
const synced = (message: SyncMessage): StoredMessage => ({ ...message, fromTranscript: true });
const inApp = (message: SyncMessage): StoredMessage => ({ ...message, fromTranscript: false });

describe("messagesToAppend", () => {
  it("returns what follows the thread's history in the transcript", () => {
    const history = [user("fix the bug"), agent("Looking."), agent("Fixed.")];
    const transcript = [...history, user("thanks, now add a test"), agent("Added.")];
    expect(messagesToAppend(history.map(synced), transcript)).toEqual([
      user("thanks, now add a test"),
      agent("Added."),
    ]);
  });

  it("finds the history when the import kept only the newest messages", () => {
    const stored = [user("first"), user("b"), agent("c"), user("d")].map(synced);
    const transcript = [user("first"), agent("a"), user("b"), agent("c"), user("d"), agent("e")];
    expect(messagesToAppend(stored, transcript)).toEqual([agent("e")]);
  });

  it("uses the newest match when short replies repeat", () => {
    const history = [user("ok"), agent("done"), user("ok"), agent("done")];
    const transcript = [...history, user("ok"), agent("done")];
    expect(messagesToAppend(history.map(synced), transcript)).toEqual([]);
  });

  it("keeps following after the app ran turns on another provider", () => {
    const stored = [
      ...[user("a"), agent("b"), user("c")].map(synced),
      inApp(user("Set up a project manager")),
      inApp(agent("Is that the brief?")),
    ];
    const transcript = [user("a"), agent("b"), user("c"), agent("M1 done"), user("start M2")];
    expect(messagesToAppend(stored, transcript)).toEqual([agent("M1 done"), user("start M2")]);
  });

  it("does not repeat turns the app ran on the same session", () => {
    const stored = [
      ...[user("a"), agent("b")].map(synced),
      inApp(user("from the app")),
      inApp(agent("app reply")),
    ];
    const transcript = [
      user("a"),
      agent("b"),
      user("from the app"),
      agent("app reply"),
      user("from the terminal"),
    ];
    expect(messagesToAppend(stored, transcript)).toEqual([user("from the terminal")]);
  });

  it("adds nothing when the transcript no longer holds the thread's history", () => {
    expect(
      messagesToAppend([user("a"), agent("b")].map(synced), [user("x"), agent("y")]),
    ).toBeNull();
    expect(messagesToAppend([], [user("x")])).toBeNull();
  });
});

describe("nextImportedMessageIndex", () => {
  it("continues after the highest imported index", () => {
    expect(
      nextImportedMessageIndex(["import:claude:s:000000", "import:claude:s:000012", "other"]),
    ).toBe(13);
    expect(nextImportedMessageIndex([])).toBe(0);
  });
});

describe("planTurnItemOrderRepair", () => {
  it("moves misplaced post-run transcript items into chronological order after settled runs and shifts newer band items", () => {
    const t = (iso: string) => Date.parse(iso);
    const runs = [
      { id: "run-1", ordinal: 1, anchorMs: t("2026-11-25T07:13:00.515Z") },
      { id: "run-2", ordinal: 2, anchorMs: t("2026-11-25T07:13:00.655Z") },
    ];
    const items = [
      // Pre-run items stay in band 0
      { id: "item:000000", runId: null, ordinal: 1, timestampMs: t("2026-11-25T00:10:00Z") },
      { id: "item:000001", runId: null, ordinal: 2, timestampMs: t("2026-11-25T04:57:00Z") },
      // Misplaced post-run items from earlier sync bug (stuck < 1_000_000)
      { id: "item:000002", runId: null, ordinal: 3, timestampMs: t("2026-11-26T02:07:11Z") },
      { id: "item:000003", runId: null, ordinal: 4, timestampMs: t("2026-11-26T03:42:17Z") },
      // Settled app runs
      {
        id: "run1:item",
        runId: "run-1",
        ordinal: 1_000_008,
        timestampMs: t("2026-11-25T07:13:00Z"),
      },
      {
        id: "run2:item",
        runId: "run-2",
        ordinal: 2_000_002,
        timestampMs: t("2026-11-25T07:13:00.655Z"),
      },
      // Newer item already in band 2 that must shift after item:000002 & item:000003
      {
        id: "item:000004",
        runId: null,
        ordinal: 2_000_003,
        timestampMs: t("2026-11-26T04:06:30Z"),
      },
    ];

    const updates = planTurnItemOrderRepair({ runs, items });
    expect(updates).toEqual([
      { id: "item:000002", ordinal: 2_000_003 },
      { id: "item:000003", ordinal: 2_000_004 },
      { id: "item:000004", ordinal: 2_000_005 },
    ]);

    // Applying the updates makes a second pass a complete no-op
    const map = new Map(updates.map((u) => [u.id, u.ordinal]));
    const repaired = items.map((item) => ({ ...item, ordinal: map.get(item.id) ?? item.ordinal }));
    expect(planTurnItemOrderRepair({ runs, items: repaired })).toEqual([]);
  });
});
