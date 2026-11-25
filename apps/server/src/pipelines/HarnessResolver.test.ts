import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import type { Role } from "@t3tools/pipelines";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveRoleHarness } from "./HarnessResolver.ts";

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
});
