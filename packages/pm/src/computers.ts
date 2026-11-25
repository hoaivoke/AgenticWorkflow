// Which computer a PM starts a worker on: the user's linked computers, what each has room for, and
// the rule the playbook gives (rules first, else here, else a computer with room and the repo).

export interface PmUsageWindow {
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
}

export interface PmAgentStatus {
  readonly instanceId: string;
  readonly name: string;
  /** Installed, signed in and able to start a thread. */
  readonly ready: boolean;
  readonly reason?: string | undefined;
  /** Usage windows, when that computer reports them (PM3code computers only). */
  readonly windows?: ReadonlyArray<PmUsageWindow> | undefined;
}

export interface PmHostLoad {
  /** 0 to 1, or null before the first sample. */
  readonly cpu: number | null;
  readonly freeMemoryBytes: number;
  readonly totalMemoryBytes: number;
  readonly runningThreads: number;
}

export type PmComputerLinkStatus = "reachable" | "unreachable" | "expired";

export interface PmComputer {
  readonly environmentId: string;
  readonly label: string;
  readonly here: boolean;
  /** Absent for this computer. */
  readonly link?:
    | {
        readonly status: PmComputerLinkStatus;
        readonly access: string;
        readonly lastError: string | null;
      }
    | undefined;
  /** Whether it runs PM3code: then it reports usage and load. Null while it is not reachable. */
  readonly pm3code: boolean | null;
  readonly load: PmHostLoad | null;
  readonly agents: ReadonlyArray<PmAgentStatus> | null;
  /** The project with this PM's repository there; null when not known. */
  readonly project: { readonly title: string } | null | "none";
  /** This PM's unresolved workers there. */
  readonly pmWorkers: number;
}

export const BUSY_CPU = 0.8;
export const BUSY_FREE_MEMORY_BYTES = 2 * 1024 ** 3;

/** Busy by the user's rule: CPU over 80% or under 2 GB free. Unknown load is not busy. */
export const isBusy = (load: PmHostLoad | null): boolean =>
  load !== null &&
  ((load.cpu !== null && load.cpu > BUSY_CPU) || load.freeMemoryBytes < BUSY_FREE_MEMORY_BYTES);

/** A usage window used up and not reset yet. */
export const isWindowSpent = (window: PmUsageWindow, nowMs: number): boolean =>
  window.usedPercent >= 100 &&
  (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs);

/** Out of usage: any of its windows is spent. Unknown usage is not out. */
export const isOutOfUsage = (agent: PmAgentStatus, nowMs: number): boolean =>
  (agent.windows ?? []).some((window) => isWindowSpent(window, nowMs));

/** Can take new work right now: this computer, or a linked one that answers. */
export const isUsable = (computer: PmComputer): boolean =>
  computer.here || computer.link?.status === "reachable";

const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export type PmComputerMatch =
  | { readonly type: "found"; readonly computer: PmComputer }
  | { readonly type: "none"; readonly message: string }
  | { readonly type: "ambiguous"; readonly message: string };

const names = (computers: ReadonlyArray<PmComputer>) =>
  computers.map((computer) => `"${computer.label}"`).join(", ");

/**
 * A computer by environment id, `here`/`this`/`local`, exact name, name prefix, then substring,
 * ignoring case and apostrophe style, as Ghostex's `--computer` does.
 */
export function matchComputer(
  query: string,
  computers: ReadonlyArray<PmComputer>,
): PmComputerMatch {
  const wanted = fold(query);
  const here = computers.find((computer) => computer.here);
  if (here !== undefined && (wanted === "here" || wanted === "this" || wanted === "local"))
    return { type: "found", computer: here };
  const byId = computers.find((computer) => computer.environmentId === query.trim());
  if (byId !== undefined) return { type: "found", computer: byId };
  for (const test of [
    (label: string) => label === wanted,
    (label: string) => label.startsWith(wanted),
    (label: string) => label.includes(wanted),
  ]) {
    const found = computers.filter((computer) => test(fold(computer.label)));
    if (found.length === 1) return { type: "found", computer: found[0]! };
    if (found.length > 1)
      return {
        type: "ambiguous",
        message: `"${query}" matches several computers: ${names(found)}. Name one exactly.`,
      };
  }
  return {
    type: "none",
    message: `No computer named "${query}". Known: ${names(computers)}. A computer the user names that is not listed is not linked yet: ask them to link it (t3_environment_link shows them a card).`,
  };
}

