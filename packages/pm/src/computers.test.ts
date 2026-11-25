import { describe, expect, it } from "@effect/vitest";

import {
  formatComputers,
  isBusy,
  isOutOfUsage,
  matchComputer,
  type PmAgentStatus,
  type PmComputer,
  type PmHostLoad,
} from "./computers.ts";

const GB = 1024 ** 3;
const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const load = (cpu: number | null, freeGb: number): PmHostLoad => ({
  cpu,
  freeMemoryBytes: freeGb * GB,
  totalMemoryBytes: 32 * GB,
  runningThreads: 1,
});
const claude = (usedPercent: number, resetsAt?: string): PmAgentStatus => ({
  instanceId: "claude",
  name: "Claude",
  ready: true,
  windows: [{ kind: "session", label: "5 h", usedPercent, ...(resetsAt ? { resetsAt } : {}) }],
});
const here: PmComputer = {
  environmentId: "env-here",
  label: "MacBook Pro",
  here: true,
  pm3code: true,
  load: load(0.3, 9),
  agents: [claude(40)],
  project: null,
  pmWorkers: 2,
};
const linked = (label: string, overrides: Partial<PmComputer> = {}): PmComputer => ({
  environmentId: `env-${label}`,
  label,
  here: false,
  link: { status: "reachable", access: "auto", lastError: null },
  pm3code: true,
  load: load(0.05, 20),
  agents: [claude(8)],
  project: { title: "t3code" },
  pmWorkers: 0,
  ...overrides,
});

describe("isBusy", () => {
  it.each([
    ["CPU over 80%", load(0.81, 9), true],
    ["exactly 80% is not over", load(0.8, 9), false],
    ["under 2 GB free", load(0.1, 1.9), true],
    ["an unknown CPU with room", load(null, 9), false],
    ["unknown load", null, false],
  ])("%s", (_name, value, busy) => expect(isBusy(value)).toBe(busy));
});

describe("isOutOfUsage", () => {
  it.each([
    ["a used-up window not reset yet", claude(100, "2026-11-26T14:00:00.000Z"), true],
    ["a used-up window already reset", claude(100, "2026-11-26T11:00:00.000Z"), false],
    ["a used-up window without a reset time", claude(100), true],
    ["usage left", claude(99), false],
    ["no usage reported", { instanceId: "codex", name: "Codex", ready: true }, false],
  ])("%s", (_name, agent, out) => expect(isOutOfUsage(agent, NOW)).toBe(out));
});

describe("matchComputer", () => {
  const computers = [here, linked("Mac mini"), linked("Mac Studio"), linked("Theo’s vps")];
  const found = (query: string) => {
    const match = matchComputer(query, computers);
    return match.type === "found" ? match.computer.label : match.type;
  };

  it("finds by here, id, exact name, prefix and substring, ignoring case and apostrophes", () => {
    expect(found("here")).toBe("MacBook Pro");
    expect(found("env-Mac mini")).toBe("Mac mini");
    expect(found("mac MINI")).toBe("Mac mini");
    expect(found("Mac s")).toBe("Mac Studio");
    expect(found("theo's")).toBe("Theo’s vps");
    expect(found("vps")).toBe("Theo’s vps");
  });

  it("refuses an ambiguous name and names the known computers for an unknown one", () => {
    expect(matchComputer("Mac", computers)).toMatchObject({ type: "ambiguous" });
    const none = matchComputer("Windows box", computers);
    expect(none.type).toBe("none");
    expect(none.type === "none" && none.message).toContain('"Mac mini"');
  });
});

describe("formatComputers", () => {
  it("flags busy and out-of-usage, and says what is unknown or missing there", () => {
    const text = formatComputers(
      [
        { ...here, load: load(0.95, 9), agents: [claude(100, "2026-11-26T14:00:00.000Z")] },
        linked("Mac mini"),
        linked("vps", { project: "none" }),
        linked("old", {
          pm3code: false,
          load: null,
          agents: [{ instanceId: "c", name: "Codex", ready: false, reason: "not signed in" }],
          project: null,
        }),
        linked("Mac Studio", {
          link: { status: "unreachable", access: "auto", lastError: "timeout" },
          pmWorkers: 1,
        }),
        linked("laptop", { link: { status: "expired", access: "auto", lastError: null } }),
      ],
      NOW,
    );
    expect(text).toContain("(BUSY: CPU over 80% or under 2 GB free)");
    expect(text).toContain(
      "Claude: OUT OF USAGE, 5 h 100% (used up, resets 2026-11-26T14:00:00.000Z)",
    );
    expect(text).toContain('This repository there: project "t3code"');
    expect(text).toContain("This repository there: none (ask the user before cloning it there)");
    expect(text).toContain("T3 Code without PM3code: no usage or load");
    expect(text).toContain("Codex: not ready (not signed in)");
    expect(text).toContain("This repository there: unknown");
    expect(text).toContain("Not answering now (timeout). Start nothing there.");
    expect(text).toContain("Your workers there: 1 (their reports wait until it answers)");
    expect(text).toContain("Link expired");
  });

  it("tells how to link a computer when none is linked", () => {
    expect(formatComputers([here], NOW)).toContain("No other computers are linked.");
  });
});
