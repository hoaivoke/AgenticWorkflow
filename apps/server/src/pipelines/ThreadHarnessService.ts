// pipelines: unified cross-model thread harness & live skill/context provenance service.
import {
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type PmThreadHarnessState,
  type ProjectId,
} from "@t3tools/contracts";
import {
  BUILTIN_SKILLS,
  detectModelFamily,
  matchSkillsForRole,
  renderRoleBrief,
  type ModelFamily,
  type PipelineConfig,
  type Role,
} from "@t3tools/pipelines";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { resolveHarnessInputs } from "./HarnessResolver.ts";
import { PipelineService } from "./PipelineService.ts";
import { ThreadHarnessStore, type ThreadHarnessRow } from "./ThreadHarnessStore.ts";

const SKILL_PATH_RE =
  /(?:^|[\s"'`(=:])([^\s"'`()=:,;]*?\/([a-zA-Z0-9._-]+)\/SKILL\.md)(?=$|[\s"'`),;:])/gi;
const SKILL_DIR_RE =
  /(?:\.pipelines|\.agents|\.claude|\.gemini(?:\/[^/\s"'`]+)*)\/skills\/([a-zA-Z0-9._-]+)\b/gi;

const CONTEXT_BASENAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "ARCHITECTURE.md",
  "SPEC.md",
  "spec.md",
  "PLAN.md",
  "plan.md",
  "TASKS.md",
  "tasks.md",
  "features.json",
  "threat-model.md",
]);

const CONTEXT_PATH_PREFIXES = [
  ".pipelines/runs/",
  ".pipelines/roles/",
  ".pipelines/pipelines/",
  "docs/",
  "tasks/",
];

const IGNORED_PATH_SEGMENTS = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  ".turbo/",
  "coverage/",
];

const BUILTIN_SKILL_SLUGS: ReadonlyArray<string> = BUILTIN_SKILLS.map((skill) => skill.name);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const FILE_TOKEN_RE = /([^\s"'`()=:,;]+?\.(?:md|json|ya?ml))(?=$|[\s"'`),;:])/gi;

function toWorkspaceRelative(rawPath: string, workspaceRoot: string | null): string | null {
  const cleaned = rawPath
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/");
  if (!cleaned || cleaned.includes("..")) return null;
  if (IGNORED_PATH_SEGMENTS.some((segment) => cleaned.includes(segment))) return null;
  if (cleaned.startsWith("/")) {
    if (workspaceRoot === null) return null;
    const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!cleaned.startsWith(`${normalizedRoot}/`)) return null;
    return cleaned.slice(normalizedRoot.length + 1);
  }
  return cleaned.replace(/^\.\//, "");
}

function isTrackableContextFile(relativePath: string): boolean {
  const base = relativePath.split("/").at(-1) ?? "";
  if (CONTEXT_BASENAMES.has(base)) return true;
  if (
    CONTEXT_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) &&
    /\.(?:md|json|ya?ml)$/i.test(relativePath)
  ) {
    return true;
  }
  return false;
}

function collectStringsFromUnknown(value: unknown, out: Array<string>, depth = 0): void {
  if (depth > 4 || out.length >= 40 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length > 0 && value.length <= 4_000) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringsFromUnknown(entry, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectStringsFromUnknown(entry, out, depth + 1);
    }
  }
}

/**
 * Pure provenance extractor: finds skills (`SKILL.md` paths or Skill Database slugs named in
 * commands/tool inputs) and key repo context files touched in a turn item.
 */
