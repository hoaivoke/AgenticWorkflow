// pipelines: resolve per-role skills and repository context files into bounded harness packets.
import * as NodeOS from "node:os";

import { type ResolvedRoleHarness, type Role } from "@t3tools/pipelines";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const MAX_SKILL_BYTES = 6_000;
const MAX_CONTEXT_BYTES = 4_000;
const MAX_TOTAL_HARNESS_BYTES = 20_000;

function truncateUtf8(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Truncated to ${limit} characters.]`;
}

function stripYamlFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown.trim();
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return markdown.trim();
  return markdown.slice(end + 4).trim();
}

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export const resolveRoleHarness = Effect.fn("HarnessResolver.resolveRoleHarness")(
  function* (input: {
    readonly role: Role;
    readonly workspaceRoot: string | null;
  }): Effect.fn.Return<ResolvedRoleHarness, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = Option.getOrElse(yield* Effect.serviceOption(HostProcess.HomeDirectory), () =>
      NodeOS.homedir(),
    );

    const skillRequests = input.role.skills ?? [];
    const contextRequests = input.role.contextFiles ?? [];
    if (skillRequests.length === 0 && contextRequests.length === 0) {
      return {};
    }

    let budget = MAX_TOTAL_HARNESS_BYTES;
    const contextContents: Array<{ readonly path: string; readonly content: string }> = [];
    if (input.workspaceRoot !== null) {
      const root = path.resolve(input.workspaceRoot);
      for (const relPath of contextRequests) {
        if (budget <= 0) break;
        const target = path.resolve(root, relPath);
        if (!isInsideRoot(path, root, target)) continue;
        const text = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => null));
        if (text === null || text.trim().length === 0) continue;
        const sliced = truncateUtf8(text.trim(), Math.min(MAX_CONTEXT_BYTES, budget));
        budget -= sliced.length;
        contextContents.push({ path: relPath, content: sliced });
      }
    }

    const skillRoots: Array<string> = [];
    if (input.workspaceRoot !== null) {
      const root = path.resolve(input.workspaceRoot);
      skillRoots.push(
        path.join(root, ".pipelines", "skills"),
        path.join(root, ".agents", "skills"),
        path.join(root, ".claude", "skills"),
      );
    }
    skillRoots.push(
      path.join(homeDir, ".gemini", "antigravity", "skills"),
      path.join(homeDir, ".gemini", "skills"),
      path.join(homeDir, ".agents", "skills"),
      path.join(homeDir, ".claude", "skills"),
    );

    const pluginRoot = path.join(homeDir, ".gemini", "config", "plugins");
    const pluginNames = yield* fs
      .readDirectory(pluginRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const pluginName of pluginNames.toSorted()) {
      skillRoots.push(path.join(pluginRoot, pluginName, "skills"));
    }

    const skillContents: Array<{ readonly name: string; readonly content: string }> = [];
    for (const skillName of skillRequests) {
      if (budget <= 0) break;
      const candidates: Array<string> = [];
      if (input.workspaceRoot !== null && skillName.endsWith(".md")) {
        const root = path.resolve(input.workspaceRoot);
        const direct = path.resolve(root, skillName);
        if (isInsideRoot(path, root, direct)) candidates.push(direct);
      } else {
        const normalized = skillName.replace(/-/g, "_");
        for (const dir of skillRoots) {
          candidates.push(path.join(dir, skillName, "SKILL.md"));
          if (normalized !== skillName) {
            candidates.push(path.join(dir, normalized, "SKILL.md"));
          }
        }
      }
      for (const candidate of candidates) {
        const raw = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => null));
        if (raw === null) continue;
        const cleaned = stripYamlFrontmatter(raw);
        if (!cleaned) continue;
        const sliced = truncateUtf8(cleaned, Math.min(MAX_SKILL_BYTES, budget));
        budget -= sliced.length;
        skillContents.push({ name: skillName, content: sliced });
        break;
      }
    }

    return {
      ...(contextContents.length === 0 ? {} : { contextFiles: contextContents }),
      ...(skillContents.length === 0 ? {} : { skills: skillContents }),
    };
  },
);
