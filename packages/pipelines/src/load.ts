import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { BUILTIN_PIPELINES } from "./builtin/pipelines.ts";
import { BUILTIN_ROLES } from "./builtin/roles.ts";
import { BUILTIN_SKILLS } from "./builtin/skills.ts";
import { BUILTIN_TIERS } from "./builtin/tiers.ts";
import {
  Pipeline,
  Role,
  SkillCatalogFile,
  SkillEntry,
  TIER_ORDER,
  TierMapPatch,
  type TierMap,
  type PipelineConfig,
  type Role as RoleType,
  type SkillEntry as SkillEntryType,
} from "./schema.ts";

/** The folder in a project that holds overrides: tiers.yaml, roles/*.yaml, pipelines/*.yaml. */
export const CONFIG_DIR = ".pipelines";
/** Where a run's files live, under the project root. Keep it out of git. */
export const RUNS_DIR = `${CONFIG_DIR}/runs`;

export interface ConfigFile {
  /** Path relative to the config folder, with forward slashes: `roles/builder.yaml`. */
  readonly path: string;
  readonly text: string;
}

export interface LoadResult {
  readonly config: PipelineConfig;
  /** One line per file or reference that was ignored. Built-ins stay in effect for it. */
  readonly problems: ReadonlyArray<string>;
}

const options = { onExcessProperty: "error" } as const;
const decodeRole = Schema.decodeUnknownExit(Role, options);
const decodePipeline = Schema.decodeUnknownExit(Pipeline, options);
const decodeTiers = Schema.decodeUnknownExit(TierMapPatch, options);
const decodeSkill = Schema.decodeUnknownExit(SkillEntry, options);
const decodeSkillCatalog = Schema.decodeUnknownExit(SkillCatalogFile, options);

const describe = <A>(exit: Exit.Exit<A, unknown>): string => {
  if (Exit.isSuccess(exit)) return "";
  const error = Cause.squash(exit.cause);
  return Schema.isSchemaError(error) ? error.message.replace(/\s*\n\s*/g, " ") : String(error);
};

const stem = (path: string) => {
  const file = path.split("/").at(-1) ?? path;
  return file.replace(/\.ya?ml$/i, "");
};

/**
 * Merge built-ins with a project's files. Never throws: a file that does not parse or does not
 * match the schema is skipped and named in `problems`, so a typo cannot stop a PM.
 */
