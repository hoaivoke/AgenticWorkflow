import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { pmSnoozeUntil, type PmInboxRecent, type PmInboxRow } from "@t3tools/pm/client";
import { msg } from "gt-react-native";

import { m } from "../i18n/messages";
import { appendComposerDraftText, getComposerDraftSnapshot } from "../state/use-composer-drafts";
import { runPm } from "./actions";
import { pmCommands } from "./state";

// t3code-pm: the Inbox's actions on the phone, the web's apps/web/src/pm/inboxActions.ts.

export interface InboxTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface InboxUndo {
  readonly count: number;
  readonly undo: () => Promise<void>;
}

const askInput = (target: InboxTarget, askNo: number) => ({
  environmentId: target.environmentId,
  input: { pm: target.threadId, ask: askNo },
});

export const answerAsk = (target: InboxTarget, askNo: number, answer: string) =>
  runPm(
    pmCommands.askAnswer,
    { environmentId: target.environmentId, input: { pm: target.threadId, ask: askNo, answer } },
    m(msg("Could not send the answer")),
  );

export const replyToPage = (target: InboxTarget, pageId: string, reply: string) =>
  runPm(
    pmCommands.pageMarkSeen,
    { environmentId: target.environmentId, input: { pageId, reply } },
    m(msg("Could not send the reply")),
  );

export const markPageOpened = (target: InboxTarget, pageId: string) =>
  runPm(
    pmCommands.pageOpen,
    { environmentId: target.environmentId, input: { pageId } },
    m(msg("Could not open the page")),
  );

export async function snoozeRow(target: InboxTarget, row: PmInboxRow, hours: number | null) {
  const until = hours === null ? null : pmSnoozeUntil(Date.now(), hours);
  if (row.kind === "ask")
    await (until === null
      ? runPm(pmCommands.askWake, askInput(target, row.ask.askNo), m(msg("Could not unsnooze")))
      : runPm(
          pmCommands.askSnooze,
          {
            environmentId: target.environmentId,
            input: { pm: target.threadId, ask: row.ask.askNo, until },
          },
          m(msg("Could not snooze")),
        ));
  else if (row.kind === "page")
    await runPm(
      pmCommands.pageSnooze,
      { environmentId: target.environmentId, input: { pageId: row.page.pageId, until } },
      until === null ? m(msg("Could not unsnooze")) : m(msg("Could not snooze")),
    );
}

/** Archive all, or one row's Archive or Dismiss; Undo puts them back. */
export async function archive(
  target: InboxTarget,
  input: { readonly pageIds?: ReadonlyArray<string>; readonly askNos?: ReadonlyArray<number> },
): Promise<InboxUndo | null> {
  const pages: Array<string> = [];
  for (const pageId of input.pageIds ?? []) {
    const done = await runPm(
      pmCommands.pageMarkSeen,
      { environmentId: target.environmentId, input: { pageId } },
      m(msg("Could not archive the page")),
    );
    if (done !== null) pages.push(pageId);
  }
  const asks: Array<number> = [];
  for (const askNo of input.askNos ?? []) {
    const done = await runPm(
      pmCommands.askDismiss,
      askInput(target, askNo),
      m(msg("Could not dismiss the question")),
    );
    if (done !== null) asks.push(askNo);
  }
  if (pages.length + asks.length === 0) return null;
  return {
    count: pages.length + asks.length,
    undo: async () => {
      for (const pageId of pages)
        await runPm(
          pmCommands.pageReopen,
          { environmentId: target.environmentId, input: { pageId } },
          m(msg("Could not undo the archive")),
        );
      for (const askNo of asks)
        await runPm(
          pmCommands.askUndoDismiss,
          askInput(target, askNo),
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
    runPm(
      pmCommands.itemArchive,
      { environmentId: target.environmentId, input: { pm: target.threadId, items, archived } },
      archived ? m(msg("Could not archive")) : m(msg("Could not undo the archive")),
    );
  if ((await run(true)) === null) return null;
  return { count: items.length, undo: async () => void (await run(false)) };
}

/** Recent's Archive all: finished work is archived on the server, answers only on this phone. */
export async function archiveRecent(
  target: InboxTarget,
  recent: ReadonlyArray<PmInboxRecent>,
  setHandled: (keys: ReadonlyArray<string>, archived: boolean) => void,
): Promise<InboxUndo | null> {
  const items = recent.flatMap((row) => (row.kind === "finished" ? [row.item.itemNo] : []));
  const handled = recent.flatMap((row) => (row.kind === "handled" ? [row.key] : []));
  const done = items.length > 0 ? await archiveDone(target, items) : null;
  if (items.length > 0 && done === null) return null;
  setHandled(handled, true);
  return {
    count: recent.length,
    undo: async () => {
      setHandled(handled, false);
      await done?.undo();
    },
  };
}

/** Ghostex's Mention in chat box: the row's tag at the end of the chat box. */
export function mentionInComposer(draftKey: string | null, mention: string) {
  if (draftKey === null) return;
  const text = getComposerDraftSnapshot(draftKey).text;
  const glue = text.length === 0 || /\s$/.test(text) ? "" : " ";
  appendComposerDraftText(draftKey, `${glue}${mention} `);
}
