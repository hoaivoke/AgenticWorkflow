// pipelines: role-based model routing for PM workers. See docs/user/pipelines.md.
import {
  isProviderAvailable,
  PmError,
  ProjectId,
  type PmPipelineDefinition,
  type PmPipelineRole,
  type PmWorkspacePipelinesSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  BUILTIN_PIPELINES,
  BUILTIN_ROLES,
  CONFIG_DIR,
  isValidPipelineSlug,
  loadPipelineConfig,
  resolveRole,
  serializePipelineYaml,
  serializeRoleYaml,
  type ConfigFile,
  type LoadResult,
  type ModelFamily,
  type Pipeline,
  type ProviderSnapshot,
  type ResolvedRoleHarness,
  type Role,
  type SkillEntry,
} from "@t3tools/pipelines";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { discoverAvailableSkills, resolveRoleHarness } from "./HarnessResolver.ts";
import { runDeterministicGates, type RunGatesResult } from "./PipelineGateRunner.ts";

/** Effort controls go by different ids per provider. */
const REASONING_IDS = new Set(["effort", "reasoningEffort", "thinkingLevel", "thought_level"]);

/** A provider the router may send work to: on, installed, healthy and signed in. */
const isUsableProvider = (provider: ServerProvider) =>
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

const toSnapshot = (provider: ServerProvider): ProviderSnapshot => ({
  instanceId: provider.instanceId,
  driver: provider.driver,
  enabled: isUsableProvider(provider),
  displayName: provider.displayName ?? null,
  models: provider.models
    .filter((model) => model.isLegacy !== true)
    .map((model) => {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (option) =>
          option.type === "select" && (option.role === "reasoning" || REASONING_IDS.has(option.id)),
      );
      return {
        slug: model.slug,
        name: model.name,
        reasoning:
          descriptor?.type === "select"
            ? { id: descriptor.id, choices: descriptor.options.map((choice) => choice.id) }
            : undefined,
      };
    }),
});