export function loadPipelineConfig(files: ReadonlyArray<ConfigFile>): LoadResult {
  const problems: Array<string> = [];
  const sources = new Map<string, string>();
  const roles = new Map<string, RoleType>();
  const pipelines = new Map<string, Pipeline>();
  const skills = new Map<string, SkillEntryType>();
  let tiers: TierMap = BUILTIN_TIERS;

  for (const role of BUILTIN_ROLES) {
    roles.set(role.name, role);
    sources.set(`role:${role.name}`, "built-in");
  }
  for (const pipeline of BUILTIN_PIPELINES) {
    pipelines.set(pipeline.name, pipeline);
    sources.set(`pipeline:${pipeline.name}`, "built-in");
  }
  for (const skill of BUILTIN_SKILLS) {
    skills.set(skill.name, skill);
    sources.set(`skill:${skill.name}`, "built-in");
  }
  sources.set("tiers", "built-in");

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    const where = `${CONFIG_DIR}/${file.path}`;
    if (!/\.ya?ml$/i.test(file.path)) continue;
    let raw: unknown;
    try {
      raw = parseYaml(file.text);
    } catch (error) {
      problems.push(
        `${where}: not valid YAML (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`,
      );
      continue;
    }
    if (raw === null || raw === undefined) continue;

    if (file.path === "tiers.yaml" || file.path === "tiers.yml") {
      const exit = decodeTiers(raw);
      if (Exit.isFailure(exit)) {
        problems.push(`${where}: ${describe(exit)}`);
        continue;
      }
      const patch = exit.value;
      tiers = {
        small: patch.small ?? tiers.small,
        mid: patch.mid ?? tiers.mid,
        frontier: patch.frontier ?? tiers.frontier,
      };
      sources.set("tiers", where);
      continue;
    }

    if (file.path === "skills.yaml" || file.path === "skills.yml") {
      const exit = decodeSkillCatalog(raw);
      if (Exit.isFailure(exit)) {
        problems.push(`${where}: ${describe(exit)}`);
        continue;
      }
      for (const entry of exit.value) {
        skills.set(entry.name, entry);
        sources.set(`skill:${entry.name}`, where);
      }
      continue;
    }

    if (file.path.startsWith("skills/")) {
      const withName =
        typeof raw === "object" && !Array.isArray(raw) && !("name" in raw)
          ? { ...raw, name: stem(file.path) }
          : raw;
      const exit = decodeSkill(withName);
      if (Exit.isFailure(exit)) {
        problems.push(`${where}: ${describe(exit)}`);
        continue;
      }
      skills.set(exit.value.name, exit.value);
      sources.set(`skill:${exit.value.name}`, where);
      continue;
    }

    if (file.path.startsWith("roles/")) {
      const withName =
        typeof raw === "object" && !Array.isArray(raw) && !("name" in raw)
          ? { ...raw, name: stem(file.path) }
          : raw;
      const exit = decodeRole(withName);
      if (Exit.isFailure(exit)) {
        problems.push(`${where}: ${describe(exit)}`);
        continue;
      }
      roles.set(exit.value.name, exit.value);
      sources.set(`role:${exit.value.name}`, where);
      continue;
    }

    if (file.path.startsWith("pipelines/")) {
      const withName =
        typeof raw === "object" && !Array.isArray(raw) && !("name" in raw)
          ? { ...raw, name: stem(file.path) }
          : raw;
      const exit = decodePipeline(withName);
      if (Exit.isFailure(exit)) {
        problems.push(`${where}: ${describe(exit)}`);
        continue;
      }
      pipelines.set(exit.value.name, exit.value);
      sources.set(`pipeline:${exit.value.name}`, where);
      continue;
    }
  }

  for (const role of roles.values()) {
    if (
      role.maxTier !== undefined &&
      TIER_ORDER.indexOf(role.maxTier) < TIER_ORDER.indexOf(role.tier)
    ) {
      problems.push(
        `Role ${role.name}: maxTier ${role.maxTier} is below its tier ${role.tier}; using ${role.tier}.`,
      );
      roles.set(role.name, { ...role, maxTier: role.tier });
    }
  }

  // Replacing or deleting entries while iterating a Map is safe: visited keys are not revisited.
  for (const pipeline of pipelines.values()) {
    const ids = new Set<string>();
    const issues: Array<string> = [];
    for (const stage of pipeline.stages) {
      if (ids.has(stage.id)) issues.push(`stage id ${stage.id} is used twice`);
      ids.add(stage.id);
      const role = stage.role ?? (stage.run === undefined ? undefined : "gatekeeper");
      if (role === undefined) issues.push(`stage ${stage.id} needs a role or run commands`);
      else if (!roles.has(role)) issues.push(`stage ${stage.id} uses unknown role ${role}`);
    }
    for (const stage of pipeline.stages) {
      for (const [field, ref] of [
        ["differentProviderFrom", stage.differentProviderFrom],
        ["onFail", stage.onFail],
      ] as const) {
        if (ref !== undefined && !ids.has(ref))
          issues.push(`stage ${stage.id} ${field} names unknown stage ${ref}`);
      }
    }
    if (issues.length > 0) {
      const source = sources.get(`pipeline:${pipeline.name}`) ?? "built-in";
      problems.push(`Pipeline ${pipeline.name} (${source}): ${issues.join("; ")}.`);
      if (source !== "built-in") {
        const builtin = BUILTIN_PIPELINES.find((entry) => entry.name === pipeline.name);
        if (builtin === undefined) pipelines.delete(pipeline.name);
        else pipelines.set(pipeline.name, builtin);
        sources.set(`pipeline:${pipeline.name}`, builtin === undefined ? "removed" : "built-in");
      }
    }
  }

  return { config: { tiers, roles, pipelines, skills, sources }, problems };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export function isValidPipelineSlug(name: string): boolean {
  return SLUG_PATTERN.test(name.trim());
}

