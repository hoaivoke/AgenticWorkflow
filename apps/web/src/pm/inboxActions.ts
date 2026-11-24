import type { EnvironmentId, PmPageSummary, PmShownItemStatus, ThreadId } from "@t3tools/contracts";
import { pmSnoozeUntil, type PmInboxRecent, type PmInboxRow } from "@t3tools/pm/client";
import { msg } from "gt-react";

import { readComposerDraftPrompt, useComposerDraftStore } from "../composerDraftStore";
import { m } from "../i18n/messages";
import { selectThreadPanelOpen, useRightPanelStore } from "../rightPanelStore";
import { runPmCommand } from "./actions";
import { pmCommands, pmKey } from "./state";
import { openPmPage, setPmFold, setPmRecentArchived } from "./uiState";

export interface InboxTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** What one Archive or Dismiss did, for the Inbox's Undo bar. */
export interface InboxUndo {
  readonly count: number;
  readonly undo: () => Promise<void>;
}

const askTarget = (target: InboxTarget, askNo: number) => ({
  environmentId: target.environmentId,
  input: { pm: target.threadId, ask: askNo },
});
const pageTarget = (target: InboxTarget, pageId: string) => ({
  environmentId: target.environmentId,
  input: { pageId },
});

export const answerAsk = (target: InboxTarget, askNo: number, answer: string) =>
  runPmCommand(
    pmCommands.askAnswer,
    { environmentId: target.environmentId, input: { pm: target.threadId, ask: askNo, answer } },
    m(msg("Could not send the answer")),
  );

/** A page's Reply: its words reach the PM tagged with the page's questions, and the page closes. */
export const replyToPage = (target: InboxTarget, pageId: string, reply: string) =>
  runPmCommand(
    pmCommands.pageMarkSeen,
    { environmentId: target.environmentId, input: { pageId, reply } },
    m(msg("Could not send the reply")),
  );

export async function openInboxPage(target: InboxTarget, page: PmPageSummary) {
  openPmPage({ threadKey: pmKey(target.environmentId, target.threadId), pageId: page.pageId });
  if (!page.openedAt)
    await runPmCommand(
      pmCommands.pageOpen,
      pageTarget(target, page.pageId),
      m(msg("Could not open the page")),
    );
}

export async function snoozeRow(target: InboxTarget, row: PmInboxRow, hours: number | null) {
  const until = hours === null ? null : pmSnoozeUntil(Date.now(), hours);
  if (row.kind === "ask") {
    await (until === null
      ? runPmCommand(
          pmCommands.askWake,
          askTarget(target, row.ask.askNo),
          m(msg("Could not unsnooze")),
        )
      : runPmCommand(
          pmCommands.askSnooze,
          {
            environmentId: target.environmentId,
            input: { pm: target.threadId, ask: row.ask.askNo, until },
          },
          m(msg("Could not snooze")),
        ));
  } else if (row.kind === "page") {
    await runPmCommand(
      pmCommands.pageSnooze,
      { environmentId: target.environmentId, input: { pageId: row.page.pageId, until } },
      until === null ? m(msg("Could not unsnooze")) : m(msg("Could not snooze")),
    );
  }
}

async function archivePages(target: InboxTarget, pageIds: ReadonlyArray<string>) {
  const done: Array<string> = [];
  for (const pageId of pageIds) {
    const ok = await runPmCommand(
      pmCommands.pageMarkSeen,
      { environmentId: target.environmentId, input: { pageId } },
      m(msg("Could not archive the page")),
    );
    if (ok !== null) done.push(pageId);
  }
  return done;
}

async function dismissAsks(target: InboxTarget, askNos: ReadonlyArray<number>) {
  const done: Array<number> = [];
  for (const askNo of askNos) {
    const ok = await runPmCommand(
      pmCommands.askDismiss,
      askTarget(target, askNo),
      m(msg("Could not dismiss the question")),
    );
    if (ok !== null) done.push(askNo);
  }
  return done;
}

