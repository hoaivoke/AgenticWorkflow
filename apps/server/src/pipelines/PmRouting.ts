// pipelines: glue between PM threads and the role router. Kept out of PmService so the PM3code
// files stay close to their upstream.
import {
  ModelSelection,
  PmError,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import {
  detectModelFamily,
  renderPipeline,
  renderPipelineList,
  renderRoleBrief,
  renderRoles,
  renderScheduledWorkerPrompt,
  resolveRole,
  type ProviderSnapshot,
} from "@t3tools/pipelines";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
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
 * Accounts currently out of usage: live 100%-spent provider windows from the registry merged with
 * accounts this PM's workers have stopped on with a usage limit that has not reset yet.
 */
const limitedAccounts = Effect.fn("PmRouting.limitedAccounts")(function* (pm: string) {
  const pipelines = yield* PipelineService;
  const store = yield* PmStore;
  const now = yield* DateTime.now;
  const liveLimited = yield* pipelines.limitedProviders;
  const workers = yield* store
    .listWorkers(pm)
    .pipe(Effect.mapError(unavailable("Could not list workers.")));
  const limited = new Map<string, string>(liveLimited);
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
    if (known === undefined || known === "usage limit resets" || iso > known) {
      limited.set(instance, iso);
    }
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
  const { config, problems, root } = yield* pipelines.configFor(pmShell.projectId);
  const role = config.roles.get(input.role);
  if (role === undefined) {
    return yield* invalid(
      `There is no role "${input.role}". Roles: ${[...config.roles.keys()].join(", ")}.`,
    );
  }
  const problemNote = problems.length === 0 ? "" : ` Ignored config: ${problems.join(" ")}`;

  if (input.modelSelection !== undefined) {
    const modelFamily = detectModelFamily(
      `${input.modelSelection.instanceId} ${input.modelSelection.model}`,
    );
    const harness = yield* pipelines
      .resolveHarness(role, root, { skillCatalog: config.skills, modelFamily })
      .pipe(Effect.orElseSucceed(() => undefined));
    return {
      modelSelection: input.modelSelection,
      preamble: renderRoleBrief(role, role.tier, harness),
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
  const modelFamily = detectModelFamily(`${selection.driver} ${selection.model}`);
  const harness = yield* pipelines
    .resolveHarness(resolution.role, root, { skillCatalog: config.skills, modelFamily })
    .pipe(Effect.orElseSucceed(() => undefined));
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
    preamble: renderRoleBrief(resolution.role, resolution.tier, harness),
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

/** `pm_run_gates`: execute deterministic check commands without spending an LLM turn. */
export const runGatesText = Effect.fn("PmRouting.runGatesText")(function* (input: {
  readonly pm: string;
  readonly commands?: ReadonlyArray<string> | undefined;
  readonly stage?: string | undefined;
  readonly pipeline?: string | undefined;
  readonly cwd?: string | undefined;
  readonly runFolder?: string | undefined;
}) {
  const pipelines = yield* PipelineService;
  const shell = yield* projectOf(input.pm);
  const { config, root } = yield* pipelines.configFor(shell.projectId);
  if (root === null) {
    return yield* invalid("This project has no workspace root on disk.");
  }
  let commands = input.commands ?? [];
  if (commands.length === 0 && input.pipeline) {
    const pipeline = config.pipelines.get(input.pipeline);
    if (pipeline === undefined) {
      return yield* invalid(`There is no pipeline "${input.pipeline}".`);
    }
    const stageId = input.stage ?? "gates";
    const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
    commands = stage?.run ?? [];
  }
  if (commands.length === 0) {
    return yield* invalid(
      "Pass `commands` (non-empty array) or a `pipeline` whose `gates` stage defines `run` commands.",
    );
  }
  const outcome = yield* pipelines.runGates({
    commands,
    workspaceRoot: root,
    cwd: input.cwd,
    runFolder: input.runFolder,
  });
  return outcome.report;
});

export interface ScheduleWorkerInput {
  readonly pm: string;
  readonly title: string;
  /** What `pm_worker_start` gets on each run, minus the schedule. */
  readonly startArguments: Readonly<Record<string, unknown>> & {
    readonly role?: string | undefined;
  };
  readonly schedule: ScheduledTaskUpsertSchedule;
  readonly enabled?: boolean | undefined;
}

const scheduleFailureCode = (code: string) =>
  code === "invalid_request" || code === "target_required"
    ? ("invalid_request" as const)
    : code === "capability_denied" ||
        code === "runtime_mode_escalation_denied" ||
        code === "interaction_mode_escalation_denied"
      ? ("conflict" as const)
      : ("unavailable" as const);

/**
 * `pm_worker_schedule`: a T3 scheduled task bound to the PM's own thread. Each run asks the PM to
 * start the worker, so it becomes a normal worker that reports back, and its role picks the model
 * at run time. Pausing, listing and deleting stay T3's own tools and Settings page.
 */
export const scheduleWorker = Effect.fn("PmRouting.scheduleWorker")(function* (
  input: ScheduleWorkerInput,
) {
  const role = input.startArguments.role;
  if (role !== undefined) {
    const pipelines = yield* PipelineService;
    const shell = yield* projectOf(input.pm);
    const { config } = yield* pipelines.configFor(shell.projectId);
    if (!config.roles.has(role)) {
      return yield* invalid(
        `There is no role "${role}". Roles: ${[...config.roles.keys()].join(", ")}.`,
      );
    }
  }
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
  const task = yield* orchestrator
    .scheduleTask(scope, {
      title: `Worker: ${input.title}`,
      prompt: renderScheduledWorkerPrompt(input.title, input.startArguments),
      schedule: input.schedule,
      bindToCurrentThread: true,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    })
    .pipe(
      Effect.mapError(
        (failure) =>
          new PmError({ code: scheduleFailureCode(failure.code), message: failure.message }),
      ),
    );
  const when =
    task.webhookUrl !== undefined
      ? `It runs when ${task.webhookUrl} receives a request.`
      : task.nextRunAt === null
        ? "It has no next run time."
        : `Next run: ${task.nextRunAt}.`;
  return `Scheduled worker "${input.title}" as task ${task.scheduledTaskId}${task.enabled ? "" : " (paused)"}. ${when} Each run posts a "Scheduled worker" message here; start the worker it names. Pause with schedule_task { scheduledTaskId, enabled: false }, remove with delete_scheduled_task.`;
});
