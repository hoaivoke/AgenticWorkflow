import type { OrchestrationV2ThreadShell, PmReportKind } from "@t3tools/contracts";
import { PM_PLAYBOOK } from "@t3tools/pm";
import * as DateTime from "effect/DateTime";

export const PM_NEW_TITLE = "New PM";

export const isoMillis = (value: string) => Date.parse(value);
const REPORT_TEXT_LIMIT = 12_000;
export const QUIET_AFTER_MS = 8 * 60_000;
export const IDLE_AFTER_MS = 10 * 60_000;
export const MEMORY_LIMIT = 60;
export const MEMORY_TEXT_LIMIT = 600;
export const PAGE_HTML_LIMIT = 2 * 1024 * 1024;
export const PAGE_ANSWERS_LIMIT = 64 * 1024;

export const PM_SETUP_MESSAGE = [
  "You are a Project Manager (PM) thread for this project in Agent Space.",
  "Call `pm_guide` now and follow it from here on.",
  "Then reply with one short line asking the user for the brief. Start no work yet.",
].join(" ");

export const PM_CONVERT_MESSAGE = [
  "This thread is now a Project Manager (PM) thread for this project in Agent Space.",
  "Call `pm_guide` now and follow it from here on; the conversation so far is your context.",
  "Then reply with one short line saying what you understand the brief to be, or asking for it. Start no work yet.",
].join(" ");

export const QUIET_NUDGE =
  "T3: no new output from you for 8 minutes. Still working? Say what you're waiting on, or carry on.";
export const IDLE_NUDGE =
  "T3: your turn ended before your task was done. Carry on with it, and end your turn with your report.";

export const REPORT_LABELS: Record<PmReportKind, string> = {
  finished: "Finished",
  waiting: "Waiting for an answer",
  quiet: "Quiet for 8 min",
  stopped: "Stopped mid-turn",
  idle: "Idle while owing work",
  restarted: "Restarted",
};

export function composeGuide(overrides: ReadonlyArray<string>): string {
  if (overrides.length === 0) return PM_PLAYBOOK;
  return `${PM_PLAYBOOK}\n\n## The user's overrides\n\nThese apply to every project manager and outrank everything above.\n\n${overrides
    .map((rule, index) => `${index + 1}. ${rule}`)
    .join("\n")}\n`;
}

/** The footer every brief gets: the port of Ghostex's thread brief. */
export function workerBrief(input: {
  readonly brief: string;
  readonly pmTitle: string;
  readonly mission: string;
  readonly instructions: string;
  /** The linked computer it runs on, when not the project manager's. */
  readonly computer?: string | undefined;
}): string {
  const remote = input.computer !== undefined;
  const lines = [
    input.brief.trim(),
    "",
    "---",
    `You are a worker thread started by the Agent Space project manager "${input.pmTitle}".`,
  ];
  if (input.mission.trim().length > 0) lines.push(`Its mission: ${input.mission.trim()}`);
  if (input.instructions.trim().length > 0)
    lines.push(`Its standing instructions: ${input.instructions.trim()}`);
  if (remote)
    lines.push(
      "",
      `You run on "${input.computer}", one of the user's other computers. The project manager runs on another computer and shares no files with you: anything it needs goes through git (push your branch when the brief allows it) or your report.`,
    );
  lines.push(
    "",
    "How to report:",
    "- Your final message is your report: what you did, where, how you verified it, and anything left or blocked. Agent Space passes it to the project manager.",
    "- Never message the project manager's thread yourself (t3_thread_send or the like).",
    remote
      ? "- List every push in your final report (commit and one line on what landed): pm_worker_note does not reach the project manager from here."
      : '- Right after every push, send a short note with `pm_worker_note` ("<commit> <one line on what landed>"), then keep going and still end your turn with the full report.',
    '- When you need a decision you cannot make, ask it plainly in your final message and stop. Give each question a title that names its subject (never "it" or "this" alone) and a line on what it is about and why: the user reads it in the project manager\'s dock, not in your report.',
    "- When the user must paste, post or run something, put the whole text and its link in the question's description, not only in the report.",
    "- Never ask the user to run or paste a command you can run yourself (setup, connect, sign-in, opening a setting): run it yourself and ask only for the step that needs their hands (Touch ID or fingerprint, clicking Approve, signing in in the browser window that opened). Never approve permission, Keychain, consent, pairing or sign-in prompts for the user, and never type passwords or 2FA.",
    "- Do not merge, push, delete branches or run destructive commands unless this brief asks for it.",
    "- Stop every background job you no longer need before your final report.",
    "- Start your report's sections with markers: ✅ Done, 🧪 Untested, ⚠️ Read this, 🛑 Blocked, ❓ Needs you.",
    `- If you drove an app or a browser, save a screenshot of every state of the UI as it changes (before, each step, after) and link them in your report. Never tiny: at least 1650x962, so size the window or viewport first. Take none when you did no GUI work.${remote ? ` Say that the files are on "${input.computer}".` : ""}`,
  );
  return lines.join("\n");
}

