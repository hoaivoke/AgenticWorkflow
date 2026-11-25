import { describe, expect, it } from "@effect/vitest";

import { pmMixedChoiceWarnings } from "./choiceMix.ts";

const question = (attrs: string, choices: ReadonlyArray<string>) =>
  `<gx-question ${attrs}><p>Why.</p>${choices.map((choice) => `<gx-choice>${choice}<small>One line.</small></gx-choice>`).join("")}</gx-question>`;

describe("pmMixedChoiceWarnings", () => {
  it("warns about a long pick-one list and about choices crossing two decisions", () => {
    const html = `<gx-questions>${question('tag="Q4" title="Which menu look?"', ["A", "B", "C", "D", "E", "F", "G"])}${question(
      'title="Which header?"',
      ["A. Dark; compact", "B. Dark; large", "C) dark; tall", "D. Light; compact"],
    )}</gx-questions>`;
    expect(pmMixedChoiceWarnings(html)).toEqual([
      'Warning: Q4 ("Which menu look?"): it has 7 pick-one choices, and a list that long usually mixes kinds of choice (a look, a layout, extras). Ask one question per kind of choice, and add `multiple` wherever the choices can combine, so a mix is several picks instead of Other and a note.',
      'Warning: Question 2 ("Which header?"): 3 of its choices start "Dark;", so two decisions are crossed in one list (the part before ";" and the part after it). Ask one question per kind of choice, and add `multiple` wherever the choices can combine, so a mix is several picks instead of Other and a note.',
    ]);
  });

  it("leaves pick-any, text and short one-dimension questions alone", () => {
    // The last one is pick-one: "multiple" inside its title is no attribute.
    const seven = ["A", "B", "C", "D", "E", "F", "G"];
    expect(
      pmMixedChoiceWarnings(
        `${question('tag="Q1" multiple title="Extras?"', seven)}${question('type="text" title="Notes"', seven)}${question('title="Where?"', ["Top", "Bottom"])}${question('title="Allow multiple picks?"', seven)}`,
      ),
    ).toEqual([
      'Warning: Question 4 ("Allow multiple picks?"): it has 7 pick-one choices, and a list that long usually mixes kinds of choice (a look, a layout, extras). Ask one question per kind of choice, and add `multiple` wherever the choices can combine, so a mix is several picks instead of Other and a note.',
    ]);
  });
});