const percent = (value: number) => `${Math.round(value)}%`;
const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const windowLine = (window: PmUsageWindow, nowMs: number) => {
  const notes = [
    ...(isWindowSpent(window, nowMs) ? ["used up"] : []),
    ...(window.resetsAt === undefined ? [] : [`resets ${window.resetsAt}`]),
  ];
  return `${window.label} ${percent(window.usedPercent)}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
};

const agentLine = (agent: PmAgentStatus, nowMs: number) => {
  if (!agent.ready) return `${agent.name}: not ready${agent.reason ? ` (${agent.reason})` : ""}`;
  const windows = agent.windows ?? [];
  const out = isOutOfUsage(agent, nowMs);
  return `${agent.name}: ${out ? "OUT OF USAGE" : "ready"}${windows.length === 0 ? "" : `, ${windows.map((window) => windowLine(window, nowMs)).join(", ")}`}`;
};

/** `pm_computers`: one block per computer, this one first, with the flags the playbook rule reads. */
export function formatComputers(computers: ReadonlyArray<PmComputer>, nowMs: number): string {
  if (computers.every((computer) => computer.here))
    return [
      ...computers.flatMap((computer) => computerBlock(computer, nowMs)),
      "",
      "No other computers are linked. To use one, the user links it in Settings, Environments (Linked environments, under Settings, Labs, must be on on both computers).",
    ].join("\n");
  return computers.flatMap((computer) => computerBlock(computer, nowMs)).join("\n");
}

function computerBlock(computer: PmComputer, nowMs: number): ReadonlyArray<string> {
  const head = computer.here
    ? `"${computer.label}" (this computer, where you run)`
    : `"${computer.label}" (linked, ${computer.link?.access ?? "unknown"} access, ${computer.link?.status ?? "unknown"}${computer.pm3code === false ? ", T3 Code without PM3code: no usage or load" : ""})`;
  const lines = [head];
  if (!isUsable(computer)) {
    lines.push(
      computer.link?.status === "expired"
        ? "  Link expired: the user links it again in Settings, Environments. Start nothing there."
        : `  Not answering now${computer.link?.lastError ? ` (${computer.link.lastError})` : ""}. Start nothing there.`,
    );
    if (computer.pmWorkers > 0)
      lines.push(
        `  Your workers there: ${computer.pmWorkers} (their reports wait until it answers)`,
      );
    return lines;
  }
  const flags: Array<string> = [];
  if (isBusy(computer.load)) flags.push("BUSY");
  if (computer.load !== null)
    lines.push(
      `  Load: CPU ${computer.load.cpu === null ? "unknown" : percent(computer.load.cpu * 100)}, ${gigabytes(computer.load.freeMemoryBytes)} of ${gigabytes(computer.load.totalMemoryBytes)} free, ${computer.load.runningThreads} threads running${flags.length > 0 ? ` (${flags.join(", ")}: CPU over 80% or under 2 GB free)` : ""}`,
    );
  lines.push(`  Your workers there: ${computer.pmWorkers}`);
  if (computer.agents !== null)
    for (const agent of computer.agents) lines.push(`  ${agentLine(agent, nowMs)}`);
  if (!computer.here)
    lines.push(
      computer.project === null
        ? "  This repository there: unknown"
        : computer.project === "none"
          ? "  This repository there: none (ask the user before cloning it there)"
          : `  This repository there: project "${computer.project.title}"`,
    );
  return lines;
}