const toLimitedProviders = (
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ReadonlyMap<string, string> => {
  const limited = new Map<string, string>();
  for (const provider of providers) {
    const windows = (provider.usageLimits?.windows ?? []).filter(
      (window) => window.modelIds === undefined,
    );
    let latestReset: string | undefined;
    let spent = false;
    for (const window of windows) {
      if (window.usedPercent < 100) continue;
      if (window.resetsAt !== undefined) {
        const resetMs = Date.parse(window.resetsAt);
        if (Number.isFinite(resetMs) && resetMs <= nowMs) continue;
        if (latestReset === undefined || window.resetsAt > latestReset) {
          latestReset = window.resetsAt;
        }
      }
      spent = true;
    }
    if (spent) {
      limited.set(provider.instanceId, latestReset ?? "usage limit resets");
    }
  }
  return limited;
};

export interface PipelineServiceShape {
  /** Built-ins merged with the project's `.pipelines/` files. Never fails: problems are listed. */
  readonly configFor: (
    projectId: string,
  ) => Effect.Effect<LoadResult & { readonly root: string | null }>;
  /** Full UI snapshot: roles (with resolved models), pipelines, live providers, discovered skills. */
  readonly snapshotFor: (projectId: string) => Effect.Effect<PmWorkspacePipelinesSnapshot, PmError>;
  /** Create or update `<workspaceRoot>/.pipelines/roles/<name>.yaml`. */
  readonly saveRole: (input: {
    readonly projectId: string;
    readonly role: PmPipelineRole;
    readonly previousName?: string | undefined;
  }) => Effect.Effect<PmWorkspacePipelinesSnapshot, PmError>;
  /** Delete `<workspaceRoot>/.pipelines/roles/<name>.yaml` (reverts built-in override or removes custom role). */
  readonly deleteRole: (input: {
    readonly projectId: string;
    readonly name: string;
  }) => Effect.Effect<PmWorkspacePipelinesSnapshot, PmError>;
  /** Create or update `<workspaceRoot>/.pipelines/pipelines/<name>.yaml`. */
  readonly savePipeline: (input: {
    readonly projectId: string;
    readonly pipeline: PmPipelineDefinition;
    readonly previousName?: string | undefined;
  }) => Effect.Effect<PmWorkspacePipelinesSnapshot, PmError>;
  /** Delete `<workspaceRoot>/.pipelines/pipelines/<name>.yaml`. */
  readonly deletePipeline: (input: {
    readonly projectId: string;
    readonly name: string;
  }) => Effect.Effect<PmWorkspacePipelinesSnapshot, PmError>;
  /** Every provider account the server knows, as the router sees it. */
  readonly providers: Effect.Effect<ReadonlyArray<ProviderSnapshot>>;
  /** Provider accounts currently at 100% usage in their live usage-limit windows. */
  readonly limitedProviders: Effect.Effect<ReadonlyMap<string, string>>;
  /** Resolve role skills and context files into a bounded harness packet. */
  readonly resolveHarness: (
    role: Role,
    workspaceRoot: string | null,
    options?: {
      readonly skillCatalog?: ReadonlyMap<string, SkillEntry> | undefined;
      readonly modelFamily?: ModelFamily | null | undefined;
    },
  ) => Effect.Effect<ResolvedRoleHarness>;
  /** Run deterministic shell checks for a gatekeeper stage without spawning an LLM worker. */
  readonly runGates: (input: {
    readonly commands: ReadonlyArray<string>;
    readonly workspaceRoot: string;
    readonly cwd?: string | undefined;
    readonly runFolder?: string | undefined;
  }) => Effect.Effect<RunGatesResult>;
}

const BUILTIN_ROLE_NAMES = new Set(BUILTIN_ROLES.map((role) => role.name));
const BUILTIN_PIPELINE_NAMES = new Set(BUILTIN_PIPELINES.map((pipeline) => pipeline.name));

const invalid = (message: string) => new PmError({ code: "invalid_request", message });
const unavailable = (message: string) => new PmError({ code: "unavailable", message });

const toContractRole = (role: Role): PmPipelineRole => ({
  name: role.name,
  description: role.description,
  tier: role.tier,
  ...(role.maxTier !== undefined ? { maxTier: role.maxTier } : {}),
  access: role.access ?? "write",
  ...(role.multimodal !== undefined ? { multimodal: role.multimodal } : {}),
  ...(role.candidates !== undefined
    ? {
        candidates: role.candidates.map((candidate) => ({
          provider: candidate.provider,
          model: candidate.model,
          ...(candidate.effort !== undefined ? { effort: candidate.effort } : {}),
        })),
      }
    : {}),
  ...(role.skills !== undefined ? { skills: role.skills } : {}),
  ...(role.contextFiles !== undefined ? { contextFiles: role.contextFiles } : {}),
  ...(role.toolkits !== undefined ? { toolkits: role.toolkits } : {}),
  ...(role.outputContract !== undefined ? { outputContract: role.outputContract } : {}),
  instructions: role.instructions,
});

const toContractPipeline = (pipeline: Pipeline): PmPipelineDefinition => ({
  name: pipeline.name,
  description: pipeline.description,
  when: pipeline.when,
  ...(pipeline.escalateAfter !== undefined ? { escalateAfter: pipeline.escalateAfter } : {}),
  ...(pipeline.replanAfter !== undefined ? { replanAfter: pipeline.replanAfter } : {}),
  stages: pipeline.stages.map((stage) => ({
    id: stage.id,
    ...(stage.role !== undefined ? { role: stage.role } : {}),
    goal: stage.goal,
    ...(stage.reads !== undefined ? { reads: stage.reads } : {}),
    ...(stage.produces !== undefined ? { produces: stage.produces } : {}),
    ...(stage.workspace !== undefined ? { workspace: stage.workspace } : {}),
    ...(stage.parallel !== undefined ? { parallel: stage.parallel } : {}),
    ...(stage.foreach !== undefined ? { foreach: stage.foreach } : {}),
    ...(stage.differentProviderFrom !== undefined
      ? { differentProviderFrom: stage.differentProviderFrom }
      : {}),
    ...(stage.approval !== undefined ? { approval: stage.approval } : {}),
    ...(stage.skipWhen !== undefined ? { skipWhen: stage.skipWhen } : {}),
    ...(stage.onFail !== undefined ? { onFail: stage.onFail } : {}),
    ...(stage.run !== undefined ? { run: stage.run } : {}),
  })),
});

const buildSnapshot = (input: {
  readonly projectId: string;
  readonly root: string | null;
  readonly loaded: LoadResult;
  readonly providers: ReadonlyArray<ProviderSnapshot>;
  readonly limited?: ReadonlyMap<string, string> | undefined;
  readonly discoveredSkills: PmWorkspacePipelinesSnapshot["discoveredSkills"];
}): PmWorkspacePipelinesSnapshot => ({
  projectId: ProjectId.make(input.projectId),
  workspaceRoot: input.root,
  roles: [...input.loaded.config.roles.values()]
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((role) => {
      const source = input.loaded.config.sources.get(`role:${role.name}`) ?? "built-in";
      const isBuiltIn = BUILTIN_ROLE_NAMES.has(role.name);
      const isOverridden = source !== "built-in";
      const resolution = resolveRole({
        config: input.loaded.config,
        role: role.name,
        providers: input.providers,
        limited: input.limited,
      });
      if (resolution.ok) {
        const effortOption = resolution.selection.options[0];
        return {
          role: toContractRole(role),
          source,
          isBuiltIn,
          isOverridden,
          resolvedModel: {
            provider: resolution.selection.instanceId,
            model: resolution.selection.model,
            effort: effortOption ? String(effortOption.value) : null,
          },
          resolvedNote: resolution.notes.length > 0 ? resolution.notes.join(" ") : null,
        };
      }
      return {
        role: toContractRole(role),
        source,
        isBuiltIn,
        isOverridden,
        resolvedModel: null,
        resolvedNote: resolution.reason,
      };
    }),
  pipelines: [...input.loaded.config.pipelines.values()]
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((pipeline) => {
      const source = input.loaded.config.sources.get(`pipeline:${pipeline.name}`) ?? "built-in";
      return {
        pipeline: toContractPipeline(pipeline),
        source,
        isBuiltIn: BUILTIN_PIPELINE_NAMES.has(pipeline.name),
        isOverridden: source !== "built-in",
      };
    }),
  providers: input.providers.map((provider) => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? null,
    enabled: provider.enabled,
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      reasoningChoices: model.reasoning?.choices ?? [],
    })),
  })),
  discoveredSkills: input.discoveredSkills,
  skillCatalog: [...input.loaded.config.skills.values()]
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      name: skill.name,
      title: skill.title,
      description: skill.description,
      category: skill.category,
      roles: [...skill.roles],
      families: [...skill.families],
      ...(skill.familyGuidance ? { familyGuidance: skill.familyGuidance } : {}),
      source: input.loaded.config.sources.get(`skill:${skill.name}`) ?? "built-in",
      hasDiskSkill: input.discoveredSkills.some(
        (entry) => entry.name.toLowerCase() === skill.name.toLowerCase(),
      ),
    })),
  problems: [...input.loaded.problems],
});

