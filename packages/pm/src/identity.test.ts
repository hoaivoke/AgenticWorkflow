import { describe, expect, it } from "vite-plus/test";

import { pmAppName, pmAppNameCatalog } from "./identity.ts";

describe("pmAppName", () => {
  it.each([
    ["Welcome to T3 Code", "Welcome to PM3code"],
    ["T3 Code's CLI and T3 Code again", "PM3code's CLI and PM3code again"],
    ["Restart the T3 server on {label}.", "Restart the PM3code server on {label}."],
    ["Leave empty to use the T3 home folder.", "Leave empty to use the PM3code home folder."],
    ["Use T3 desktop for automatic return", "Use PM3code desktop for automatic return"],
    ["Bienvenue dans T3 Code", "Bienvenue dans PM3code"],
    ["T3 Connect and T3 Chat are T3's services", "T3 Connect and T3 Chat are T3's services"],
    ["github.com/pingdotgg/t3code", "github.com/pingdotgg/t3code"],
  ])("%s", (source, expected) => {
    expect(pmAppName(source)).toBe(expected);
  });

  it("rewrites JSX catalog entries without touching their structure", () => {
    expect(
      pmAppNameCatalog({
        a: "Get T3 Code",
        b: ["Run ", { k: "name", i: 1, t: "Var" }, " in T3 Code"],
        c: { c: "Sent by T3 Code", d: { b: { one: "T3 Code" } } },
      }),
    ).toEqual({
      a: "Get PM3code",
      b: ["Run ", { k: "name", i: 1, t: "Var" }, " in PM3code"],
      c: { c: "Sent by PM3code", d: { b: { one: "PM3code" } } },
    });
  });
});