const compactStrings = (values: ReadonlyArray<string> | undefined) => {
  const cleaned = (values ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
};

/** Encode a role as clean YAML compatible with `loadPipelineConfig`. */
export function serializeRoleYaml(role: RoleType): string {
  const description = role.description.trim();
  const doc: Record<string, unknown> = {
    name: role.name.trim(),
    description,
    tier: role.tier,
    ...(role.maxTier !== undefined ? { maxTier: role.maxTier } : {}),
    ...(role.access !== undefined ? { access: role.access } : {}),
    ...(role.multimodal ? { multimodal: true } : {}),
    ...(role.candidates !== undefined && role.candidates.length > 0
      ? {
          candidates: role.candidates.map((candidate) => ({
            provider: candidate.provider.trim(),
            model: candidate.model.trim(),
            ...(candidate.effort !== undefined ? { effort: candidate.effort } : {}),
          })),
        }
      : {}),
  };
  const skills = compactStrings(role.skills);
  if (skills !== undefined) doc.skills = skills;
  const contextFiles = compactStrings(role.contextFiles);
  if (contextFiles !== undefined) doc.contextFiles = contextFiles;
  const toolkits = compactStrings(role.toolkits);
  if (toolkits !== undefined) doc.toolkits = toolkits;
  if (role.outputContract !== undefined && role.outputContract.trim().length > 0) {
    doc.outputContract = role.outputContract.trim();
  }
  doc.instructions = role.instructions.trim().length > 0 ? role.instructions.trim() : description;
  return stringifyYaml(doc, { lineWidth: 100 });
}

/** Encode a pipeline as clean YAML compatible with `loadPipelineConfig`. */
export function serializePipelineYaml(pipeline: Pipeline): string {
  const description = pipeline.description.trim();
  const doc: Record<string, unknown> = {
    name: pipeline.name.trim(),
    description,
    when: pipeline.when.trim().length > 0 ? pipeline.when.trim() : description,
    ...(pipeline.escalateAfter !== undefined ? { escalateAfter: pipeline.escalateAfter } : {}),
    ...(pipeline.replanAfter !== undefined ? { replanAfter: pipeline.replanAfter } : {}),
    stages: pipeline.stages.map((stage) => {
      const reads = compactStrings(stage.reads);
      const produces = compactStrings(stage.produces);
      const run = compactStrings(stage.run);
      const entry: Record<string, unknown> = {
        id: stage.id.trim(),
        ...(stage.role !== undefined && stage.role.trim().length > 0
          ? { role: stage.role.trim() }
          : {}),
        goal: stage.goal.trim(),
      };
      if (reads !== undefined) entry.reads = reads;
      if (produces !== undefined) entry.produces = produces;
      if (stage.workspace !== undefined) entry.workspace = stage.workspace;
      if (stage.parallel !== undefined && stage.parallel > 1) entry.parallel = stage.parallel;
      if (stage.foreach !== undefined) entry.foreach = stage.foreach;
      if (
        stage.differentProviderFrom !== undefined &&
        stage.differentProviderFrom.trim().length > 0
      ) {
        entry.differentProviderFrom = stage.differentProviderFrom.trim();
      }
      if (stage.approval) entry.approval = true;
      if (stage.skipWhen !== undefined && stage.skipWhen.trim().length > 0) {
        entry.skipWhen = stage.skipWhen.trim();
      }
      if (stage.onFail !== undefined && stage.onFail.trim().length > 0) {
        entry.onFail = stage.onFail.trim();
      }
      if (run !== undefined) entry.run = run;
      return entry;
    }),
  };
  return stringifyYaml(doc, { lineWidth: 100 });
}
