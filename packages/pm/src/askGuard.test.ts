import { describe, expect, it } from "@effect/vitest";

import {
  PM_MIN_DETAIL_CHARS,
  pmAskRefusal,
  pmInternalRefs,
  pmPointerPhrase,
  pmTodoRefusal,
} from "./askGuard.ts";

const DETAIL = "x".repeat(PM_MIN_DETAIL_CHARS);

describe("pmPointerPhrase", () => {
  it("finds questions that send the user to a Live page", () => {
    expect(pmPointerPhrase("Pick on the Live page")).toBe("on the live page");
    expect(pmPointerPhrase("Pick on the welcome screen Live page")).toBe(
      "pick on the welcome screen live page",
    );
    expect(pmPointerPhrase("Answer the triage page")).toBe("answer the triage page");
    expect(pmPointerPhrase("See the form above")).toBe("see the form");
    expect(pmPointerPhrase("Open the settings Live page")).toBe("open the settings live page");
  });

  it("leaves ordinary questions and quoted words alone", () => {
    expect(pmPointerPhrase("Keep the settings page layout as it is?")).toBeNull();
    expect(pmPointerPhrase('Rename the "on the page" label?')).toBeNull();
    expect(pmPointerPhrase("Ship the onboarding redesign today?")).toBeNull();
  });
});

describe("pmInternalRefs", () => {
  it("finds tags, worker ids and commit hashes outside quotes", () => {
    expect(pmInternalRefs("Merge W12 and w3 after Q48?")).toEqual(["W12", "W3", "Q48"]);
    expect(pmInternalRefs("Restart pm-worker-lq2x9k0001ab?")).toEqual(["pm-worker-lq2x9k0001ab"]);
    expect(pmInternalRefs("Revert 2d2830a306 on main?")).toEqual(["2d2830a306"]);
    expect(pmInternalRefs("Close 3f2a1c9e-1b2c-4d5e-8f90-123456789abc?")).toEqual([
      "3f2a1c9e-1b2c-4d5e-8f90-123456789abc",
    ]);
    expect(pmInternalRefs("Ask thread-42 again?", ["thread-42"])).toEqual(["thread-42"]);
  });

  it("never flags look-alikes", () => {
    expect(
      pmInternalRefs(
        'Support W3C, Windows, W-2, W34-b, W34.dev, Q0 and "W12" in `Q4`, defaced, 1234567 and abc/W4?',
      ),
    ).toEqual([]);
  });
});

describe("pmAskRefusal", () => {
  it("passes a plain title with a full description", () => {
    expect(pmAskRefusal({ title: "Merge the stalled uploads fix?", detail: DETAIL })).toBeNull();
  });

  it("refuses a missing or thin description, counting collapsed whitespace", () => {
    expect(pmAskRefusal({ title: "Merge the fix?", detail: "  " })).toContain(
      "Missing description",
    );
    expect(pmAskRefusal({ title: "Merge the fix?", detail: `${"word   ".repeat(20)}` })).toContain(
      "Description is too short (99 characters; minimum is 120)",
    );
  });

  it("names a matching work item, and lists every problem at once", () => {
    const refusal = pmAskRefusal({
      title: "Ship W1 now?",
      detail: "Pick on the Live page.",
      items: [{ itemNo: 1, title: "Launch" }],
    });
    expect(refusal).toContain("This question cannot be asked yet:\n- Do not ask a question");
    expect(refusal).toContain('Matching work items: W1 ("Launch").');
    expect(refusal).toContain("- Description is too short");
  });
});

describe("pmTodoRefusal", () => {
  it("refuses a to-do to act on with nothing to act with", () => {
    expect(
      pmTodoRefusal({ title: "Paste the reply in #general", detail: "It is ready.", answers: [] }),
    ).toContain('"Paste …" asks the user to act');
    expect(
      pmTodoRefusal({ title: "Sign in to the store", detail: "Needed.", answers: ["Done"] }),
    ).not.toBeNull();
  });

  it("passes a to-do with a code block, inline code or a link, and every real decision", () => {
    expect(pmTodoRefusal({ title: "Paste it", detail: "```\nhi\n```", answers: [] })).toBeNull();
    expect(pmTodoRefusal({ title: "Run it", detail: "Run `vp i`.", answers: [] })).toBeNull();
    expect(
      pmTodoRefusal({ title: "Open the PR", detail: "https://x.test/pull/1", answers: [] }),
    ).toBeNull();
    expect(
      pmTodoRefusal({ title: "Send the release?", detail: "Ready.", answers: ["Send", "Hold"] }),
    ).toBeNull();
    expect(pmTodoRefusal({ title: "Review the notes", detail: "Ready.", answers: [] })).toBeNull();
  });
});