export class PipelineService extends Context.Service<PipelineService, PipelineServiceShape>()(
  "t3/pipelines/PipelineService",
) {}

const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const registry = Option.getOrUndefined(
    yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry),
  );

  const readFile = Effect.fn("PipelineService.readFile")(function* (
    base: string,
    relative: string,
    files: Array<ConfigFile>,
  ) {
    const absolute = path.join(base, relative);
    const info = yield* fs.stat(absolute);
    if (info.type !== "File" || Number(info.size) > MAX_BYTES) return;
    files.push({ path: relative, text: yield* fs.readFileString(absolute) });
  });

  const readYamlFiles = Effect.fn("PipelineService.readYamlFiles")(function* (root: string) {
    const base = path.join(root, CONFIG_DIR);
    const files: Array<ConfigFile> = [];
    const read = (relative: string) => readFile(base, relative, files).pipe(Effect.ignore);
    for (const name of ["tiers.yaml", "tiers.yml", "skills.yaml", "skills.yml"]) yield* read(name);
    for (const folder of ["roles", "pipelines", "skills"]) {
      const names = yield* fs
        .readDirectory(path.join(base, folder))
        .pipe(Effect.orElseSucceed(() => [] as Array<string>));
      for (const name of names.filter((entry) => /\.ya?ml$/i.test(entry)).sort()) {
        if (files.length >= MAX_FILES) break;
        yield* read(`${folder}/${name}`);
      }
    }
    return files;
  });

  const configFor: PipelineServiceShape["configFor"] = Effect.fn("PipelineService.configFor")(
    function* (projectId: string) {
      const project = yield* projects
        .getById(projectId as ProjectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const root = Option.match(project, {
        onNone: () => null,
        onSome: (value) => value.workspaceRoot,
      });
      const files = root === null ? [] : yield* readYamlFiles(root);
      return { ...loadPipelineConfig(files), root };
    },
  );

  const providers =
    registry === undefined
      ? Effect.succeed([] as ReadonlyArray<ProviderSnapshot>)
      : registry.getProviders.pipe(Effect.map((list) => list.map(toSnapshot)));

  const limitedProviders: PipelineServiceShape["limitedProviders"] =
    registry === undefined
      ? Effect.succeed(new Map<string, string>() as ReadonlyMap<string, string>)
      : Effect.gen(function* () {
          const [list, now] = yield* Effect.all([registry.getProviders, DateTime.now]);
          return toLimitedProviders(list, DateTime.toEpochMillis(now));
        });

  const snapshotFor: PipelineServiceShape["snapshotFor"] = Effect.fn("PipelineService.snapshotFor")(
    function* (projectId: string) {
      const { config, problems, root } = yield* configFor(projectId);
      const currentProviders = yield* providers;
      const currentLimited = yield* limitedProviders;
      const discoveredSkills = yield* discoverAvailableSkills(root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return buildSnapshot({
        projectId,
        root,
        loaded: { config, problems },
        providers: currentProviders,
        limited: currentLimited,
        discoveredSkills,
      });
    },
  );

  const requireWorkspaceRoot = Effect.fn("PipelineService.requireWorkspaceRoot")(function* (
    projectId: string,
  ) {
    const project = yield* projects
      .getById(projectId as ProjectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) {
      return yield* invalid(`Project "${projectId}" was not found.`);
    }
    return project.value.workspaceRoot;
  });

  const removeYamlVariants = Effect.fn("PipelineService.removeYamlVariants")(function* (
    dir: string,
    slug: string,
  ) {
    for (const ext of [".yaml", ".yml"]) {
      const candidate = path.join(dir, `${slug}${ext}`);
      const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        yield* fs.remove(candidate).pipe(Effect.ignore);
      }
    }
  });

  const saveRole: PipelineServiceShape["saveRole"] = Effect.fn("PipelineService.saveRole")(
    function* (input) {
      const name = input.role.name.trim();
      if (!isValidPipelineSlug(name)) {
        return yield* invalid(
          `Role name "${name}" must use lowercase letters, digits, hyphens, or underscores (1-64 chars).`,
        );
      }
      const root = yield* requireWorkspaceRoot(input.projectId);
      const { candidates: rawCandidates, ...restRole } = input.role;
      const description = restRole.description.trim();
      const role: Role = {
        ...restRole,
        name,
        description,
        instructions:
          restRole.instructions && restRole.instructions.trim().length > 0
            ? restRole.instructions.trim()
            : description,
        ...(rawCandidates !== undefined
          ? {
              candidates: rawCandidates.map((candidate) => ({
                provider: candidate.provider.trim(),
                model: candidate.model.trim(),
                ...(candidate.effort !== undefined
                  ? { effort: candidate.effort as Role["effort"] }
                  : {}),
              })),
            }
          : {}),
      };
      const yamlText = serializeRoleYaml(role);
      const check = loadPipelineConfig([{ path: `roles/${name}.yaml`, text: yamlText }]);
      if (check.problems.length > 0) {
        return yield* invalid(check.problems.join(" "));
      }
      const rolesDir = path.join(root, CONFIG_DIR, "roles");
      yield* fs
        .makeDirectory(rolesDir, { recursive: true })
        .pipe(Effect.mapError(() => unavailable("Could not create .pipelines/roles directory.")));
      if (
        input.previousName !== undefined &&
        input.previousName.trim() !== name &&
        isValidPipelineSlug(input.previousName.trim())
      ) {
        yield* removeYamlVariants(rolesDir, input.previousName.trim());
      }
      yield* fs
        .writeFileString(path.join(rolesDir, `${name}.yaml`), yamlText)
        .pipe(Effect.mapError(() => unavailable(`Could not write .pipelines/roles/${name}.yaml.`)));
      return yield* snapshotFor(input.projectId);
    },
  );

  const deleteRole: PipelineServiceShape["deleteRole"] = Effect.fn("PipelineService.deleteRole")(
    function* (input) {
      const name = input.name.trim();
      if (!isValidPipelineSlug(name)) {
        return yield* invalid(`Invalid role name "${name}".`);
      }
      const root = yield* requireWorkspaceRoot(input.projectId);
      yield* removeYamlVariants(path.join(root, CONFIG_DIR, "roles"), name);
      return yield* snapshotFor(input.projectId);
    },
  );

  const savePipeline: PipelineServiceShape["savePipeline"] = Effect.fn(
    "PipelineService.savePipeline",
  )(function* (input) {
    const name = input.pipeline.name.trim();
    if (!isValidPipelineSlug(name)) {
      return yield* invalid(
        `Pipeline name "${name}" must use lowercase letters, digits, hyphens, or underscores (1-64 chars).`,
      );
    }
    if (input.pipeline.stages.length === 0) {
      return yield* invalid("A pipeline must have at least one stage.");
    }
    const root = yield* requireWorkspaceRoot(input.projectId);
    const description = input.pipeline.description.trim();
    const pipeline: Pipeline = {
      ...input.pipeline,
      name,
      description,
      when:
        input.pipeline.when && input.pipeline.when.trim().length > 0
          ? input.pipeline.when.trim()
          : description,
    };
    const yamlText = serializePipelineYaml(pipeline);
    const existingFiles = yield* readYamlFiles(root);
    const filtered = existingFiles.filter(
      (file) =>
        file.path !== `pipelines/${name}.yaml` &&
        file.path !== `pipelines/${name}.yml` &&
        (input.previousName === undefined ||
          (file.path !== `pipelines/${input.previousName.trim()}.yaml` &&
            file.path !== `pipelines/${input.previousName.trim()}.yml`)),
    );
    const check = loadPipelineConfig([
      ...filtered,
      { path: `pipelines/${name}.yaml`, text: yamlText },
    ]);
    const pipelineProblems = check.problems.filter((line) =>
      line.includes(`pipelines/${name}.yaml`),
    );
    if (pipelineProblems.length > 0) {
      return yield* invalid(pipelineProblems.join(" "));
    }
    const pipelinesDir = path.join(root, CONFIG_DIR, "pipelines");
    yield* fs
      .makeDirectory(pipelinesDir, { recursive: true })
      .pipe(Effect.mapError(() => unavailable("Could not create .pipelines/pipelines directory.")));
    if (
      input.previousName !== undefined &&
      input.previousName.trim() !== name &&
      isValidPipelineSlug(input.previousName.trim())
    ) {
      yield* removeYamlVariants(pipelinesDir, input.previousName.trim());
    }
    yield* fs
      .writeFileString(path.join(pipelinesDir, `${name}.yaml`), yamlText)
      .pipe(
        Effect.mapError(() => unavailable(`Could not write .pipelines/pipelines/${name}.yaml.`)),
      );
    return yield* snapshotFor(input.projectId);
  });

  const deletePipeline: PipelineServiceShape["deletePipeline"] = Effect.fn(
    "PipelineService.deletePipeline",
  )(function* (input) {
    const name = input.name.trim();
    if (!isValidPipelineSlug(name)) {
      return yield* invalid(`Invalid pipeline name "${name}".`);
    }
    const root = yield* requireWorkspaceRoot(input.projectId);
    yield* removeYamlVariants(path.join(root, CONFIG_DIR, "pipelines"), name);
    return yield* snapshotFor(input.projectId);
  });

  const resolveHarness: PipelineServiceShape["resolveHarness"] = (role, workspaceRoot, options) =>
    resolveRoleHarness({
      role,
      workspaceRoot,
      skillCatalog: options?.skillCatalog,
      modelFamily: options?.modelFamily,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const runGates: PipelineServiceShape["runGates"] = (input) =>
    runDeterministicGates(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  return {
    configFor,
    snapshotFor,
    saveRole,
    deleteRole,
    savePipeline,
    deletePipeline,
    providers,
    limitedProviders,
    resolveHarness,
    runGates,
  } satisfies PipelineServiceShape;
});

export const layer = Layer.effect(PipelineService, make);

export type TestFiles = ReadonlyArray<ConfigFile>;

/** For tests: fixed providers and project files, no disk or registry. */
export const layerTest = (input: {
  readonly providers?: ReadonlyArray<ProviderSnapshot>;
  readonly limitedProviders?: ReadonlyMap<string, string>;
  readonly files?: TestFiles;
}) => {
  const testProviders = input.providers ?? [];
  const testLimited = input.limitedProviders ?? new Map<string, string>();
  const testSnapshot = (projectId: string) =>
    Effect.sync(() =>
      buildSnapshot({
        projectId,
        root: null,
        loaded: loadPipelineConfig(input.files ?? []),
        providers: testProviders,
        limited: testLimited,
        discoveredSkills: [],
      }),
    );
  return Layer.succeed(PipelineService, {
    configFor: Effect.fn("PipelineService.test.configFor")(() =>
      Effect.sync(() => ({ ...loadPipelineConfig(input.files ?? []), root: null })),
    ),
    snapshotFor: Effect.fn("PipelineService.test.snapshotFor")(testSnapshot),
    saveRole: Effect.fn("PipelineService.test.saveRole")(({ projectId }) =>
      testSnapshot(projectId),
    ),
    deleteRole: Effect.fn("PipelineService.test.deleteRole")(({ projectId }) =>
      testSnapshot(projectId),
    ),
    savePipeline: Effect.fn("PipelineService.test.savePipeline")(({ projectId }) =>
      testSnapshot(projectId),
    ),
    deletePipeline: Effect.fn("PipelineService.test.deletePipeline")(({ projectId }) =>
      testSnapshot(projectId),
    ),
    providers: Effect.succeed(testProviders),
    limitedProviders: Effect.succeed(testLimited),
    resolveHarness: Effect.fn("PipelineService.test.resolveHarness")(() => Effect.succeed({})),
    runGates: Effect.fn("PipelineService.test.runGates")(
      ({ commands }: Parameters<PipelineServiceShape["runGates"]>[0]) =>
        Effect.succeed({
          passed: true,
          results: commands.map((command) => ({ command, exitCode: 0, summary: "" })),
          gatesFile: null,
          report: `PASS (${commands.length}/${commands.length} commands passed)`,
        }),
    ),
  });
};
