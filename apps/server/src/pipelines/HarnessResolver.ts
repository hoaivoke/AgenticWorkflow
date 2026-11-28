// pipelines: resolve per-role skills and repository context files into bounded harness packets.
import * as NodeOS from "node:os";

import {
  matchSkillsForRole,
  type ModelFamily,
  type ResolvedRoleHarness,
  type Role,
  type SkillEntry,
} from "@t3tools/pipelines";
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

export interface DiscoveredSkill {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user" | "plugin";
}

const collectSkillRoots = Effect.fn("HarnessResolver.collectSkillRoots")(function* (
  workspaceRoot: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = Option.getOrElse(yield* Effect.serviceOption(HostProcess.HomeDirectory), () =>
    NodeOS.homedir(),
  );

  const roots: Array<{ readonly dir: string; readonly scope: DiscoveredSkill["scope"] }> = [];
  if (workspaceRoot !== null) {
    const root = path.resolve(workspaceRoot);
    roots.push(
      { dir: path.join(root, ".pipelines", "skills"), scope: "project" },
      { dir: path.join(root, ".agents", "skills"), scope: "project" },
      { dir: path.join(root, ".claude", "skills"), scope: "project" },
    );
  }
  roots.push(
    { dir: path.join(homeDir, ".gemini", "antigravity", "skills"), scope: "user" },
    { dir: path.join(homeDir, ".gemini", "antigravity-cli", "skills"), scope: "user" },
    { dir: path.join(homeDir, ".gemini", "config", "skills"), scope: "user" },
    { dir: path.join(homeDir, ".gemini", "skills"), scope: "user" },
    { dir: path.join(homeDir, ".agents", "skills"), scope: "user" },
    { dir: path.join(homeDir, ".claude", "skills"), scope: "user" },
  );

  const pluginRoot = path.join(homeDir, ".gemini", "config", "plugins");
  const pluginNames = yield* fs
    .readDirectory(pluginRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const pluginName of pluginNames.toSorted()) {
    roots.push({ dir: path.join(pluginRoot, pluginName, "skills"), scope: "plugin" });
  }
  return roots;
});

/** List available skills across project, user, and plugin skill directories (deduplicated). */
export const discoverAvailableSkills = Effect.fn("HarnessResolver.discoverAvailableSkills")(
  function* (
    workspaceRoot: string | null,
  ): Effect.fn.Return<ReadonlyArray<DiscoveredSkill>, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const roots = yield* collectSkillRoots(workspaceRoot);
    const seen = new Set<string>();
    const discovered: Array<DiscoveredSkill> = [];

    for (const { dir, scope } of roots) {
      const entries = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const entry of entries.toSorted()) {
        if (entry.startsWith(".")) continue;
        const skillFile = path.join(dir, entry, "SKILL.md");
        const exists = yield* fs.exists(skillFile).pipe(Effect.orElseSucceed(() => false));
        if (!exists) continue;
        const normalizedKey = entry.toLowerCase();
        if (seen.has(normalizedKey)) continue;
        seen.add(normalizedKey);
        discovered.push({
          name: entry,
          path:
            scope === "project" && workspaceRoot !== null
              ? path.relative(path.resolve(workspaceRoot), skillFile)
              : skillFile,
          scope,
        });
      }
    }
    return discovered;
  },
);

export const resolveHarnessInputs = Effect.fn("HarnessResolver.resolveHarnessInputs")(
  function* (input: {
    readonly skillRequests: ReadonlyArray<string>;
    readonly contextRequests: ReadonlyArray<string>;
    readonly workspaceRoot: string | null;
    readonly skillCatalog?: ReadonlyMap<string, SkillEntry> | undefined;
    readonly modelFamily?: ModelFamily | null | undefined;
  }): Effect.fn.Return<ResolvedRoleHarness, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const dedup = (items: ReadonlyArray<string>) => {
      const out: Array<string> = [];
      const seen = new Set<string>();
      for (const raw of items) {
        const trimmed = raw.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
      }
      return out;
    };

    const skillRequests = dedup(input.skillRequests);
    const contextRequests = dedup(input.contextRequests);
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

    const skillRoots = (yield* collectSkillRoots(input.workspaceRoot)).map((entry) => entry.dir);

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
        const hyphenated = skillName.replace(/_/g, "-");
        for (const dir of skillRoots) {
          candidates.push(path.join(dir, skillName, "SKILL.md"));
          if (normalized !== skillName) {
            candidates.push(path.join(dir, normalized, "SKILL.md"));
          }
          if (hyphenated !== skillName && hyphenated !== normalized) {
            candidates.push(path.join(dir, hyphenated, "SKILL.md"));
          }
        }
      }
      let resolvedContent: string | null = null;
      for (const candidate of candidates) {
        const raw = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => null));
        if (raw === null) continue;
        const cleaned = stripYamlFrontmatter(raw);
        if (!cleaned) continue;
        resolvedContent = cleaned;
        break;
      }
      const catalogEntry = input.skillCatalog?.get(skillName) ?? null;
      if (resolvedContent === null && catalogEntry !== null) {
        resolvedContent = catalogEntry.instructions;
      }
      if (resolvedContent === null) continue;
      const familyNote =
        input.modelFamily && catalogEntry?.familyGuidance?.[input.modelFamily]
          ? `\n\nModel-family guidance (${input.modelFamily}): ${catalogEntry.familyGuidance[input.modelFamily]}`
          : "";
      const combined = `${resolvedContent}${familyNote}`;
      const sliced = truncateUtf8(combined, Math.min(MAX_SKILL_BYTES, budget));
      budget -= sliced.length;
      skillContents.push({ name: skillName, content: sliced });
    }

    return {
      ...(input.modelFamily ? { modelFamily: input.modelFamily } : {}),
      ...(skillRequests.length === 0 ? {} : { matchedSkills: skillRequests }),
      ...(contextContents.length === 0 ? {} : { contextFiles: contextContents }),
      ...(skillContents.length === 0 ? {} : { skills: skillContents }),
    };
  },
);

export const resolveRoleHarness = Effect.fn("HarnessResolver.resolveRoleHarness")(
  function* (input: {
    readonly role: Role;
    readonly workspaceRoot: string | null;
    readonly skillCatalog?: ReadonlyMap<string, SkillEntry> | undefined;
    readonly modelFamily?: ModelFamily | null | undefined;
  }): Effect.fn.Return<ResolvedRoleHarness, never, FileSystem.FileSystem | Path.Path> {
    const matched =
      input.skillCatalog !== undefined
        ? matchSkillsForRole({
            config: { skills: input.skillCatalog },
            role: input.role,
            modelFamily: input.modelFamily,
          }).map((entry) => entry.name)
        : (input.role.skills ?? []);
    return yield* resolveHarnessInputs({
      skillRequests: matched,
      contextRequests: input.role.contextFiles ?? [],
      workspaceRoot: input.workspaceRoot,
      skillCatalog: input.skillCatalog,
      modelFamily: input.modelFamily,
    });
  },
);
