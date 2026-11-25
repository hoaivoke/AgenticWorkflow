// t3code-pm: pure guards on the questions a PM asks the user with `pm_ask`, ported from Ghostex's
// coordinator ask guard (server/src/coordinators/ask_guard.rs) and its to-do paste refusal
// (server/src/session_needs_you/store.rs `paste_refusal`), MIT.

/** Shortest description, whitespace collapsed, that lets the user decide without the chat. */
export const PM_MIN_DETAIL_CHARS = 120;

const DIRECT_POINTER_PHRASES = [
  "on the live page",
  "in the live page",
  "see the live page",
  "open the live page",
  "check the live page",
  "answer the live page",
  "review the live page",
  "use the live page",
  "on the page",
  "in the page",
  "see the page",
  "answer the page",
  "on the form",
  "in the form",
  "see the form",
  "open the form",
  "answer the form",
  "check the form",
  "fill out the form",
  "fill in the form",
  "on the question form",
  "in the question form",
  "on the questions form",
  "in the questions form",
  "the live page above",
  "the page above",
  "the form above",
  "the live page in chat",
  "the page in chat",
  "the form in chat",
];

const POINTER_VERB_LEADS = [
  ["pick", "on", "the"],
  ["pick", "in", "the"],
  ["pick", "from", "the"],
  ["answer", "on", "the"],
  ["answer", "in", "the"],
  ["answer", "the"],
  ["choose", "on", "the"],
  ["choose", "in", "the"],
  ["vote", "on", "the"],
  ["respond", "on", "the"],
  ["respond", "in", "the"],
  ["select", "on", "the"],
];
const EXPLICIT_SURFACE_LEADS = [
  ["on", "the"],
  ["in", "the"],
  ["see", "the"],
  ["open", "the"],
  ["check", "the"],
  ["review", "the"],
  ["use", "the"],
];
const ANY_SURFACE_TARGETS = [
  ["live", "page"],
  ["questions", "form"],
  ["question", "form"],
  ["page"],
  ["form"],
];
const EXPLICIT_SURFACE_TARGETS = [
  ["live", "page"],
  ["questions", "form"],
  ["question", "form"],
];
const MAX_POINTER_GAP_WORDS = 6;

/** `text` without anything inside "double quotes", “curly quotes” or `backticks`. */
const unquoted = (text: string) => text.replace(/"[^"]*"?|“[^”]*”?|`[^`]*`?/g, "");

const normalizedWords = (text: string) =>
  unquoted(text)
    .replaceAll("’", "'")
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word.length > 0);

const matchesAt = (words: ReadonlyArray<string>, at: number, pattern: ReadonlyArray<string>) =>
  words.length >= at + pattern.length &&
  pattern.every((word, offset) => words[at + offset] === word);

function leadTarget(
  words: ReadonlyArray<string>,
  leads: ReadonlyArray<ReadonlyArray<string>>,
  targets: ReadonlyArray<ReadonlyArray<string>>,
): string | null {
  for (let start = 0; start < words.length; start++) {
    for (const lead of leads) {
      if (!matchesAt(words, start, lead)) continue;
      for (let gap = 0; gap <= MAX_POINTER_GAP_WORDS; gap++) {
        const at = start + lead.length + gap;
        if (at >= words.length) break;
        const target = targets.find((candidate) => matchesAt(words, at, candidate));
        if (target) return words.slice(start, at + target.length).join(" ");
      }
    }
  }
  return null;
}

/** The phrase in `text` that sends the user to a Live page instead of asking, if any. */
export function pmPointerPhrase(text: string): string | null {
  const words = normalizedWords(text);
  if (words.length === 0) return null;
  const joined = ` ${words.join(" ")} `;
  return (
    DIRECT_POINTER_PHRASES.find((phrase) => joined.includes(` ${phrase} `)) ??
    leadTarget(words, POINTER_VERB_LEADS, ANY_SURFACE_TARGETS) ??
    leadTarget(words, EXPLICIT_SURFACE_LEADS, EXPLICIT_SURFACE_TARGETS)
  );
}

const BOUNDARY = String.raw`(?<![\p{L}\p{N}\-_/.@#])`;
const END = String.raw`(?![\p{L}\p{N}\-_/]|\.[\p{L}\p{N}])`;
const INTERNAL_REF = new RegExp(
  [
    String.raw`(?<item>[Ww][1-9]\d*)`,
    String.raw`(?<ask>[Qq][1-9]\d*)`,
    String.raw`(?<worker>pm-worker-[0-9a-z]+)`,
    String.raw`(?<uuid>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})`,
    String.raw`(?<hex>[0-9a-fA-F]{7,})`,
  ]
    .map((part) => `${BOUNDARY}${part}${END}`)
    .join("|"),
  "gu",
);

const commitLike = (token: string) =>
  /\d/.test(token) && /[a-fA-F]/.test(token) && !(/[a-f]/.test(token) && /[A-F]/.test(token));

