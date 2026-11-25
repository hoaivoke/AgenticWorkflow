// pipelines: glue between PM threads and the role router. Kept out of PmService so the PM3code
// files stay close to their upstream.
import {
  ModelSelection,
  PmError,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection as ModelSelectionType,
} from "@t3tools/contracts";
import {
  renderPipeline,
  renderPipelineList,
  renderRoleBrief,
  renderRoles,
  resolveRole,
  type ProviderSnapshot,
} from "@t3tools/pipelines";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { PmStore } from "../pm/PmStore.ts";
import { PipelineService } from "./PipelineService.ts";

const invalid = (message: string) => new PmError({ code: "invalid_request", message });
const unavailable = (message: string) => () => new PmError({ code: "unavailable", message });

const decodeSelection = Schema.decodeUnknownSync(ModelSelection);

const shellOf = Effect.fn("PmRouting.shellOf")(function* (threadId: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return yield* threads
    .getThreadShell(ThreadId.make(threadId))
    .pipe(Effect.mapError(unavailable(`Could not read thread ${threadId}.`)));
});

/**
 * Accounts this PM's workers have run into usage limits on, with the reset time. A worker that
 * failed on a limit that has since reset no longer counts.
 */
const limitedAccounts = Effect.fn("PmRouting.limitedAccounts")(function* (pm: string) {
  const store = yield* PmStore;
  const now = yield* DateTime.now;
  const workers = yield* store
    .listWorkers(pm)
    .pipe(Effect.mapError(unavailable("Could not list workers.")));
  const limited = new Map<string, string>();
  for (const worker of workers) {
    const shell = yield* shellOf(worker.workerThreadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.lastErrorClass !== "usage_limit") continue;
    const reset = shell.usageLimitResetAt;
    if (reset === null || reset === undefined) continue;
    const resetAt = DateTime.makeUnsafe(reset);
    if (DateTime.isLessThanOrEqualTo(resetAt, now)) continue;
    const instance = shell.modelSelection.instanceId;
    const known = limited.get(instance);
    const iso = DateTime.formatIso(resetAt);
    if (known === undefined || iso > known) limited.set(instance, iso);
  }
  return limited as ReadonlyMap<string, string>;
});

const projectOf = Effect.fn("PmRouting.projectOf")(function* (pm: string) {
  const shell = yield* shellOf(pm);
  if (shell === null) return yield* invalid(`Thread ${pm} is gone.`);
  return shell;
});

export interface RouteWorkerInput {
  readonly pm: string;
  readonly role: string;
  readonly escalate?: number | undefined;
  /** Threads whose vendor this worker should not share (the work it reviews). */
  readonly avoidProviderOf?: ReadonlyArray<string> | undefined;
  /** A model the PM chose itself; the role still shapes the brief. */
  readonly modelSelection?: ModelSelectionType | undefined;
}

export interface RoutedWorker {
  readonly modelSelection: ModelSelectionType;
  /** Role instructions that go above the PM's brief. */
  readonly preamble: string;
  /** One line for the PM: which model and why. */
  readonly summary: string;
}

/** Pick a worker's model from its role, the user's accounts and their usage limits. */
export const routeWorker = Effect.fn("PmRouting.routeWorker")(function* (input: RouteWorkerInput) {
  const pipelines = yield* PipelineService;
  const pmShell = yield* projectOf(input.pm);
  const { config, problems } = yield* pipelines.configFor(pmShell.projectId);
  const role = config.roles.get(input.role);
  if (role === undefined) {
    return yield* invalid(
      `There is no role "${input.role}". Roles: ${[...config.roles.keys()].join(", ")}.`,
    );
  }
  const problemNote = problems.length === 0 ? "" : ` Ignored config: ${problems.join(" ")}`;

  if (input.modelSelection !== undefined) {
    return {
      modelSelection: input.modelSelection,
      preamble: renderRoleBrief(role, role.tier),
      summary: `Role ${role.name} on ${input.modelSelection.instanceId}/${input.modelSelection.model}, the model you chose.${problemNote}`,
    } satisfies RoutedWorker;
  }

  const providers = yield* pipelines.providers;
  const limited = yield* limitedAccounts(input.pm);
  const avoidDrivers: Array<string> = [];
  for (const thread of input.avoidProviderOf ?? []) {
    const shell = yield* shellOf(thread).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) continue;
    const driver = driverOf(providers, shell.modelSelection.instanceId);
    if (driver !== undefined) avoidDrivers.push(driver);
  }

  const resolution = resolveRole({
    config,
    role: role.name,
    providers,
    escalate: input.escalate,
    limited,
    avoidDrivers,
  });
  if (!resolution.ok) {
    return yield* invalid(
      `${resolution.reason} ${resolution.tried.join(" ")} Ask the user to sign in to another provider, wait for a limit to reset, or set modelSelection yourself.`,
    );
  }
  const selection = resolution.selection;
  const modelSelection = decodeSelection({
    instanceId: ProviderInstanceId.make(selection.instanceId),
    model: selection.model,
    ...(selection.options.length === 0 ? {} : { options: selection.options }),
  });
  const effort = selection.options
    .map((option) => `${option.id}=${String(option.value)}`)
    .join(", ");
  return {
    modelSelection,
    preamble: renderRoleBrief(resolution.role, resolution.tier),
    summary: `Role ${role.name} on ${selection.instanceId}/${selection.model}${effort === "" ? "" : ` (${effort})`}, ${resolution.tier} tier.${resolution.notes.length === 0 ? "" : ` ${resolution.notes.join(" ")}`}${problemNote}`,
  } satisfies RoutedWorker;
});

const driverOf = (providers: ReadonlyArray<ProviderSnapshot>, instanceId: string) =>
  providers.find((provider) => provider.instanceId === instanceId)?.driver;

/** `pm_pipelines`: the list, or one pipeline's plan. */
export const pipelinesText = Effect.fn("PmRouting.pipelinesText")(function* (
  pm: string,
  name: string | undefined,
) {
  const pipelines = yield* PipelineService;
  const shell = yield* projectOf(pm);
  const { config, problems } = yield* pipelines.configFor(shell.projectId);
  if (name === undefined) return renderPipelineList(config, problems);
  const text = renderPipeline(config, name, problems);
  if (text === undefined) {
    return yield* invalid(
      `There is no pipeline "${name}". Pipelines: ${[...config.pipelines.keys()].join(", ")}.`,
    );
  }
  return text;
});

/** `pm_roles`: every role and the model it would get right now. */
export const rolesText = Effect.fn("PmRouting.rolesText")(function* (pm: string) {
  const pipelines = yield* PipelineService;
  const shell = yield* projectOf(pm);
  const { config, problems } = yield* pipelines.configFor(shell.projectId);
  const providers = yield* pipelines.providers;
  const limited = yield* limitedAccounts(pm);
  return renderRoles(config, providers, limited, problems);
});
