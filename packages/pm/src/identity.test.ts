import { describe, expect, it } from "vite-plus/test";

import { pmAppName, pmAppNameCatalog } from "./identity.ts";

describe("pmAppName", () => {
  it.each([
    ["Welcome to T3 Code", "Welcome to Agent Space"],
    ["T3 Code's CLI and T3 Code again", "Agent Space's CLI and Agent Space again"],
    ["Restart the T3 server on {label}.", "Restart the Agent Space server on {label}."],
    ["Leave empty to use the T3 home folder.", "Leave empty to use the Agent Space home folder."],
    ["Use T3 desktop for automatic return", "Use Agent Space desktop for automatic return"],
    ["Bienvenue dans T3 Code", "Bienvenue dans Agent Space"],
    ["T3 Connect and T3 Chat are T3's services", "T3 Connect and T3 Chat are T3's services"],
    ["github.com/pingdotgg/t3code", "github.com/pingdotgg/t3code"],
    [
      "Run `t3 auth pairing create` or `t3 connect link`.",
      "Run `t3-pm auth pairing create` or `t3-pm connect link`.",
    ],
    ["Use `npx t3@latest` if `t3` is missing.", "Use `npx t3@latest` if `t3-pm` is missing."],
    [
      "Stop t3 on {serverLabel}, then restart t3.",
      "Stop t3-pm on {serverLabel}, then restart t3-pm.",
    ],
    ["t3 auth pairing create", "t3-pm auth pairing create"],
    ["The t3@{version} update failed.", "The t3@{version} update failed."],
    [
      "For example, t3 or t3/ produces t3/add-search.",
      "For example, t3 or t3/ produces t3/add-search.",
    ],
    ["claude mcp add --transport http t3 {url}", "claude mcp add --transport http t3 {url}"],
    ["host tunnel t3 connect t3 chat", "host tunnel t3 connect t3 chat"],
    [
      "mcp__t3__thread, t3code, t3.json, T3 Connect",
      "mcp__t3__thread, t3code, t3.json, T3 Connect",
    ],
    ["Set a separate T3CODE_HOME.", "Set a separate T3CODE_PM_HOME."],
    [
      "Run: T3CODE_HOME='/srv' '/srv/t3' __service-launcher",
      "Run: T3CODE_HOME='/srv' '/srv/t3' __service-launcher",
    ],
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
      a: "Get Agent Space",
      b: ["Run ", { k: "name", i: 1, t: "Var" }, " in Agent Space"],
      c: { c: "Sent by Agent Space", d: { b: { one: "Agent Space" } } },
    });
  });
});