/** Archive all, or one row's Archive or Dismiss: nothing reaches the PM until its next message. */
export async function archive(
  target: InboxTarget,
  input: { readonly pageIds?: ReadonlyArray<string>; readonly askNos?: ReadonlyArray<number> },
): Promise<InboxUndo | null> {
  const pages = await archivePages(target, input.pageIds ?? []);
  const asks = await dismissAsks(target, input.askNos ?? []);
  const count = pages.length + asks.length;
  if (count === 0) return null;
  return {
    count,
    undo: async () => {
      for (const pageId of pages)
        await runPmCommand(
          pmCommands.pageReopen,
          pageTarget(target, pageId),
          m(msg("Could not undo the archive")),
        );
      for (const askNo of asks)
        await runPmCommand(
          pmCommands.askUndoDismiss,
          askTarget(target, askNo),
          m(msg("Could not undo the dismiss")),
        );
    },
  };
}

export async function archiveDone(
  target: InboxTarget,
  items: ReadonlyArray<number>,
): Promise<InboxUndo | null> {
  const run = (archived: boolean) =>
    runPmCommand(
      pmCommands.itemArchive,
      { environmentId: target.environmentId, input: { pm: target.threadId, items, archived } },
      archived ? m(msg("Could not archive")) : m(msg("Could not undo the archive")),
    );
  if ((await run(true)) === null) return null;
  return { count: items.length, undo: async () => void (await run(false)) };
}

/** Recent's Archive all: finished work is archived on the server, answers only here. */
export async function archiveRecent(
  target: InboxTarget,
  recent: ReadonlyArray<PmInboxRecent>,
): Promise<InboxUndo | null> {
  const items = recent.flatMap((row) => (row.kind === "finished" ? [row.item.itemNo] : []));
  const handled = recent.flatMap((row) => (row.kind === "handled" ? [row.key] : []));
  const done = items.length > 0 ? await archiveDone(target, items) : null;
  if (items.length > 0 && done === null) return null;
  const key = pmKey(target.environmentId, target.threadId);
  setPmRecentArchived(key, handled, true);
  return {
    count: recent.length,
    undo: async () => {
      setPmRecentArchived(key, handled, false);
      await done?.undo();
    },
  };
}

/** The row's tag where the caret is: Ghostex's Mention in chat box. */
export function mentionInComposer(target: InboxTarget, mention: string) {
  const ref = { environmentId: target.environmentId, threadId: target.threadId };
  const prompt = readComposerDraftPrompt(ref) ?? "";
  const glue = prompt.length === 0 || /\s$/.test(prompt) ? "" : " ";
  useComposerDraftStore.getState().setPrompt(ref, `${prompt}${glue}${mention} `);
  focusComposer();
}

export function focusComposer() {
  document.querySelector<HTMLElement>('[data-testid="composer-editor"]')?.focus();
}

/** Scrolls the chat to a message when it is drawn; false when it is not loaded here. */
export function showMessageInChat(messageId: string): boolean {
  const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (row === null) return false;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

/** A count's click: the details panel's Work items, at that group, opened. */
export function openWorkGroup(target: InboxTarget, status: PmShownItemStatus) {
  const ref = { environmentId: target.environmentId, threadId: target.threadId };
  setPmFold(`items:${pmKey(target.environmentId, target.threadId)}:${status}`, true);
  const store = useRightPanelStore.getState();
  // The panel docks or floats by the window's room; open it in both so whichever shows is open.
  for (const presentation of ["inline", "popover"] as const)
    if (!selectThreadPanelOpen(store.threadPanelVisibilityByThreadKey, ref, presentation))
      store.setThreadPanelOpen(ref, presentation, true);
  // The panel mounts on the next frame.
  requestAnimationFrame(() =>
    document
      .querySelector(`[data-pm-group="${status}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" }),
  );
}
