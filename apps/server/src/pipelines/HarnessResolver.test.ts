import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import { loadPipelineConfig, type Role } from "@t3tools/pipelines";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveHarnessInputs, resolveRoleHarness } from "./HarnessResolver.ts";

const makeTestFs = (
  files: Readonly<Record<string, string>>,
  pluginDirs: ReadonlyArray<string> = [],
) =>
  Layer.mergeAll(
    FileSystem.layerNoop({
      readFileString: (filePath) =>
        filePath in files
          ? Effect.succeed(files[filePath]!)
          : Effect.fail(new Error(`ENOENT: ${filePath}`) as never),
      readDirectory: (dirPath) =>
        dirPath.endsWith("/.gemini/config/plugins")
          ? Effect.succeed([...pluginDirs])
          : Effect.succeed([]),
    }),
    NodePath.layerPosix,
    Layer.succeed(HostProcess.HomeDirectory, "/home/tester"),
  );

describe("resolveRoleHarness", () => {
  it.effect(
    "loads workspace skills (stripping frontmatter) and contextFiles while rejecting path escapes",
    () => {
      const role: Role = {
        name: "ui-review",
        description: "UI review",
        tier: "mid",
        instructions: "Review UI accessibility and polish.",
        skills: ["ui-review", "../escape.md"],
        contextFiles: ["AGENTS.md", "../outside.txt"],
      };
      const layer = makeTestFs({
        "/repo/AGENTS.md": "Use strict TypeScript.",
        "/outside.txt": "SECRET",
        "/repo/.pipelines/skills/ui-review/SKILL.md":
          "---\nname: ui-review\n---\n\nCheck keyboard navigation and contrast.",
        "/repo/escape.md": "nope",
      });

      return Effect.gen(function* () {
        const resolved = yield* resolveRoleHarness({ role, workspaceRoot: "/repo" });
        expect(resolved.contextFiles).toEqual([
          { path: "AGENTS.md", content: "Use strict TypeScript." },
        ]);
        expect(resolved.skills).toEqual([
          { name: "ui-review", content: "Check keyboard navigation and contrast." },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("returns empty object when role declares no skills or contextFiles", () => {
    const role: Role = {
      name: "triage",
      description: "Quick triage",
      tier: "small",
      instructions: "Triage incoming work.",
    };
    return Effect.gen(function* () {
      const resolved = yield* resolveRoleHarness({ role, workspaceRoot: "/repo" });
      expect(resolved).toEqual({});
    }).pipe(Effect.provide(makeTestFs({})));
  });

  it.effect("falls back to built-in catalog instructions and appends model-family guidance", () => {
    const { config } = loadPipelineConfig([]);
    const role = config.roles.get("ui-builder")!;
    const layer = makeTestFs({
      // A disk skill wins over the catalog instructions, but still gets family guidance.
      "/repo/.agents/skills/a11y-debugging/SKILL.md": "Project a11y rules.",
    });
    return Effect.gen(function* () {
      const resolved = yield* resolveRoleHarness({
        role,
        workspaceRoot: "/repo",
        skillCatalog: config.skills,
        modelFamily: "gemini",
      });
      expect(resolved.modelFamily).toBe("gemini");
      expect(resolved.matchedSkills).toContain("gemini-frontend-design");
      const byName = new Map(resolved.skills?.map((skill) => [skill.name, skill.content]));
      expect(byName.get("modern-web-guidance")).toContain("Use semantic HTML elements");
      expect(byName.get("modern-web-guidance")).toContain(
        "Model-family guidance (gemini): Use real semantic landmarks",
      );
      expect(byName.get("a11y-debugging")).toMatch(
        /^Project a11y rules\.\n\nModel-family guidance \(gemini\): Inspect the rendered/,
      );
      expect(byName.get("gemini-frontend-design")).toContain("typographic hierarchy");

      const unknownFamily = yield* resolveHarnessInputs({
        skillRequests: ["tdd-verification", "not-a-skill"],
        contextRequests: [],
        workspaceRoot: "/repo",
        skillCatalog: config.skills,
        modelFamily: null,
      });
      expect(unknownFamily.modelFamily).toBeUndefined();
      expect(unknownFamily.skills?.map((skill) => skill.name)).toEqual(["tdd-verification"]);
      expect(unknownFamily.skills?.[0]?.content).not.toContain("Model-family guidance");
    }).pipe(Effect.provide(layer));
  });
});
