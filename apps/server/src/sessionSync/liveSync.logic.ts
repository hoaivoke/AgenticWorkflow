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
