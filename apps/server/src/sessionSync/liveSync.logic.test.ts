import { describe, expect, it } from "@effect/vitest";

import { messagesToAppend, nextImportedMessageIndex, type SyncMessage } from "./liveSync.logic.ts";

const user = (text: string): SyncMessage => ({ role: "user", text });
const agent = (text: string): SyncMessage => ({ role: "assistant", text });

describe("messagesToAppend", () => {
  it("returns what follows the thread's history in the transcript", () => {
    const stored = [user("fix the bug"), agent("Looking."), agent("Fixed.")];
    const transcript = [...stored, user("thanks, now add a test"), agent("Added.")];
    expect(messagesToAppend(stored, transcript)).toEqual([
      user("thanks, now add a test"),
      agent("Added."),
    ]);
  });

  it("finds the history when the import kept only the newest messages", () => {
    const stored = [user("first"), user("b"), agent("c"), user("d")];
    const transcript = [user("first"), agent("a"), user("b"), agent("c"), user("d"), agent("e")];
    expect(messagesToAppend(stored, transcript)).toEqual([agent("e")]);
  });

  it("uses the newest match when short replies repeat", () => {
    const stored = [user("ok"), agent("done"), user("ok"), agent("done")];
    const transcript = [...stored, user("ok"), agent("done")];
    expect(messagesToAppend(stored, transcript)).toEqual([]);
  });

  it("adds nothing when the transcript no longer holds the thread's history", () => {
    expect(messagesToAppend([user("a"), agent("b")], [user("x"), agent("y")])).toBeNull();
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