export function cutReportText(text: string): string {
  if (text.length <= REPORT_TEXT_LIMIT) return text;
  return `${text.slice(0, REPORT_TEXT_LIMIT)}\n\n[Cut at 12,000 characters. Read the rest with t3_thread_read.]`;
}

export const firstLine = (text: string, limit = 160) => {
  const line =
    text
      .trim()
      .split("\n")
      .find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line.trim();
};

const REPORT_OPENER = "Worker report from ";
const NOTE_OPENER = "Worker note from ";
export const NOTE_LIMIT = 600;
const PAGE_ANSWERS_OPENER = "<pm-page-answers";

/**
 * A worker's own words with every report header and page-answers tag broken by a zero-width
 * space, so only the header PM3code writes names a worker and no report reads as the user's answers.
 */
const withoutForgedMarkers = (text: string) =>
  text
    .replaceAll(REPORT_OPENER, `Worker\u200b report from `)
    .replaceAll(NOTE_OPENER, `Worker\u200b note from `)
    .replaceAll(PAGE_ANSWERS_OPENER, "<\u200bpm-page-answers");

export function reportMessage(input: {
  readonly kind: PmReportKind;
  readonly workerTitle: string;
  readonly workerThreadId: string;
  readonly body: string;
}): string {
  return `${REPORT_OPENER}"${withoutForgedMarkers(input.workerTitle)}" (thread ${input.workerThreadId}): ${REPORT_LABELS[input.kind]}\n\n${withoutForgedMarkers(input.body)}`;
}

/** Ghostex's "Ghostex thread note": a worker's one line right after a push, while it keeps working. */
export function noteMessage(input: {
  readonly workerTitle: string;
  readonly workerThreadId: string;
  readonly note: string;
}): string {
  return `${NOTE_OPENER}"${withoutForgedMarkers(input.workerTitle)}" (thread ${input.workerThreadId}): ${withoutForgedMarkers(input.note)}`;
}

const RUNNING_STATUSES = new Set(["preparing", "queued", "starting", "running"]);
const millis = (value: DateTime.DateTime | null | undefined) =>
  value === null || value === undefined ? 0 : DateTime.toEpochMillis(value);

const activityOf = (shell: OrchestrationV2ThreadShell) =>
  Math.max(
    millis(shell.updatedAt),
    millis(shell.latestVisibleMessage?.updatedAt),
    millis(shell.activityRunStartedAt),
  );

/**
 * A running worker's run and when it last showed activity; one quiet streak per pair. Its
 * subagents' output counts as its own, so a lead whose subagents write is not quiet (Ghostex
 * c2c3cc445).
 */
export function quietStreakOf(
  shell: OrchestrationV2ThreadShell,
  subagents: ReadonlyArray<OrchestrationV2ThreadShell> = [],
) {
  if (!RUNNING_STATUSES.has(shell.status) || shell.activeRunId === null) return null;
  const lastActivity = Math.max(activityOf(shell), ...subagents.map(activityOf));
  return { runId: shell.activeRunId, lastActivity, streak: `${shell.activeRunId}@${lastActivity}` };
}

/** When a worker stopped at a usage limit can carry on, or null when that is not why it stopped. */
export function usageLimitResetOf(shell: OrchestrationV2ThreadShell): number | null {
  if (shell.status !== "failed" || shell.lastErrorClass !== "usage_limit") return null;
  const reset = Date.parse(shell.usageLimitResetAt ?? "");
  return Number.isFinite(reset) ? reset : null;
}

export function pageAnswersMessage(input: {
  readonly pageId: string;
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
  readonly json: string;
}): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<pm-page-answers page="${escape(input.pageId)}" title="${escape(input.title)}" tags="${escape(
    input.tags.join(","),
  )}">${input.json}</pm-page-answers>`;
}

export function linkKind(url: string): "pr" | "issue" | "url" {
  if (/\/(pull|pulls|merge_requests|pull-requests)\/\d+/.test(url)) return "pr";
  if (/\/(issues|issue)\/\d+|\/browse\/[A-Z][A-Z0-9]+-\d+/.test(url)) return "issue";
  return "url";
}
