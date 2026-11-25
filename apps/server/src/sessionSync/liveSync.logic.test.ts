import { describe, expect, it } from "@effect/vitest";

import {
  messagesToAppend,
  nextImportedMessageIndex,
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
