/** A conversation message as both the thread and a parsed transcript carry it. */
export interface SyncMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Messages that must match to place the thread's history inside a re-read transcript. */
const ANCHOR_LENGTH = 3;

const same = (left: SyncMessage, right: SyncMessage) =>
  left.role === right.role && left.text === right.text;

/**
 * The transcript messages that come after everything the thread already shows. The thread's
 * last few messages are found in the transcript, newest occurrence first, and what follows
 * them is new. Returns null when the thread's history cannot be found in the transcript (it
 * was rewritten, cleared or compacted), so nothing is added out of order.
 */
export function messagesToAppend<M extends SyncMessage>(
  stored: ReadonlyArray<SyncMessage>,
  transcript: ReadonlyArray<M>,
): ReadonlyArray<M> | null {
  if (stored.length === 0) return null;
  const anchor = stored.slice(-ANCHOR_LENGTH);
  for (let end = transcript.length - 1; end >= anchor.length - 1; end--) {
    const start = end - anchor.length + 1;
    if (anchor.every((message, offset) => same(message, transcript[start + offset]!))) {
      return transcript.slice(end + 1);
    }
  }
  return null;
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