/**
 * Internal references in a title, outside quotes and backticks, once each: work-item and question
 * tags, worker thread ids (PM3code's `pm-worker-…`, a UUID or one of `threadIds`) and commit-like
 * hex of 7+ characters.
 */
export function pmInternalRefs(
  title: string,
  threadIds: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const text = unquoted(title);
  const found: Array<string> = [];
  const push = (token: string) => {
    if (!found.some((seen) => seen.toLowerCase() === token.toLowerCase())) found.push(token);
  };
  for (const id of threadIds) if (id.length > 0 && text.includes(id)) push(id);
  for (const match of text.matchAll(INTERNAL_REF)) {
    const groups = match.groups ?? {};
    if (groups.item) push(`W${groups.item.slice(1)}`);
    else if (groups.ask) push(`Q${groups.ask.slice(1)}`);
    else if (groups.worker) push(groups.worker);
    else if (groups.uuid) push(groups.uuid);
    else if (groups.hex && commitLike(groups.hex)) push(groups.hex);
  }
  return found;
}

const collapsedLength = (text: string) => text.split(/\s+/).filter(Boolean).join(" ").length;

/**
 * Why `pm_ask` refuses a question, or null when it may stand: it points at a Live page, its title
 * holds internal references, or its description is missing or too thin to decide from.
 */
export function pmAskRefusal(input: {
  readonly title: string;
  readonly detail: string;
  /** The PM's work items, so a `W<n>` names the item it means. */
  readonly items?: ReadonlyArray<{ readonly itemNo: number; readonly title: string }>;
  /** The PM's worker thread ids. */
  readonly threadIds?: ReadonlyArray<string>;
}): string | null {
  const problems: Array<string> = [];
  const phrase = pmPointerPhrase(input.title) ?? pmPointerPhrase(input.detail);
  if (phrase !== null)
    problems.push(
      `Do not ask a question that points at a Live page (matched "${phrase}"). A Live page asks its own questions; remove this ask and let the page collect the answer directly.`,
    );
  const refs = pmInternalRefs(input.title, input.threadIds);
  if (refs.length > 0) {
    const named = refs.flatMap((token) => {
      const item = /^W(\d+)$/.exec(token)
        ? input.items?.find((entry) => `W${entry.itemNo}` === token)
        : undefined;
      return item && item.title.trim().length > 0 ? [`${token} ("${item.title.trim()}")`] : [];
    });
    problems.push(
      `The title contains internal references (${refs.join(", ")}) that mean nothing to someone who has been away for a day. Remove work-item tags (W12), question tags (Q48), worker thread ids and commit hashes from the title, and name the subject in plain words instead.${named.length > 0 ? ` Matching work items: ${named.join(", ")}.` : ""}`,
    );
  }
  const length = collapsedLength(input.detail);
  if (length === 0)
    problems.push(
      `Missing description: pass detail with at least ${PM_MIN_DETAIL_CHARS} characters so the user can decide without opening the chat or reading anything else. Include what it is in plain words, what each answer does, what you recommend and why, any risks, and links.`,
    );
  else if (length < PM_MIN_DETAIL_CHARS)
    problems.push(
      `Description is too short (${length} characters; minimum is ${PM_MIN_DETAIL_CHARS}) for the user to decide without extra context. Expand detail to cover what it is in plain words, what each answer does, what you recommend and why, any risks, and links.`,
    );
  if (problems.length <= 1) return problems[0] ?? null;
  return `This question cannot be asked yet:\n- ${problems.join("\n- ")}`;
}

const ACT_VERBS = [
  "paste",
  "post",
  "copy",
  "send",
  "reply",
  "run",
  "type",
  "enter",
  "sign in",
  "open",
];

/**
 * Why a to-do (an ask with no answers, or only Done) that asks the user to paste, post, run or open
 * something is refused, or null: its detail must hold the ``` text, the link or the `command`.
 */
export function pmTodoRefusal(input: {
  readonly title: string;
  readonly detail: string;
  readonly answers: ReadonlyArray<string>;
}): string | null {
  const todo = input.answers
    .map((answer) => answer.trim())
    .filter((answer) => answer.length > 0)
    .every((answer) => answer.toLowerCase() === "done");
  if (!todo) return null;
  const words = input.title
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.toLowerCase());
  const first = words[0];
  if (first === undefined) return null;
  if (!ACT_VERBS.some((verb) => verb === first || verb === words.join(" "))) return null;
  const hasLink = /https?:\/\//.test(input.detail);
  const hasCode = input.detail.includes("```") || (input.detail.match(/`/g)?.length ?? 0) >= 2;
  if (hasLink || hasCode) return null;
  const lead = input.title.trim().split(/\s+/)[0] ?? input.title;
  return `"${lead} …" asks the user to act, but its detail holds no text, link or command for it. Put the text to paste in a \`\`\` block in detail (and the link where it goes), or the link or \`command\` itself, so the user can do it from Details.`;
}
