// t3code-pm: `pm_page_show`'s warning about a pick-one question that looks like several questions
// in one, ported from Ghostex's `visual check` (server/src/ghostex_cli/visual_choice_mix.rs, MIT).
// It warns and never refuses, and judges only the `<gx-choice>` lines the page wrote.

/** A pick-one list this long usually mixes kinds of choice; one-dimension lists of 6 read fine. */
const LONG_LIST = 7;
/** How many choices must share their part before ";" to read as two decisions crossed. */
const SHARED_PREFIX = 3;

interface WrittenQuestion {
  readonly tag: string;
  readonly title: string;
  readonly multiple: boolean;
  readonly text: boolean;
  readonly choices: ReadonlyArray<string>;
}

const attributesOf = (attrs: string): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  for (const match of attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
    found.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  return found;
};

const textOf = (html: string) =>
  html
    .replace(/<small[\s\S]*?<\/small>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

function writtenQuestions(html: string): ReadonlyArray<WrittenQuestion> {
  const questions: Array<WrittenQuestion> = [];
  for (const match of html.matchAll(/<gx-question\b([^>]*)>([\s\S]*?)<\/gx-question>/gi)) {
    const attrs = attributesOf(match[1] ?? "");
    questions.push({
      tag: attrs.get("tag") ?? "",
      title: attrs.get("title") ?? "",
      multiple: attrs.has("multiple"),
      text: (attrs.get("type") ?? "").toLowerCase() === "text",
      choices: [...(match[2] ?? "").matchAll(/<gx-choice\b[^>]*>([\s\S]*?)<\/gx-choice>/gi)].map(
        (choice) => textOf(choice[1] ?? ""),
      ),
    });
  }
  return questions;
}

/** The choice without a leading letter ("A. ", "B) ") the author may have written. */
const withoutLetter = (choice: string) =>
  choice
    .trimStart()
    .replace(/^[A-Za-z][.)] /, "")
    .trimStart();

function sharedPrefix(choices: ReadonlyArray<string>): { prefix: string; count: number } | null {
  const prefixes = choices.flatMap((choice) => {
    const text = withoutLetter(choice);
    const at = text.indexOf(";");
    const before = at < 0 ? "" : text.slice(0, at).trim();
    return before.length > 0 ? [before] : [];
  });
  let best: { prefix: string; count: number } | null = null;
  for (const prefix of prefixes) {
    const count = prefixes.filter((other) => other.toLowerCase() === prefix.toLowerCase()).length;
    if (count >= SHARED_PREFIX && (best === null || count > best.count)) best = { prefix, count };
  }
  return best;
}

/** One warning per pick-one question on the page that looks like it mixes kinds of choice. */
export function pmMixedChoiceWarnings(html: string): ReadonlyArray<string> {
  return writtenQuestions(html).flatMap((question, index) => {
    if (question.multiple || question.text) return [];
    const signs: Array<string> = [];
    if (question.choices.length >= LONG_LIST)
      signs.push(
        `it has ${question.choices.length} pick-one choices, and a list that long usually mixes kinds of choice (a look, a layout, extras)`,
      );
    const shared = sharedPrefix(question.choices);
    if (shared !== null)
      signs.push(
        `${shared.count} of its choices start "${shared.prefix};", so two decisions are crossed in one list (the part before ";" and the part after it)`,
      );
    if (signs.length === 0) return [];
    const label = question.tag.length > 0 ? question.tag : `Question ${index + 1}`;
    return [
      `Warning: ${label} ("${question.title}"): ${signs.join("; and ")}. Ask one question per kind of choice, and add \`multiple\` wherever the choices can combine, so a mix is several picks instead of Other and a note.`,
    ];
  });
}
