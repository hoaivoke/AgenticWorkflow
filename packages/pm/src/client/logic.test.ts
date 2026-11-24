import {
  EnvironmentId,
  type PmAsk,
  type PmItem,
  type PmPageSummary,
  ThreadId,
} from "@t3tools/contracts";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  parsePmPageAnswers,
  parsePmReportNotification,
  pmAskTag,
  pmDotStack,
  pmFirst,
  pmItemGroups,
  pmWorkerDot,
  pmWorkerListKeys,
  withPmWorkers,
} from "./logic.ts";
import { pmDescription, pmInbox, pmInboxHidden } from "./inbox.ts";

const LISTED = {
  rootThreadId: ThreadId.make("w-1"),
  parentThreadId: null,
  relationshipToParent: null,
};
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const at = (minutesAgo: number) => iso(NOW - minutesAgo * 60_000);

const ask = (askNo: number, overrides: Partial<PmAsk> = {}): PmAsk => ({
  askNo,
  itemNo: 1,
  title: `Question ${askNo}`,
  detail: "Why.",
  answers: ["Yes", "No"],
  recommended: "Yes",
  holds: false,
  state: "open",
  answer: null,
  snoozedUntil: null,
  answerMessageId: null,
  createdAt: at(askNo),
  settledAt: null,
  ...overrides,
});

const item = (itemNo: number, overrides: Partial<PmItem> = {}): PmItem => ({
  itemNo,
  title: `Item ${itemNo}`,
  status: "moving",
  shownStatus: "in_progress",
  laterReason: null,
  nowLine: null,
  doneLine: null,
  steps: [],
  waits: [],
  createdAt: at(60),
  updatedAt: at(5),
  finishedAt: null,
  droppedAt: null,
  ...overrides,
});

const page = (pageId: string, overrides: Partial<PmPageSummary> = {}): PmPageSummary => ({
  pageId,
  itemNo: null,
  sourceName: `${pageId}.html`,
  title: pageId,
  state: "open",
  questionTags: [],
  messageId: null,
  answersMessageId: null,
  createdAt: at(3),
  ...overrides,
});

describe("pmFirst", () => {
  it("moves PMs to the front and keeps every other order", () => {
    expect(pmFirst(["a", "pm1", "b", "pm2", "c"], (id) => id.startsWith("pm"))).toEqual([
      "pm1",
      "pm2",
      "a",
      "b",
      "c",
    ]);
  });

  it("returns the same list when there is no PM", () => {
    const threads = ["a", "b"];
    expect(pmFirst(threads, () => false)).toBe(threads);
  });
});

describe("withPmWorkers", () => {
  it("adds worker keys and keeps the set's identity when nothing changes", () => {
    const shown = new Set(["delegated"]);
    expect([...withPmWorkers(shown, ["w1", "w2"])].toSorted()).toEqual(["delegated", "w1", "w2"]);
    expect(withPmWorkers(shown, ["delegated"])).toBe(shown);
    expect(withPmWorkers(shown, [])).toBe(shown);
  });
});

describe("pmWorkerListKeys", () => {
  it("keys workers the way upstream's list filters key threads, so they really hide", () => {
    const environmentId = EnvironmentId.make("env-1");
    const workerKeys = pmWorkerListKeys([
      { environmentId, workerThreadIds: [ThreadId.make("w-1")] },
    ]);
    expect(workerKeys).toEqual([threadKey({ environmentId, threadId: ThreadId.make("w-1") })]);
    expect(
      isShownUnderParent(
        { environmentId, threadId: ThreadId.make("w-1") },
        LISTED,
        new Set(workerKeys),
      ),
    ).toBe(true);
  });
});