export function extractProvenanceFromTurnItem(
  item: OrchestrationV2TurnItem,
  workspaceRoot: string | null,
  knownSkillSlugs: ReadonlyArray<string> = BUILTIN_SKILL_SLUGS,
): { readonly skills: ReadonlyArray<string>; readonly contextFiles: ReadonlyArray<string> } {
  const texts: Array<string> = [];
  const directPaths: Array<string> = [];

  if (item.title) texts.push(item.title);
  switch (item.type) {
    case "command_execution":
      texts.push(item.input);
      break;
    case "file_change":
      directPaths.push(item.fileName);
      for (const change of item.changes ?? []) directPaths.push(change.path);
      break;
    case "file_search":
      if (item.pattern) texts.push(item.pattern);
      for (const result of item.results ?? []) directPaths.push(result.fileName);
      break;
    case "dynamic_tool":
      if (item.toolName) texts.push(item.toolName);
      collectStringsFromUnknown(item.input, texts);
      break;
    default:
      return { skills: [], contextFiles: [] };
  }

  const skills = new Set<string>();
  const contextFiles = new Set<string>();

  // Only compound slugs (e.g. `tdd-verification`) count as a mention; bare words like `docs` are too noisy.
  const slugMatchers = knownSkillSlugs
    .filter((slug) => /[-_]/.test(slug))
    .map((slug) => ({
      slug,
      re: new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(slug)}(?![A-Za-z0-9_-])`, "i"),
    }));

  const inspectText = (text: string) => {
    for (const { slug, re } of slugMatchers) {
      if (re.test(text)) skills.add(slug);
    }
    for (const match of text.matchAll(SKILL_PATH_RE)) {
      const skillName = match[2]?.trim();
      if (skillName && !skillName.startsWith(".")) skills.add(skillName);
    }
    for (const match of text.matchAll(SKILL_DIR_RE)) {
      const skillName = match[1]?.trim();
      if (skillName && !skillName.startsWith(".")) skills.add(skillName);
    }
    for (const match of text.matchAll(FILE_TOKEN_RE)) {
      const token = match[1];
      if (!token || /\/SKILL\.md$/i.test(token)) continue;
      const rel = toWorkspaceRelative(token, workspaceRoot);
      if (rel !== null && isTrackableContextFile(rel)) contextFiles.add(rel);
    }
  };

  for (const pathCandidate of directPaths) {
    const skillMatch = /(?:^|\/)([a-zA-Z0-9._-]+)\/SKILL\.md$/i.exec(pathCandidate);
    if (skillMatch?.[1]) {
      skills.add(skillMatch[1]);
      continue;
    }
    const rel = toWorkspaceRelative(pathCandidate, workspaceRoot);
    if (rel !== null && isTrackableContextFile(rel)) contextFiles.add(rel);
  }
  for (const text of texts) inspectText(text);

  return {
    skills: [...skills],
    contextFiles: [...contextFiles],
  };
}

/** Map a thread's model selection to a Big-3 family, preferring the model slug over the instance id. */
function modelFamilyForSelection(
  selection: { readonly instanceId: string; readonly model: string } | null | undefined,
): ModelFamily | null {
  if (!selection) return null;
  return detectModelFamily(selection.model) ?? detectModelFamily(selection.instanceId);
}

/** Skills the role should use on this family, and those not yet observed in the thread. */
function computeSkillRequirements(input: {
  readonly config: Pick<PipelineConfig, "skills">;
  readonly role: Role | null;
  readonly modelFamily: ModelFamily | null;
  readonly trackedSkills: ReadonlyArray<string>;
}): {
  readonly requiredSkills: ReadonlyArray<string>;
  readonly missingSkills: ReadonlyArray<string>;
} {
  if (input.role === null) return { requiredSkills: [], missingSkills: [] };
  const requiredSkills = matchSkillsForRole({
    config: input.config,
    role: input.role,
    modelFamily: input.modelFamily,
  }).map((entry) => entry.name);
  const tracked = new Set(input.trackedSkills.map((skill) => skill.toLowerCase()));
  return {
    requiredSkills,
    missingSkills: requiredSkills.filter((skill) => !tracked.has(skill.toLowerCase())),
  };
}

interface SkillRequirements {
  readonly modelFamily: ModelFamily | null;
  readonly requiredSkills: ReadonlyArray<string>;
  readonly missingSkills: ReadonlyArray<string>;
}

const toState = (
  threadId: ThreadId,
  row: ThreadHarnessRow | null,
  requirements?: SkillRequirements,
): PmThreadHarnessState => ({
  threadId,
  roleName: row?.roleName ?? null,
  ...(requirements === undefined
    ? {}
    : {
        modelFamily: requirements.modelFamily,
        requiredSkills: [...requirements.requiredSkills],
        missingSkills: [...requirements.missingSkills],
      }),
  trackedSkills: row?.trackedSkills ?? [],
  trackedContextFiles: row?.trackedContextFiles ?? [],
  revision: row?.revision ?? 0,
  updatedAt: row?.updatedAt ?? null,
});

export interface PreparedTurnHarness {
  readonly context: string;
  readonly revision: number;
}

export interface ThreadHarnessServiceShape {
  readonly getState: (threadId: ThreadId) => Effect.Effect<PmThreadHarnessState>;
  readonly setHarness: (input: {
    readonly threadId: ThreadId;
    readonly roleName: string | null;
    readonly trackedSkills?: ReadonlyArray<string> | undefined;
    readonly trackedContextFiles?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<PmThreadHarnessState>;
  readonly recordTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string | null;
    readonly item: OrchestrationV2TurnItem;
  }) => Effect.Effect<boolean>;
  readonly prepareTurnContext: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly providerThreadId: string;
    readonly isNewNativeSession: boolean;
  }) => Effect.Effect<PreparedTurnHarness | null>;
  readonly markDelivered: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: string;
    readonly revision: number;
  }) => Effect.Effect<void>;
  readonly remove: (threadId: ThreadId) => Effect.Effect<void>;
}

export class ThreadHarnessService extends Context.Service<
  ThreadHarnessService,
  ThreadHarnessServiceShape
>()("t3/pipelines/ThreadHarnessService") {}

const make = Effect.gen(function* () {
  const store = yield* ThreadHarnessStore;
  const pipelines = yield* PipelineService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fs = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
  const path = Option.getOrUndefined(yield* Effect.serviceOption(Path.Path));

  const readShell = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

  const getState: ThreadHarnessServiceShape["getState"] = Effect.fn(
    "ThreadHarnessService.getState",
  )(function* (threadId: ThreadId) {
    const row = yield* store.get(threadId);
    const shell = yield* readShell(threadId);
    if (shell === null) return toState(threadId, row);
    const modelFamily = modelFamilyForSelection(shell.modelSelection);
    const loaded = yield* pipelines.configFor(shell.projectId).pipe(Effect.option);
    const config = Option.getOrNull(loaded)?.config ?? null;
    const role = row?.roleName && config ? (config.roles.get(row.roleName) ?? null) : null;
    const requirements =
      config === null
        ? { requiredSkills: [], missingSkills: [] }
        : computeSkillRequirements({
            config,
            role,
            modelFamily,
            trackedSkills: row?.trackedSkills ?? [],
          });
    return toState(threadId, row, { modelFamily, ...requirements });
  });

  const setHarness: ThreadHarnessServiceShape["setHarness"] = Effect.fn(
    "ThreadHarnessService.setHarness",
  )(function* (input) {
    const row = yield* store.setConfig({
      threadId: input.threadId,
      roleName: input.roleName,
      trackedSkills: input.trackedSkills,
      trackedContextFiles: input.trackedContextFiles,
    });
    return toState(input.threadId, row);
  });

  const recordTurnItem: ThreadHarnessServiceShape["recordTurnItem"] = Effect.fn(
    "ThreadHarnessService.recordTurnItem",
  )(function* (input) {
    const { skills, contextFiles } = extractProvenanceFromTurnItem(input.item, input.workspaceRoot);
    if (skills.length === 0 && contextFiles.length === 0) return false;
    const { changed } = yield* store.mergeObserved({
      threadId: input.threadId,
      skills,
      contextFiles,
    });
    return changed;
  });

  const prepareTurnContext: ThreadHarnessServiceShape["prepareTurnContext"] = Effect.fn(
    "ThreadHarnessService.prepareTurnContext",
  )(function* (input) {
    const row = yield* store.get(input.threadId);
    if (row === null) return null;
    if (
      row.roleName === null &&
      row.trackedSkills.length === 0 &&
      row.trackedContextFiles.length === 0
    ) {
      return null;
    }

    const lastDeliveredRevision = row.deliveredByProviderThread[input.providerThreadId];
    if (!input.isNewNativeSession && lastDeliveredRevision === row.revision) {
      return null;
    }

    const loaded = yield* pipelines.configFor(input.projectId);
    const role = row.roleName ? (loaded.config.roles.get(row.roleName) ?? null) : null;
    const shell = yield* readShell(input.threadId);
    const modelFamily = modelFamilyForSelection(shell?.modelSelection);
    const { requiredSkills, missingSkills } = computeSkillRequirements({
      config: loaded.config,
      role,
      modelFamily,
      trackedSkills: row.trackedSkills,
    });

    const mergedSkills = [...requiredSkills, ...row.trackedSkills];
    const mergedContextFiles = [...(role?.contextFiles ?? []), ...row.trackedContextFiles];
    const resolvedInputs =
      fs !== undefined && path !== undefined
        ? yield* resolveHarnessInputs({
            skillRequests: mergedSkills,
            contextRequests: mergedContextFiles,
            workspaceRoot: loaded.root,
            skillCatalog: loaded.config.skills,
            modelFamily,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )
        : {};
    // The brief lists the role's required skills; tracked skills are reported in provenance below.
    const resolvedHarness = {
      ...resolvedInputs,
      ...(modelFamily ? { modelFamily } : {}),
      matchedSkills: requiredSkills,
    };

    const sections: Array<string> = [
      "### Workspace Harness Context (configured by the user in Agent Space)",
      "The user selected this role and workspace context in Agent Space so it carries across turns and providers.",
    ];

    if (role !== null) {
      sections.push(renderRoleBrief(role, role.tier, resolvedHarness));
    } else {
      if (resolvedHarness.contextFiles && resolvedHarness.contextFiles.length > 0) {
        const sortedContext = [...resolvedHarness.contextFiles].toSorted((a, b) =>
          a.path.localeCompare(b.path),
        );
        const blocks = sortedContext.map((file) => `### ${file.path}\n${file.content}`);
        sections.push(`Carried-over repository context:\n\n${blocks.join("\n\n")}`);
      }
      if (resolvedHarness.skills && resolvedHarness.skills.length > 0) {
        const sortedSkills = [...resolvedHarness.skills].toSorted((a, b) =>
          a.name.localeCompare(b.name),
        );
        const blocks = sortedSkills.map((skill) => `### Skill: ${skill.name}\n${skill.content}`);
        sections.push(`Carried-over skills from earlier turns:\n\n${blocks.join("\n\n")}`);
      }
    }

    // Dynamic provenance is appended after the static prefix so providers keep prompt-cache hits.
    if (row.trackedSkills.length > 0 || row.trackedContextFiles.length > 0) {
      const provenanceLines: Array<string> = ["Tracked thread provenance:"];
      if (row.trackedSkills.length > 0) {
        provenanceLines.push(`- Skills used in this thread: ${row.trackedSkills.join(", ")}`);
      }
      if (missingSkills.length > 0) {
        provenanceLines.push(`- Required skills not yet used: ${missingSkills.join(", ")}`);
      }
      if (row.trackedContextFiles.length > 0) {
        provenanceLines.push(
          `- Key context files read/edited: ${row.trackedContextFiles.join(", ")}`,
        );
      }
      sections.push(`---\n\n${provenanceLines.join("\n")}`);
    }

    const body = sections.filter((section) => section.trim().length > 0).join("\n\n");
    if (body.trim().length === 0) return null;

    return {
      context: body,
      revision: row.revision,
    };
  });

  const markDelivered: ThreadHarnessServiceShape["markDelivered"] = Effect.fn(
    "ThreadHarnessService.markDelivered",
  )(function* (input) {
    yield* store.markDelivered(input);
  });

  const remove: ThreadHarnessServiceShape["remove"] = Effect.fn("ThreadHarnessService.remove")(
    function* (threadId: ThreadId) {
      yield* store.remove(threadId);
    },
  );

  return {
    getState,
    setHarness,
    recordTurnItem,
    prepareTurnContext,
    markDelivered,
    remove,
  } satisfies ThreadHarnessServiceShape;
});

