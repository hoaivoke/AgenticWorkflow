// t3code-pm: the "Live pages" part of Ghostex's visuals guide (visual_guide.md, MIT, f4c43e4ab),
// served by `pm_guide({ pages: true })`. Forms, `visual check`, exports and share links are left
// out (PM3code has none); a question's `<p>` needs 120+ characters, not "a short explanation".

export const PM_PAGE_GUIDE = `# Live pages

A Live page is one self-contained HTML page you publish with \`pm_page_show\` for the user to look
at and answer: mockups to compare, a layout to react to, a report to read. PM3code puts its page kit
in front of it (the theme, the layout and the question kit), so write only the content.

## Skeleton

\`\`\`html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Changes view: one scope toggle</title>
<style>
  /* Only what your mockups need: no page chrome (see below). */
</style>
</head>
<body>
<gx-page>
  <header>
    <span class="gx-eyebrow">Changes view</span>
    <h1>One scope toggle</h1>
    <p class="gx-lede">What this page is for, in a sentence or two.</p>
  </header>

  <h2>Today</h2>
  <p>What the reader should notice.</p>
  <figure class="gx-figure">
    <div class="gx-frame"><!-- the mockup, at its real size --></div>
    <figcaption>Drawn from src/changes/View.tsx</figcaption>
  </figure>
</gx-page>
</body>
</html>
\`\`\`

## Title

Give every page a short, specific, human title (\`pm_page_show\`'s \`title\`, and the same in
\`<title>\` and \`<h1>\`): what it asks or shows, the way you would name it to the reader, such as
"Changes view: one scope toggle". PM3code uses it as the page's name in the chat card and the
Inbox. Never a generic title ("Questions", "Mockups", "Report", "Options", "Page"). The eyebrow can
carry the area.

## Layout

- Everything goes in \`<gx-page>\`, which centres its children in one 720px column. Text, notes,
  mockups up to 720px wide and question cards all sit there.
- Use \`<gx-wide>\` only for something wider than the column: a mockup of a whole window, or
  variants side by side. It is a centred band up to 1120px. \`<gx-wide size="full">\` spans the
  whole window; it is rarely needed.
- A mockup keeps its real size: give the mockup itself a fixed width and put it inside a
  \`.gx-frame\`, which scrolls sideways on a narrow window instead of squeezing it. Put notes and
  captions above or below it, never beside it.

## Phones, foldables and large text

Every page must read well at any width from a 360px phone through a 900px foldable or tablet to a
computer, and with the phone's large text setting. Readers often open pages in the PM3code phone
app. Design mobile-first: write one column, then let it widen.

- Side by side only in rows that wrap: options in a \`.gx-options\` row, cards in a \`.gx-grid\`,
  stats in \`.gx-stats\`, or your own \`grid-template-columns: repeat(auto-fit, minmax(min(100%,
  280px), 1fr))\`. Pick the minimum from the widest thing a column holds (\`--gx-option-min\` on a
  \`.gx-options\` row, \`--gx-grid-min\` on a \`.gx-grid\`). Never a bare \`1fr 1fr\` grid, a row of
  fixed widths, or a breakpoint that only switches at 600px: a foldable is 700 to 900px wide.
- Grid and flex children that hold text get \`min-width: 0\`, and their text must wrap: no
  \`white-space: nowrap\` on anything longer than a pill, and \`overflow-wrap: anywhere\` on long
  paths, URLs and commands.
- Pills, chips, badges, keys and IDs get \`white-space: nowrap\` and \`flex: none\`.
- Anything with a real, fixed width (a device frame, a toolbar, a panel mockup) gets that width on
  itself and goes in a \`.gx-frame\`. Never give the \`.gx-frame\` itself a \`width\` or \`min-width\`.
- No \`overflow: hidden\` on text without \`text-overflow: ellipsis\`, no fixed heights on boxes of
  text, and nothing placed over text. Outside a \`.gx-frame\`: no \`width\` or \`min-width\` over
  360px and no \`100vw\`.
- Images shrink to the column by themselves.

## No page chrome of your own

The kit gives the page its look, so a page that styles itself fights it:

- No colours, backgrounds or fonts on \`html\`, \`body\` or \`:root\`, no \`color-scheme\`, no padding
  or margins on \`body\`, and no container or \`max-width\` wrapper of your own.
- No Dark / Light switch: a page follows PM3code's theme.
- No toolbars, buttons, tabs, callouts or cards of your own: use these.
  - \`<span class="gx-eyebrow">\`, \`<h1>\`, \`<p class="gx-lede">\` in the \`<header>\`; \`<h2>\` for
    sections, \`<h3>\` for parts.
  - \`<div class="gx-callout">\` (add \`data-tone="warn"\`, \`"good"\` or \`"bad"\`).
  - \`<div class="gx-card">\`, several in a \`<div class="gx-grid">\`.
  - Options compared side by side: \`<div class="gx-options">\` holding one tied
    \`<section data-question data-choice>\` per option (see "Questions"), a
    \`<span class="gx-ribbon">Recommended</span>\` on the recommended one,
    \`<div class="gx-chips"><span class="gx-chip"><b>38</b> files</span></div>\` for small facts and
    \`<div class="gx-stats"><div class="gx-stat"><small>Time</small><b>28m</b></div></div>\` for
    the numbers each option is judged by.
  - \`<figure class="gx-figure">\` with an \`<img>\` or a \`.gx-frame\`, and a \`<figcaption>\`.
  - \`<gx-tabs>\` with one child per tab: \`<section data-tab="Before">…\`. The kit adds the tab bar.
  - \`<span class="gx-seg"><button aria-pressed="true">A</button><button>B</button></span>\` for a
    segmented control, \`<button class="gx-button">\` (add \`gx-primary\` for the main action).
  - Tables, lists, \`<code>\` and \`<pre>\` are styled already.

## Theme

Leave \`html\` and \`body\` backgrounds transparent: the kit paints the page. Style what you draw
with the theme tokens, so it reads right in dark and light: \`--gx-bg\`, \`--gx-surface\`,
\`--gx-raised\`, \`--gx-card\` and \`--gx-card-border\`, \`--gx-line\`, \`--gx-line-strong\`, \`--gx-fg\`
(titles), \`--gx-text\`, \`--gx-muted\`, \`--gx-accent\`, \`--gx-pick\`, \`--gx-warn\`, \`--gx-good\`,
\`--gx-bad\`, \`--gx-code-bg\`, \`--chart-1\` … \`--chart-6\`, \`--font-sans\` and \`--font-mono\`. Never
an opaque black or grey slab around your own content. A mockup of an app window is the exception.

## Mockups that look like the app

A mockup is judged against the app it draws. Before drawing, look at the real view (a screenshot)
and read its colours, radii, fonts and sizes from the app's source.

- **Opaque, in the app's own palette.** Solid fills from the app's source: the dark set on the
  mockup's class, the light set under \`[data-gx-theme=light]\`. Never translucent fills or
  \`backdrop-filter\` inside a mockup. Frame it as a window (a hairline, its real radius, a soft
  shadow).
- **Real logos and icons, never letter avatars.** Inline the app's own artwork.
- **State, quietly.** One word, or a small dot and a word, in the muted text colour. At most one
  accent colour in the whole mockup. Neutral buttons, one primary.
- **Real sizes**, and **nothing stray**: every word inside the mockup is one the app shows.

## Make it look good

- **A strong top.** A short \`.gx-eyebrow\` (area · purpose), a specific \`<h1>\` that says what is
  being decided, a one-line \`.gx-lede\`, and a row of \`.gx-chip\` facts. The first options start
  right under it.
- **Compare side by side.** Two to four options in one \`.gx-options\` row inside \`<gx-wide>\`,
  each a tied section: a title (\`A. Name\`, the kit adds its Pick button), one line on how it
  works, a small but real picture, and the two or three \`.gx-stat\` numbers it is judged by. Draw
  every option on the same scale. Mark the recommended one with a \`.gx-ribbon\` and \`recommended\`.
- **Then one question.** The \`<gx-question>\` sits directly under the row, its choices in the same
  order. When every choice has its tied variant, the question shows only what was picked and its
  note, so put each option's trade-off on its card.
- **One question per dimension.** When the variants differ in more than one way (a look, a layout,
  extras), split them: one \`.gx-options\` row and one question for each kind of choice, never one
  long list that mixes them, so A + D + G is three picks, not Other and a note. Give a question
  \`multiple\` unless its choices truly exclude each other, and when they do, say why in its \`<p>\`
  ("one surface only"). Say there that a mix is welcome in the note, and mark every choice you
  recommend. \`pm_page_show\` warns about a pick-one list that looks like several kinds of choice.
  When the answers arrive, say the combined pick back in one line ("Building A + D + G").
- **Not too long.** Header, options and question fit roughly one screen. More pages are better than
  one long one.

## Images and the sandbox

- The page makes no outside requests: no CDN, no fonts or images by URL, no \`fetch\`. Inline
  everything: images as \`data:\` URLs (or inline SVG), scripts and styles in the page. The page
  travels to the user's other devices over PM3code's connection, so it must stand alone. The whole
  page can be up to 2 MiB.
- It runs in a sandbox with no origin of its own: \`localStorage\`, cookies and links to other pages
  don't work. Keep state in memory. The one way back to you is the reader's answers.

## Publishing

\`pm_page_show({ html, title, source_name, item?, question_tags? })\`:

- \`source_name\` names the page's file; publishing the same \`source_name\` again replaces the older
  page by itself. Retire a page that is out of date with \`pm_page_retire\`, which takes back its
  open questions too.
- \`question_tags\` lists the tags of the page's questions. Take each from \`pm_next_tag\`, which
  reserves it. A tag an ask or another page already holds is refused.
- End your turn after publishing: the answers arrive as your next message.

A page with no questions (a report, a mockup to look at, a comparison) waits for the reader until
they mark it seen: the kit ends it with a "Reply about this page" box and an Archive button (which
switches to Send to agent as soon as they type a reply). Once they press it you receive
\`<pm-page-answers page="…" title="…" tags="">{"seen":true}</pm-page-answers>\`, plus \`"reply"\`
when they wrote one. Read the reply like any message from the user. Do not add a button of your own
for this.

## Questions

Only for questions the reader answers by seeing something: two layouts to choose between, a mockup
to react to. A plain question is a \`pm_ask\`. A question page is the same skeleton with
\`<gx-questions>\` in place of \`<gx-page>\`:

\`\`\`html
<gx-questions submit="Send to the PM">
  <header>
    <span class="gx-eyebrow">Settings</span>
    <h1>Settings redesign</h1>
    <p class="gx-lede">Two layouts for the page, then the header.</p>
  </header>
  <gx-wide><div class="gx-options">
    <section data-question="Q1" data-choice="tabs"><h3>A. Tabs</h3><!-- mockup A --></section>
    <section data-question="Q1" data-choice="one page"><h3>B. One long page</h3><!-- mockup B --></section>
  </div></gx-wide>
  <gx-question tag="Q1" title="Which layout should the Settings page use?">
    <p>Settings has grown to 40 options across six areas. Tabs keep each area short but hide the
    rest; one long page keeps everything searchable in one scroll. I recommend tabs: the search box
    stays on top either way, and the phone layout gets simpler.</p>
    <gx-choice value="tabs" recommended>A. Tabs<small>One page per area.</small></gx-choice>
    <gx-choice value="one page">B. One long page</gx-choice>
  </gx-question>
</gx-questions>
\`\`\`

- **Tie every variant to its choice**, so each mockup has a Pick button at the right end of its
  title: wrap the variant's title and mockup in one element with \`data-question\` (the question's
  tag, \`name\` or title) and \`data-choice\` (the choice's value, label or letter). The kit shows the
  pick there and in the question. It adds no note box under the mockup, so never tell the reader
  they can write a note under each mockup.
- Put the whole page in one \`<gx-questions>\`. Each question sits directly below the visual it asks
  about: a mockup, then its question, then the next mockup and its question. Never collect all the
  mockups first and all the questions at the end, and never put a mockup inside a question.
- \`<gx-question>\`: \`title\` (the "away for a day" test of the playbook applies); \`tag\`, its Q tag
  from \`pm_next_tag\`; \`name\`, the answer's key (the title when there is none); \`multiple\` for
  several picks; \`type="text"\` for a text box instead of choices. A \`<p>\` before its choices holds
  the full context to decide, like a \`pm_ask\` description: at least 120 characters on what it is,
  what each choice does, what you recommend and why, and any risk, with links (\`<a href>\`) to what
  it is about.
- \`<gx-choice>\`: its text is the choice and a \`<small>\` inside is a one-line detail. \`value\` is
  what you receive (the text without the \`<small>\` when there is none). \`recommended\` adds a
  Recommended badge.
- List a question's choices in exactly the order its variants appear above it. Never move the
  recommended choice to the top; mark it with \`recommended\` where it already sits.
- Write only that markup. The kit letters the choices, ends every choice question with "Other /
  none of these" and a note box, adds an "Anything else?" box, a Skip all button and the send
  button. Nothing is preselected, and a question left blank arrives as \`"skipped"\`. Don't write
  your own form, button, "Other" choice, note box or "Anything else?" question.
- Once sent, the page is locked; opening it again shows the answers and an Answered note.

The answers arrive as your next message. A note arrives under the question's key plus \` (note)\`,
and the "Anything else?" box, when filled in, arrives last as \`"Additional notes"\`:

\`\`\`text
<pm-page-answers page="page-…" title="Settings redesign" tags="Q1,Q2">{
  "Which layout should the Settings page use?": "tabs",
  "Which layout should the Settings page use? (note)": "keep search at the top",
  "Which platforms first?": ["macOS", "Other / none of these"],
  "Additional notes": "…"
}</pm-page-answers>
\`\`\`

## Lists you ask about: picks on rows

When a page lists items (feature requests, issues, files, findings) and asks which ones, the reader
picks on each item's own row. Never write the items above a question and then again as its
\`<gx-choice>\` lines. Write each item once, as a \`<gx-pick value="…">\` holding Markdown (start it
with a heading: the row's title and label), inside an element with \`data-question\` naming the
question. The question gets no \`<gx-choice>\` lines; the kit makes them from the rows:

\`\`\`html
<div data-question="Q7">
  <div data-pick-group>
    <h3>Agent workflow</h3>
    <gx-pick value="FB-34" recommended>
      ##### \`FB-34\` Edit ticket details after it is created

      Agents can't change a ticket's requester email once it exists.
    </gx-pick>
    <gx-pick value="FB-29">
      ##### \`FB-29\` Canned responses in New ticket
    </gx-pick>
  </div>
</div>
<gx-question tag="Q7" multiple title="Which of these go in before cutover?">
  <p>Whatever you leave unpicked is planned for after cutover, so pick what support needs on day one.</p>
</gx-question>
\`\`\`

- \`data-pick="value"\` on any element (an \`article\`, an \`li\`, a table's \`tr\`) works the same, with
  \`data-recommended\`; put rows in a \`.gx-options\` row to compare two to four as cards; wrap rows
  in \`data-pick-group\` with a heading to group them.
- The kit adds a checkbox (a radio without \`multiple\`) and a Note on every row, a filter above a
  long list, and the keys. Don't add any of this yourself, and don't shorten an item to fit.
- The answers are the picked values as a list (one value for pick one), keyed by the question, and
  each row's note as \`"<key> · <value> (note)"\`.

## Answers the kit can't ask for

For a ranking or a spot on a mockup, a page can send its own: \`ghostex.submit(answers)\` posts any
JSON under 64 KiB and returns a promise that rejects with an \`Error\` saying why it wasn't sent;
\`ghostex.answered\` and \`ghostex.answers\` tell a reopened page what was sent, and an element with
\`data-gx-answered\` is where the Answered note goes. A page takes one set of answers. For state
other than named \`input\`, \`textarea\` and \`select\` values (which the kit keeps by itself), call
\`ghostex.saveDraft(value)\` as it changes and read \`ghostex.draft\` when the page loads.
`;