describe("pmInbox", () => {
  const inbox = (input: Partial<Parameters<typeof pmInbox>[0]>) =>
    pmInbox({ asks: [], pages: [], items: [], turnStartedAt: at(30), ...input }, NOW);

  it("lists asks and pages newest first, then blocked items no holding ask shows", () => {
    const result = inbox({
      asks: [ask(1), ask(2, { holds: true, itemNo: 3 }), ask(4)],
      pages: [page("icons", { questionTags: ["Q3"] })],
      items: [item(3, { shownStatus: "blocked" }), item(4, { shownStatus: "blocked" }), item(5)],
    });
    expect(result.rows.map((row) => row.key)).toEqual([
      "ask:1",
      "ask:2",
      "page:icons",
      "ask:4",
      "item:4",
    ]);
    expect(result.rows.map((row) => row.mark)).toEqual([
      "question",
      "blocked",
      "page",
      "question",
      "blocked",
    ]);
    // A held ask counts once, as blocked work, not as a ping too.
    expect(result.counts).toEqual({ pings: 3, blocked: 2, inProgress: 1 });
    expect(pmInboxHidden(result.rows.slice(3))).toEqual({ pings: 1, blocked: 1, done: 0 });
  });

  it("sinks rows older than a day and moves snoozed asks and pages to Snoozed, soonest back first", () => {
    const result = inbox({
      asks: [
        ask(1, { createdAt: at(60 * 30) }),
        ask(2, { createdAt: at(10) }),
        ask(3, { snoozedUntil: iso(NOW + 6 * 3_600_000) }),
        ask(4, { snoozedUntil: iso(NOW - 60_000) }),
        ask(5, { state: "answered" }),
      ],
      pages: [page("plan", { snoozedUntil: iso(NOW + 3_600_000) })],
    });
    expect(result.rows.map((row) => row.key)).toEqual(["ask:4", "ask:2", "ask:1"]);
    expect(result.snoozed.map((row) => row.key)).toEqual(["page:plan", "ask:3"]);
  });

  it("reads an opened page as read, and archives seen-only pages and to-dos together", () => {
    const result = inbox({
      asks: [ask(1, { answers: [], recommended: null }), ask(2)],
      pages: [
        page("seen", { openedAt: at(1), createdAt: at(40) }),
        page("form", { questionTags: ["Q9"], createdAt: at(41) }),
      ],
    });
    const byKey = new Map(result.rows.map((row) => [row.key, row]));
    expect(byKey.get("page:seen")?.unread).toBe(false);
    expect(byKey.get("page:form")?.unread).toBe(true);
    expect(byKey.get("ask:1")?.mark).toBe("todo");
    expect(result.counts.pings).toBe(3);
    expect(result.archiveAll).toEqual({ pageIds: ["seen"], askNos: [1] });
    expect(inbox({ asks: [ask(1, { answers: [] })] }).archiveAll).toBeNull();
  });

  it("bundles two or more seen-only pages from one turn into one row", () => {
    const result = inbox({
      pages: [
        page("a", { createdAt: at(2) }),
        page("b", { createdAt: at(1), openedAt: at(1) }),
        page("old", { createdAt: at(300) }),
        page("asks", { questionTags: ["Q1"], createdAt: at(4) }),
      ],
    });
    const bundle = result.rows.find((row) => row.kind === "pages");
    expect(bundle).toMatchObject({ key: "pages:last", lastTurn: true, unread: true });
    expect(bundle?.kind === "pages" && bundle.pages.map((one) => one.pageId)).toEqual(["b", "a"]);
    expect(result.rows.map((row) => row.key)).toEqual(["pages:last", "page:asks", "page:old"]);
    expect(result.archiveAll?.pageIds).toEqual(["b", "a", "old"]);
  });

  it("keeps this turn's finished items in Done until archived, and the last hour's answers", () => {
    const finished = { status: "finished" as const, shownStatus: "done" as const };
    const result = inbox({
      items: [
        item(1, { ...finished, finishedAt: at(5) }),
        item(2, { ...finished, finishedAt: at(60) }),
        item(3, { ...finished, finishedAt: at(10), archivedAt: at(2) }),
        // Finished again after an archive: back in Done.
        item(4, { ...finished, finishedAt: at(1), archivedAt: at(20) }),
      ],
      asks: [
        ask(1, { state: "answered", answer: "Yes", settledAt: at(5) }),
        ask(2, { state: "done", answer: "Done", settledAt: at(10) }),
        ask(3, { state: "answered", answer: "No", settledAt: at(90) }),
        ask(4, { state: "dismissed", settledAt: at(1) }),
        // Mark answered: the canned answer is no outcome worth a pill.
        ask(5, { state: "answered", answer: "I answered this in the chat.", settledAt: at(7) }),
      ],
      pages: [page("p", { state: "answered", settledAt: at(3) })],
    });
    expect(result.done.map((row) => row.item.itemNo)).toEqual([4, 1]);
    expect(result.answered.map((row) => [row.key, row.outcome])).toEqual([
      ["answered:page:p", null],
      ["answered:ask:1", "Yes"],
      ["answered:ask:5", null],
      ["answered:ask:2", null],
    ]);
  });
});

