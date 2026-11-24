import { assert, describe, it } from "@effect/vitest";

import { mergeFollowedSettings } from "./settingsMerge.ts";

const defaults = { theme: "", fontSize: 14, providers: { codex: { enabled: true } } };

describe("mergeFollowedSettings", () => {
  it("follows T3 Code where PM3code is at the default, and keeps a setting changed in PM3code", () => {
    const first = mergeFollowedSettings({
      pm: { fontSize: 18 },
      t3: { theme: "dusk", fontSize: 12, providers: { codex: { enabled: false } } },
      defaults,
      baseline: {},
    });
    assert.deepStrictEqual(first.next, {
      fontSize: 18,
      theme: "dusk",
      providers: { codex: { enabled: false } },
    });
    assert.strictEqual(first.changed, 2);

    // T3 Code changes again: followed settings move with it, PM3code's own choice stays.
    const second = mergeFollowedSettings({
      pm: first.next,
      t3: { theme: "dawn", fontSize: 13, providers: { codex: { enabled: false } } },
      defaults,
      baseline: first.baseline,
    });
    assert.deepStrictEqual(second.next, {
      fontSize: 18,
      theme: "dawn",
      providers: { codex: { enabled: false } },
    });
  });

  it("stops following a setting once it is changed in PM3code, and follows a reset back", () => {
    const first = mergeFollowedSettings({ pm: {}, t3: { theme: "dusk" }, defaults, baseline: {} });
    const edited = { ...first.next, theme: "mine" };
    const second = mergeFollowedSettings({
      pm: edited,
      t3: { theme: "dawn" },
      defaults,
      baseline: first.baseline,
    });
    assert.strictEqual(second.next.theme, "mine");
    // T3 Code goes back to its default: a value PM3code holds as copied goes back with it.
    const third = mergeFollowedSettings({
      pm: { theme: "dawn" },
      t3: {},
      defaults,
      baseline: second.baseline,
    });
    assert.isUndefined(third.next.theme);
  });

  it("never copies a skipped subtree such as a secret reference", () => {
    const merged = mergeFollowedSettings({
      pm: {},
      t3: { apiKey: { secret: "t3-only" }, theme: "dusk" },
      defaults,
      baseline: {},
      skip: (value) => typeof value === "object" && value !== null && "secret" in value,
    });
    assert.deepStrictEqual(merged.next, { theme: "dusk" });
  });
});
