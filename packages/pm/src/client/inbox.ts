import type { PmAsk, PmItem, PmPageSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// The Inbox above a PM's composer, Ghostex's Session Inbox (gx-chat-core extras/work_cards.rs
// `dock_with`) over PM3code's asks, Live pages and work items. Web and mobile draw the same model.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** How long an answered ask or page stays in the Answered drawer. */
const ANSWERED_KEPT_MS = HOUR_MS;
const ANSWERED_MAX = 12;
/** A description this short and on one line is the row's second line, not Details. */
const SHORT_DESCRIPTION = 90;
/** Same-turn pages that only wait to be seen bundle once there are this many. */
const BUNDLE_MIN = 2;
const BUNDLE_WINDOW_MS = 2 * MINUTE_MS;

export const PM_INBOX_LIMIT = 4;
export const PM_INBOX_PHONE_LIMIT = 3;
/** Ghostex's snooze lengths, in hours. */
export const PM_SNOOZE_HOURS = [1, 6, 24] as const;

/** Each row's leading icon: Ghostex's `row_mark`. */
export type PmInboxMark = "question" | "todo" | "blocked" | "page" | "pages" | "finished";

interface RowBase {
  readonly key: string;
  readonly at: string;
  readonly mark: PmInboxMark;
  /** Not yet seen: a bright title. Asks always are; a page until it is opened. */
  readonly unread: boolean;
  /** Set on a row in the Snoozed drawer: when it comes back. */
  readonly snoozedUntil: string | null;
}

export type PmInboxRow =
  | (RowBase & {
      readonly kind: "ask";
      readonly ask: PmAsk;
      /** An ask with no answers of its own: Done, and Archive beside it. */
      readonly todo: boolean;
      /** A long description: a Details button opens it, the answers wait there. */
      readonly details: boolean;
      /** A one-line description under the title, or its first line when `details`. */
      readonly preview: string;
    })
  | (RowBase & {
      readonly kind: "page";
      readonly page: PmPageSummary;
      /** Asks no question: it only waits to be seen, so Archive marks it seen. */
      readonly seenOnly: boolean;
    })
  | (RowBase & {
      readonly kind: "pages";
      /** Two or more seen-only pages from one turn, newest first. */
      readonly pages: ReadonlyArray<PmPageSummary>;
      readonly lastTurn: boolean;
    })
  | (RowBase & { readonly kind: "blocked"; readonly item: PmItem })
  | (RowBase & { readonly kind: "finished"; readonly item: PmItem });

export interface PmInboxAnswered {
  readonly key: string;
  readonly title: string;
  /** The answer picked, when it says more than "answered" or "done". */
  readonly outcome: string | null;
  readonly at: string;
  readonly messageId: string | null;
}

export interface PmInbox {
  readonly rows: ReadonlyArray<PmInboxRow>;
  readonly counts: {
    readonly pings: number;
    readonly blocked: number;
    readonly inProgress: number;
  };
  /** Archive all under the rows: seen-only pages and to-dos, once there are two. */
  readonly archiveAll: {
    readonly pageIds: ReadonlyArray<string>;
    readonly askNos: ReadonlyArray<number>;
  } | null;
  /** What the PM's newest turn finished, in the Done drawer. */
  readonly done: ReadonlyArray<PmInboxRow & { readonly kind: "finished" }>;
  readonly snoozed: ReadonlyArray<PmInboxRow>;
  readonly answered: ReadonlyArray<PmInboxAnswered>;
}

// Hermes (the phone) has no `toSorted`.
const sorted = <A>(items: ReadonlyArray<A>, order: (a: A, b: A) => number): Array<A> =>
  [...items].sort(order);
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const snoozedNow = (until: string | null | undefined, now: number) => ms(until) > now;

/** Ghostex's `details_fields`: a short one-line description stays on the row. */
export function pmDescription(detail: string): {
  readonly details: boolean;
  readonly preview: string;
} {
  const text = detail.trim();
  if (text.length === 0) return { details: false, preview: "" };
  const plain = (line: string) =>
    line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*`]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
  const listed = ["- ", "* ", "+ ", "#", ">", "|", "```"].some((marker) => text.startsWith(marker));
  if (!text.includes("\n") && !listed) {
    const line = plain(text);
    if (line.length <= SHORT_DESCRIPTION) return { details: false, preview: line };
  }
  const first =
    text
      .split("\n")
      .map((line) =>
        line
          .trim()
          .replace(/^[#>\-*+]+/, "")
          .trim(),
      )
      .find((line) => line.length > 0 && !line.startsWith("```")) ?? "";
  return { details: true, preview: plain(first) };
}

const askRow = (ask: PmAsk): PmInboxRow => {
  const todo = ask.answers.length === 0;
  return {
    kind: "ask",
    key: `ask:${ask.askNo}`,
    at: ask.createdAt,
    mark: ask.holds ? "blocked" : todo ? "todo" : "question",
    unread: true,
    snoozedUntil: ask.snoozedUntil,
    ask,
    todo,
    ...pmDescription(ask.detail),
  };
};

const pageRow = (page: PmPageSummary): PmInboxRow => ({
  kind: "page",
  key: `page:${page.pageId}`,
  at: page.createdAt,
  mark: "page",
  unread: !page.openedAt,
  snoozedUntil: page.snoozedUntil ?? null,
  page,
  seenOnly: page.questionTags.length === 0,
});

/** Ghostex's `bundle_same_turn_pages`: seen-only pages of one turn fold into one row. */
function bundlePages(
  rows: ReadonlyArray<PmInboxRow>,
  turnStartedAt: number,
): ReadonlyArray<PmInboxRow> {
  const turnOf = (at: number) =>
    at >= turnStartedAt ? "last" : `win:${Math.floor(at / BUNDLE_WINDOW_MS)}`;
  const groups = new Map<string, Array<PmPageSummary>>();
  const kept: Array<PmInboxRow> = [];
  for (const row of rows) {
    if (row.kind !== "page" || !row.seenOnly) {
      kept.push(row);
      continue;
    }
    const turn = turnOf(ms(row.page.createdAt));
    groups.set(turn, [...(groups.get(turn) ?? []), row.page]);
  }
  for (const [turn, pages] of groups) {
    if (pages.length < BUNDLE_MIN) {
      kept.push(...pages.map(pageRow));
      continue;
    }
    const newestFirst = sorted(pages, (a, b) => ms(b.createdAt) - ms(a.createdAt));
    kept.push({
      kind: "pages",
      key: `pages:${turn}`,
      at: newestFirst[0]!.createdAt,
      mark: "pages",
      unread: newestFirst.some((page) => !page.openedAt),
      snoozedUntil: null,
      pages: newestFirst,
      lastTurn: turn === "last",
    });
  }
  return kept;
}

/** What needs you is newest first, but a row older than a day sinks below the newer ones. */
const newestFirstAgedLast = (now: number) => (a: PmInboxRow, b: PmInboxRow) => {
  const aOld = now - ms(a.at) > DAY_MS;
  const bOld = now - ms(b.at) > DAY_MS;
  if (aOld !== bOld) return aOld ? 1 : -1;
  return ms(b.at) - ms(a.at);
};

export function pmInbox(
  input: {
    readonly asks: ReadonlyArray<PmAsk>;
    readonly pages: ReadonlyArray<PmPageSummary>;
    readonly items: ReadonlyArray<PmItem>;
    readonly turnStartedAt?: string | null | undefined;
  },
  now: number,
): PmInbox {
  const turnStartedAt = ms(input.turnStartedAt);
  const openAsks = input.asks.filter((ask) => ask.state === "open");
  const openPages = input.pages.filter((page) => page.state === "open");
  const awakeAsks = openAsks.filter((ask) => !snoozedNow(ask.snoozedUntil, now));
  const awakePages = openPages.filter((page) => !snoozedNow(page.snoozedUntil, now));
  const needs = sorted(
    bundlePages(
      [...awakeAsks.map(askRow), ...awakePages.map(pageRow)],
      Number.isNaN(turnStartedAt) ? Number.POSITIVE_INFINITY : turnStartedAt,
    ),
    newestFirstAgedLast(now),
  );
  const heldItems = new Set(awakeAsks.filter((ask) => ask.holds).map((ask) => ask.itemNo));
  const blocked = sorted(
    input.items
      .filter((item) => item.shownStatus === "blocked" && !heldItems.has(item.itemNo))
      .map((item): PmInboxRow => ({
        kind: "blocked",
        key: `item:${item.itemNo}`,
        at: item.updatedAt,
        mark: "blocked",
        unread: false,
        snoozedUntil: null,
        item,
      })),
    (a, b) => ms(b.at) - ms(a.at),
  );
  const rows = [...needs, ...blocked];

  const seenOnlyPages = needs.flatMap((row) =>
    row.kind === "pages"
      ? row.pages.map((page) => page.pageId)
      : row.kind === "page" && row.seenOnly
        ? [row.page.pageId]
        : [],
  );
  const todos = needs.flatMap((row) => (row.kind === "ask" && row.todo ? [row.ask.askNo] : []));

  const done = sorted(
    input.items
      .filter(
        (item) =>
          item.status === "finished" &&
          ms(item.finishedAt) >= turnStartedAt &&
          !(ms(item.archivedAt) >= ms(item.finishedAt)),
      )
      .map((item): PmInboxRow & { readonly kind: "finished" } => ({
        kind: "finished",
        key: `done:${item.itemNo}`,
        at: item.finishedAt!,
        mark: "finished",
        unread: false,
        snoozedUntil: null,
        item,
      })),
    (a, b) => ms(b.at) - ms(a.at),
  );

  const snoozed = sorted(
    [
      ...openAsks.filter((ask) => snoozedNow(ask.snoozedUntil, now)).map(askRow),
      ...openPages.filter((page) => snoozedNow(page.snoozedUntil, now)).map(pageRow),
    ],
    (a, b) => ms(a.snoozedUntil) - ms(b.snoozedUntil),
  );

  const recently = (at: string | null | undefined) => now - ms(at) <= ANSWERED_KEPT_MS;
  const answered: Array<PmInboxAnswered> = sorted<PmInboxAnswered>(
    [
      ...input.asks
        .filter(
          (ask) => (ask.state === "answered" || ask.state === "done") && recently(ask.settledAt),
        )
        .map((ask) => {
          const words = ask.answer?.trim() ?? "";
          return {
            key: `answered:ask:${ask.askNo}`,
            title: ask.title,
            outcome: words === "" || /^(answered|done)$/i.test(words) ? null : words,
            at: ask.settledAt!,
            messageId: ask.answerMessageId,
          };
        }),
      ...input.pages
        .filter((page) => page.state === "answered" && recently(page.settledAt))
        .map((page) => ({
          key: `answered:page:${page.pageId}`,
          title: page.title,
          outcome: null,
          at: page.settledAt!,
          messageId: page.answersMessageId,
        })),
    ],
    (a, b) => ms(b.at) - ms(a.at),
  ).slice(0, ANSWERED_MAX);

  return {
    rows,
    counts: {
      pings: needs.reduce(
        (count, row) =>
          count +
          (row.kind === "pages"
            ? row.pages.filter((page) => !page.openedAt).length
            : row.unread && row.mark !== "blocked"
              ? 1
              : 0),
        0,
      ),
      blocked: input.items.filter((item) => item.shownStatus === "blocked").length,
      inProgress: input.items.filter((item) => item.shownStatus === "in_progress").length,
    },
    archiveAll:
      seenOnlyPages.length + todos.length >= 2 ? { pageIds: seenOnlyPages, askNos: todos } : null,
    done,
    snoozed,
    answered,
  };
}

/** Ghostex's `dock_more_label`, counted: the UI words each part. */
export function pmInboxHidden(rows: ReadonlyArray<PmInboxRow>) {
  const blocked = rows.filter((row) => row.kind === "blocked").length;
  const done = rows.filter((row) => row.kind === "finished").length;
  return { pings: rows.length - blocked - done, blocked, done };
}

/** Ghostex's `row_asks_question`: a row that asks something has no Archive button. */
export const pmInboxAsksQuestion = (row: PmInboxRow) =>
  (row.kind === "ask" && !row.todo) || (row.kind === "page" && !row.seenOnly);

/** Ghostex's `age_label`: now, 5m, 3h, yesterday, 4d. */
export function pmInboxAge(
  at: string,
  now: number,
): { readonly unit: "now" | "m" | "h" | "yesterday" | "d"; readonly value: number } {
  const minutes = Math.max(0, Math.floor((now - ms(at)) / MINUTE_MS));
  if (Number.isNaN(minutes) || minutes === 0) return { unit: "now", value: 0 };
  if (minutes < 60) return { unit: "m", value: minutes };
  if (minutes < 1440) return { unit: "h", value: Math.floor(minutes / 60) };
  if (minutes < 2880) return { unit: "yesterday", value: 1 };
  return { unit: "d", value: Math.floor(minutes / 1440) };
}

export const pmSnoozeUntil = (now: number, hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now + hours * HOUR_MS));

/** Ghostex's `row_markdown`: an ask's title, description and answers; a page's open questions. */
export function pmInboxMarkdown(row: PmInboxRow): string {
  if (row.kind === "ask") {
    const { ask } = row;
    const answers =
      ask.answers.length === 0
        ? ""
        : `Answers: ${ask.answers.join(", ")}${ask.recommended ? ` (recommended: ${ask.recommended})` : ""}`;
    return [`## ${ask.title.trim()}`, ask.detail.trim(), answers].filter(Boolean).join("\n\n");
  }
  if (row.kind === "page") {
    const tags = row.page.questionTags.join(" ");
    return [`## ${row.page.title.trim()}`, tags ? `Open questions: ${tags}` : ""]
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}