describe("pmDescription", () => {
  it("keeps a short one-line description on the row and sends a long one to Details", () => {
    expect(pmDescription("CI is **green**.")).toEqual({ details: false, preview: "CI is green." });
    expect(pmDescription("- one\n- two")).toEqual({ details: true, preview: "one" });
    expect(pmDescription("x ".repeat(60)).details).toBe(true);
    expect(pmDescription("")).toEqual({ details: false, preview: "" });
  });
});

describe("pmItemGroups", () => {
  it("groups in Ghostex's order, hides dropped items, and opens only In progress and Blocked", () => {
    const groups = pmItemGroups([
      item(1, { shownStatus: "done" }),
      item(2, { shownStatus: "blocked" }),
      item(3, { shownStatus: "dropped" }),
      item(4, { shownStatus: "needs_you" }),
      item(5),
    ]);
    expect(groups.map((group) => [group.status, group.openByDefault])).toEqual([
      ["needs_you", false],
      ["blocked", true],
      ["in_progress", true],
      ["done", false],
    ]);
  });
});

describe("parsePmReportNotification", () => {
  it("reads the worker, the pill and the body of a report", () => {
    expect(
      parsePmReportNotification({
        source: { kind: "system" },
        summary: "Report from Fix pairing: Waiting for an answer",
        detail: 'Worker report from "Fix pairing" (thread w): Waiting for an answer\n\nIt waits.',
      }),
    ).toEqual({ worker: "Fix pairing", pill: "waiting", body: "It waits." });
  });

  it("ignores other notifications", () => {
    expect(
      parsePmReportNotification({
        source: { kind: "delegated_task" },
        summary: "Report from X: Finished",
      }),
    ).toBeNull();
    expect(
      parsePmReportNotification({ source: { kind: "system" }, summary: "Project manager setup" }),
    ).toBeNull();
  });
});

describe("parsePmPageAnswers", () => {
  it("reads a page's answers message", () => {
    expect(
      parsePmPageAnswers(
        '<pm-page-answers page="page-1" title="Icons &amp; more" tags="Q4,Q5">{"Q4":"Round","Q5":["A","B"]}</pm-page-answers>',
      ),
    ).toEqual({
      pageId: "page-1",
      title: "Icons & more",
      tags: ["Q4", "Q5"],
      entries: [
        { key: "Q4", value: "Round" },
        { key: "Q5", value: "A, B" },
      ],
      seen: false,
      reply: null,
    });
  });

  it("reads a seen reply and refuses anything else", () => {
    expect(
      parsePmPageAnswers(
        '<pm-page-answers page="p" title="Plan" tags="">{"seen":true,"reply":"Looks good"}</pm-page-answers>',
      ),
    ).toMatchObject({ seen: true, reply: "Looks good", entries: [] });
    expect(parsePmPageAnswers("W1 Q1: Yes")).toBeNull();
    expect(
      parsePmPageAnswers('<pm-page-answers page="p" title="t" tags="">not json</pm-page-answers>'),
    ).toBeNull();
  });
});

describe("pmAskTag", () => {
  it("copies an ask as its tags", () => {
    expect(pmAskTag({ itemNo: 4, askNo: 3 })).toBe("W4 Q3");
    expect(pmAskTag({ itemNo: null, askNo: 3 })).toBe("Q3");
  });
});

describe("pmWorkerDot and pmDotStack", () => {
  const shell = (
    status: string,
    extra: { approval?: boolean; input?: boolean; lastErrorClass?: string } = {},
  ) => ({
    hasPendingApprovals: extra.approval === true,
    hasPendingUserInput: extra.input === true,
    runtime: { status, lastErrorClass: extra.lastErrorClass ?? null },
  });

  it("picks each worker's most urgent dot; a usage-limit stop stays calm", () => {
    expect(
      [
        shell("running", { approval: true }),
        shell("failed"),
        shell("failed", { lastErrorClass: "usage_limit" }),
        shell("waiting", { input: true }),
        shell("completed"),
        shell("running"),
        { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null },
      ].map(pmWorkerDot),
    ).toEqual(["blocker", "blocker", "idle", "question", "finished", "working", "idle"]);
  });

  it("stacks one dot per kind with the most urgent in front", () => {
    expect(pmDotStack(["working", "question", "working", "idle", "finished"])).toEqual([
      "idle",
      "working",
      "finished",
      "question",
    ]);
  });
});