/** Without the projection store, so tests can supply a thread shell. */
export const layerWithoutProjectionStore = Layer.effect(ThreadHarnessService, make);
export const layer = layerWithoutProjectionStore.pipe(Layer.provide(ProjectionStore.layer));

/** Watches orchestration domain events to track skills and context files used by any model. */
export const layerWatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const harness = yield* ThreadHarnessService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;

    const handle = Effect.fn("ThreadHarnessService.handleEvent")(function* (
      event: OrchestrationV2DomainEvent,
    ) {
      if (event.type === "thread.deleted") {
        yield* harness.remove(event.threadId).pipe(Effect.ignore);
        return;
      }
      if (event.type !== "turn-item.updated") return;
      const item = event.payload;
      if (
        item.type !== "command_execution" &&
        item.type !== "file_change" &&
        item.type !== "file_search" &&
        item.type !== "dynamic_tool"
      ) {
        return;
      }
      const shell = yield* threads
        .getThreadShell(event.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const workspaceRoot =
        shell !== null
          ? Option.match(
              yield* projects
                .getById(shell.projectId)
                .pipe(Effect.orElseSucceed(() => Option.none())),
              {
                onNone: () => null,
                onSome: (project) => project.workspaceRoot,
              },
            )
          : null;
      yield* harness
        .recordTurnItem({
          threadId: event.threadId,
          workspaceRoot,
          item,
        })
        .pipe(Effect.ignore);
    });

    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        handle(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread harness watcher failed on an event", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread harness watcher stopped", { cause }),
        ),
      ),
    );
  }),
);
