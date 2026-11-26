/** A conversation message as both the thread and a parsed transcript carry it. */
export interface SyncMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** A thread message, and whether it came from the transcript (import or live sync). */
export interface StoredMessage extends SyncMessage {
  readonly fromTranscript: boolean;
}

/** Messages that must match to place the thread's history inside a re-read transcript. */
const ANCHOR_LENGTH = 3;

const same = (left: SyncMessage, right: SyncMessage) =>
  left.role === right.role && left.text === right.text;

function afterAnchor<M extends SyncMessage>(
  anchor: ReadonlyArray<SyncMessage>,
  transcript: ReadonlyArray<M>,
): ReadonlyArray<M> | null {
  if (anchor.length === 0) return null;
  for (let end = transcript.length - 1; end >= anchor.length - 1; end--) {
    const start = end - anchor.length + 1;
    if (anchor.every((message, offset) => same(message, transcript[start + offset]!))) {
      return transcript.slice(end + 1);
    }
  }
  return null;
}

/**
 * Transcript messages after the thread's last few, falling back to its transcript-sourced ones
 * since app turns on other providers never reach the transcript. Skips what the app shows; null
 * when the history can't be placed (rewritten, cleared or compacted).
 */
export function messagesToAppend<M extends SyncMessage>(
  stored: ReadonlyArray<StoredMessage>,
  transcript: ReadonlyArray<M>,
): ReadonlyArray<M> | null {
  const fresh =
    afterAnchor(stored.slice(-ANCHOR_LENGTH), transcript) ??
    afterAnchor(
      stored.filter((message) => message.fromTranscript).slice(-ANCHOR_LENGTH),
      transcript,
    );
  if (fresh === null) return null;
  const fromApp = stored.filter((message) => !message.fromTranscript);
  return fresh.filter((message) => !fromApp.some((shown) => same(shown, message)));
}

/** The next free index for imported message ids, which end in a six-digit index. */
export function nextImportedMessageIndex(messageIds: ReadonlyArray<string>): number {
  let next = 0;
  for (const id of messageIds) {
    const match = /:(\d{6,})$/.exec(id);
    if (match !== null) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

export interface SettledRunAnchor {
  readonly id: string;
  readonly ordinal: number;
  readonly anchorMs: number;
}

export interface TimelineItemSummary {
  readonly id: string;
  readonly runId: string | null;
  readonly ordinal: number;
  readonly timestampMs: number;
}

export interface RepositionedTurnItem {
  readonly id: string;
  readonly ordinal: number;
}

/**
 * Plans exact chronological ordinals for `runId: null` (imported / live-synced) turn items on a
 * thread that also has settled app runs. Each run occupies `[run.ordinal * 1_000_000, +999_999]`;
 * transcript items created after a settled run belong immediately after that run's own items,
 * sorted strictly by `(timestampMs, id)`. Returns only items whose ordinal changes.
 */
export function planTurnItemOrderRepair(input: {
  readonly runs: ReadonlyArray<SettledRunAnchor>;
  readonly items: ReadonlyArray<TimelineItemSummary>;
}): ReadonlyArray<RepositionedTurnItem> {
  if (input.runs.length === 0) return [];
  const runs = [...input.runs].toSorted((left, right) => left.ordinal - right.ordinal);

  const maxOwnOrdinalByBand = new Map<number, number>();
  for (const run of runs) {
    maxOwnOrdinalByBand.set(run.ordinal, run.ordinal * 1_000_000);
  }
  for (const item of input.items) {
    if (item.runId === null) continue;
    const band = Math.floor(item.ordinal / 1_000_000);
    const current = maxOwnOrdinalByBand.get(band);
    if (current !== undefined && item.ordinal > current) {
      maxOwnOrdinalByBand.set(band, item.ordinal);
    }
  }

  const byBand = new Map<number, Array<TimelineItemSummary>>();
  for (const item of input.items) {
    if (item.runId !== null) continue;
    let targetBand = 0;
    for (const run of runs) {
      if (run.anchorMs <= item.timestampMs) {
        targetBand = run.ordinal;
      }
    }
    let group = byBand.get(targetBand);
    if (group === undefined) {
      group = [];
      byBand.set(targetBand, group);
    }
    group.push(item);
  }

  const updates: Array<RepositionedTurnItem> = [];
  for (const [band, group] of byBand.entries()) {
    group.sort(
      (left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
    );
    if (band === 0) {
      const anyOutOfBand = group.some((item) => item.ordinal >= 1_000_000);
      if (!anyOutOfBand) continue;
      for (const [offset, item] of group.entries()) {
        const desired = offset + 1;
        if (item.ordinal !== desired) updates.push({ id: item.id, ordinal: desired });
      }
      continue;
    }
    const base = maxOwnOrdinalByBand.get(band) ?? band * 1_000_000;
    for (const [offset, item] of group.entries()) {
      const desired = base + 1 + offset;
      if (item.ordinal !== desired) updates.push({ id: item.id, ordinal: desired });
    }
  }
  return updates;
}
