import { describe, expect, it } from "vite-plus/test";

import { adoptPmHomeEnvironment } from "./homeEnvironment.ts";

describe("adoptPmHomeEnvironment", () => {
  it("replaces an ambient T3CODE_HOME with T3CODE_PM_HOME", () => {
    const env: NodeJS.ProcessEnv = { T3CODE_HOME: "/home/u/.t3", T3CODE_PM_HOME: " /data/pm " };
    adoptPmHomeEnvironment(env);
    expect(env.T3CODE_HOME).toBe("/data/pm");
  });

  it("drops an ambient T3CODE_HOME when T3CODE_PM_HOME is unset or blank", () => {
    for (const pmHome of [undefined, "  "]) {
      const env: NodeJS.ProcessEnv = { T3CODE_HOME: "/home/u/.t3", T3CODE_PM_HOME: pmHome };
      adoptPmHomeEnvironment(env);
      expect(env).not.toHaveProperty("T3CODE_HOME");
    }
  });
});
