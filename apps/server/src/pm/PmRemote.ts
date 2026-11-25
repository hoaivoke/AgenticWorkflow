// t3code-pm: PM workers on the user's other computers, over upstream's Linked environments.
// The link (PeerForwarding) carries every call; nothing here talks to another server directly.
import {
  EnvironmentId,
  type ModelSelection,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  type OrchestratorMcpEnvironmentLink,
  type OrchestratorMcpThreadReadResult,
  PmError,
  type ProjectId,
  type ProviderInstanceId,
  type RepositoryIdentity,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatComputers,
  matchComputer,
  type PmAgentStatus,
  type PmComputer,
  type PmHostLoad,
} from "@t3tools/pm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tool from "effect/ai/Tool";

import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { forkParked } from "../serverActivation.ts";
import { PmService, type StartWorkerInput } from "./PmService.ts";
import { PmStore, type PmRemoteWatch, type PmWorkerRow } from "./PmStore.ts";
import {
  cutReportText,
  firstLine,
  isoMillis,
  QUIET_AFTER_MS,
  QUIET_NUDGE,
  REPORT_LABELS,
  reportMessage,
} from "./PmText.ts";

/** What another computer's PM reads here through its link: agent names and numbers, nothing else. */
export const PmHostStatus = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      name: Schema.String,
      ready: Schema.Boolean,
      reason: Schema.optional(Schema.String),
      windows: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
          label: Schema.String,
          usedPercent: Schema.Number,
          resetsAt: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  load: Schema.Struct({
    cpu: Schema.NullOr(Schema.Number),
    freeMemoryBytes: Schema.Number,
    totalMemoryBytes: Schema.Number,
    runningThreads: Schema.Number,
  }),
});
export type PmHostStatus = typeof PmHostStatus.Type;

// The other side's tools, described here as RemoteDelegation describes its own.
const RemoteHostStatusTool = Tool.make("pm_host_status", {
  success: PmHostStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
});
const RemoteCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
});
const RemoteThreadSendTool = Tool.make("t3_thread_send", {
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
});

/** One forwarded wait on a running worker; under the link's own 45 s cap, which survives T3 Connect. */
const FOLLOW_WAIT_MS = 45_000;
/** How often an idle worker there is looked at again, for a turn the PM or user started. */
export const PmRemoteIdleLook = Context.Reference<Duration.Duration>("t3/pm/PmRemote/IdleLook", {
  defaultValue: () => Duration.seconds(30),
});
const MAX_BACKOFF_MS = 5 * 60_000;
const backoffMs = (failures: number) => Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** (failures - 1));

const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const RUNNING = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Only a thread gone there is final. A refused link (revoked, expired, Linked environments off)
 * shows as unreachable and catches up once the user links it again.
 */
const isFinal = (error: OrchestratorMcpFailure) => error.code === "thread_not_found";
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const invalid = (message: string) => new PmError({ code: "invalid_request", message });
const unavailable = (error: { readonly message: string }) =>
  new PmError({ code: "unavailable", message: error.message });

const repositoryKeys = (identity: RepositoryIdentity | null | undefined) =>
  identity == null
    ? []
    : [
        identity.canonicalKey,
        ...(identity.origin === undefined ? [] : [identity.origin.canonicalKey]),
      ];

const readyOf = (provider: {
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly auth: { readonly status: string };
  readonly availability?: string | undefined;
}): { readonly ready: boolean; readonly reason?: string } => {
  // Fixed words only: provider messages can carry account details, which never leave here.
  if (!provider.installed) return { ready: false, reason: "not installed" };
  if (provider.auth.status === "unauthenticated") return { ready: false, reason: "not signed in" };
  if (provider.availability === "unavailable") return { ready: false, reason: "unavailable" };
  if (provider.status === "error") return { ready: false, reason: "error" };
  return { ready: true };
};

export type ThreadScope = McpInvocationContext.McpInvocationScope;

const make = Effect.gen(function* () {
  const pm = yield* PmService;
  const store = yield* PmStore;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const hostResources = yield* HostResources.HostResources;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const hereId = yield* environment.getEnvironmentId;
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;

  const localAgents = registry.getProviders.pipe(
    Effect.map((providers) =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          instanceId: provider.instanceId as string,
          name: provider.displayName ?? (provider.driver as string),
          ...readyOf(provider),
          windows: (provider.usageLimits?.windows ?? [])
            .filter((window) => window.modelIds === undefined)
            .map((window) => ({
              kind: window.kind,
              label: window.label,
              usedPercent: window.usedPercent,
              ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
            })),
        })),
    ),
  );

  const runningThreads = threads.listActiveShellIndex().pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries.filter((entry) => entry.mayBeLive).slice(0, 200),
        (entry) => threads.getThreadShell(entry.id).pipe(Effect.orElseSucceed(() => null)),
        { concurrency: 8 },
      ),
    ),
    Effect.map(
      (shells) =>
        shells.filter(
          (shell) => shell !== null && RUNNING.has(shell.status) && shell.status !== "waiting",
        ).length,
    ),
    Effect.orElseSucceed(() => 0),
  );

  const localLoad = Effect.gen(function* () {
    const host = yield* hostResources.read;
    return {
      cpu: host.cpuUtilization,
      freeMemoryBytes: host.availableMemoryBytes,
      totalMemoryBytes: host.totalMemoryBytes,
      runningThreads: yield* runningThreads,
    } satisfies PmHostLoad;
  });

  /** `pm_host_status`: this computer, for a PM on a linked one. */
  const hostStatus = Effect.gen(function* () {
    return { agents: yield* localAgents, load: yield* localLoad } satisfies PmHostStatus;
  }).pipe(Effect.withSpan("PmRemote.hostStatus"));

  const pmProject = Effect.fn("PmRemote.pmProject")(function* (pmThreadId: string) {
    const row = yield* store.getPm(pmThreadId).pipe(Effect.orElseSucceed(() => null));
    if (row === null) return null;
    const project = yield* projects.getById(row.projectId as ProjectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined) return null;
    const identity = yield* identities.resolve(project.workspaceRoot);
    return { project, identity, keys: repositoryKeys(identity) };
  });

  /** The projects there with this PM's repository. */
  const projectsThere = Effect.fn("PmRemote.projectsThere")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    keys: ReadonlyArray<string>,
  ) {
    const found: Array<{ readonly id: ProjectId; readonly title: string }> = [];
    if (keys.length === 0) return found;
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> =
        yield* forwarding.call(scope, ProjectToolkit.tools.t3_project_list, environmentId, {
          cursor,
          limit: 100,
        });
      for (const project of listed.projects)
        if (repositoryKeys(project.repositoryIdentity).some((key) => keys.includes(key)))
          found.push({ id: project.id, title: project.title });
      cursor = listed.nextCursor;
    }
    return found;
  });

  const workersOf = (pmThreadId: string) =>
    store.listWorkers(pmThreadId).pipe(Effect.orElseSucceed(() => [] as Array<PmWorkerRow>));

  const countWorkers = (workers: ReadonlyArray<PmWorkerRow>, environmentId: string | null) =>
    workers.filter((worker) => worker.resolvedAt === null && worker.environmentId === environmentId)
      .length;

  const thisComputer = Effect.fn("PmRemote.thisComputer")(function* (
    workers: ReadonlyArray<PmWorkerRow>,
  ) {
    const descriptor = yield* environment.getDescriptor;
    return {
      environmentId: hereId,
      label: descriptor.label,
      here: true,
      pm3code: true,
      load: yield* localLoad.pipe(Effect.orElseSucceed(() => null)),
      agents: yield* localAgents,
      project: null,
      pmWorkers: countWorkers(workers, null),
    } satisfies PmComputer;
  });

  /** The linked computers as names only, without asking any of them: enough to pick one. */
  const linksOf = (scope: ThreadScope) =>
    forwarding.links(scope).pipe(
      Effect.map((result) => ({ links: result.links, off: false })),
      Effect.catchIf(
        (error) => error.code === "capability_denied",
        () =>
          Effect.succeed({ links: [] as ReadonlyArray<OrchestratorMcpEnvironmentLink>, off: true }),
      ),
    );

  const linkedComputer = Effect.fn("PmRemote.linkedComputer")(function* (
    scope: ThreadScope,
    link: OrchestratorMcpEnvironmentLink,
    workers: ReadonlyArray<PmWorkerRow>,
    keys: ReadonlyArray<string> | null,
  ) {
    const base = {
      environmentId: link.environmentId,
      label: link.label,
      here: false,
      link: { status: link.status, access: link.access, lastError: link.lastError },
      pm3code: null,
      load: null,
      agents: null,
      project: null,
      pmWorkers: countWorkers(workers, link.environmentId),
    } satisfies PmComputer;
    if (link.status !== "reachable") return base;
    const host = yield* forwarding
      .call(scope, RemoteHostStatusTool, link.environmentId, {})
      .pipe(Effect.option);
    let agents: ReadonlyArray<PmAgentStatus> | null = Option.isSome(host)
      ? host.value.agents
      : null;
    if (agents === null) {
      // T3 Code without PM3code there: availability only, from upstream's own tool.
      const capabilities = yield* forwarding
        .call(scope, RemoteCapabilitiesTool, link.environmentId, {})
        .pipe(Effect.option);
      if (Option.isNone(capabilities))
        return { ...base, link: { ...base.link, status: "unreachable" as const } };
      agents = capabilities.value.providers.map((provider) => ({
        instanceId: provider.providerInstanceId,
        name: provider.displayName ?? provider.driverKind,
        ready: provider.canRunChildTask && provider.constraints.length === 0,
        ...(provider.constraints[0] === undefined ? {} : { reason: provider.constraints[0] }),
      }));
    }
    const project =
      keys === null
        ? null
        : yield* projectsThere(scope, link.environmentId, keys).pipe(
            Effect.map((found) =>
              found[0] === undefined ? ("none" as const) : { title: found[0].title },
            ),
            Effect.orElseSucceed(() => null),
          );
    return {
      ...base,
      pm3code: Option.isSome(host),
      load: Option.isSome(host) ? host.value.load : null,
      agents,
      project,
    } satisfies PmComputer;
  });

  /** `pm_computers`. */
  const computers = Effect.fn("PmRemote.computers")(function* (
    scope: ThreadScope,
    pmThreadId: string,
  ) {
    const workers = yield* workersOf(pmThreadId);
    const here = yield* thisComputer(workers);
    const { links, off } = yield* linksOf(scope).pipe(Effect.mapError(unavailable));
    const keys = (yield* pmProject(pmThreadId))?.keys ?? null;
    const others = yield* Effect.forEach(
      links,
      (link) => linkedComputer(scope, link, workers, keys),
      { concurrency: 4 },
    );
    const text = formatComputers([here, ...others], DateTime.toEpochMillis(yield* DateTime.now));
    const result = off
      ? `${text}\nLinked environments is off on this computer, so no other computer can be used. The user turns it on in Settings, Labs, on this computer and the other one, then links it in Settings, Environments.`
      : text;
    return { result };
  });

  /** A computer the PM named, from the links alone: this one, or a linked one. */
  const pick = Effect.fn("PmRemote.pick")(function* (scope: ThreadScope, name: string) {
    const { links, off } = yield* linksOf(scope).pipe(Effect.mapError(unavailable));
    const descriptor = yield* environment.getDescriptor;
    const candidates: ReadonlyArray<
      PmComputer & { readonly source?: OrchestratorMcpEnvironmentLink }
    > = [
      {
        environmentId: hereId,
        label: descriptor.label,
        here: true,
        pm3code: true,
        load: null,
        agents: null,
        project: null,
        pmWorkers: 0,
      },
      ...links.map((link) => ({
        environmentId: link.environmentId,
        label: link.label,
        here: false,
        link: { status: link.status, access: link.access, lastError: link.lastError },
        pm3code: null,
        load: null,
        agents: null,
        project: null,
        pmWorkers: 0,
        source: link,
      })),
    ];
    const match = matchComputer(name, candidates);
    if (match.type !== "found")
      return yield* invalid(
        off
          ? `${match.message} Linked environments is off on this computer: the user turns it on in Settings, Labs, on both computers.`
          : match.message,
      );
    const link = (match.computer as (typeof candidates)[number]).source;
    if (match.computer.here || link === undefined) return { here: true as const };
    if (link.status === "expired")
      return yield* invalid(
        `The link to "${link.label}" expired. The user links it again in Settings, Environments; start nothing there until then.`,
      );
    if (link.status !== "reachable")
      return yield* invalid(
        `"${link.label}" is not answering now${link.lastError ? ` (${link.lastError})` : ""}. Start nothing there, and do not start the same work here unless the user asks.`,
      );
    if (link.access === "read-only")
      return yield* invalid(
        `"${link.label}" was linked with read-only access, so no work can start there. The user can link it again with more access in Settings, Environments.`,
      );
    return { here: false as const, link };
  });

  const pmShellOf = (pmThreadId: string) =>
    threads.getThreadShell(ThreadId.make(pmThreadId)).pipe(Effect.orElseSucceed(() => null));

  /** The PM's model there: the same instance, else one of the same driver that can start threads. */
  const modelThere = Effect.fn("PmRemote.modelThere")(function* (
    scope: ThreadScope,
    link: OrchestratorMcpEnvironmentLink,
    selection: ModelSelection,
  ) {
    const capabilities = yield* forwarding
      .call(scope, RemoteCapabilitiesTool, link.environmentId, {})
      .pipe(Effect.mapError(unavailable));
    if (
      capabilities.providers.some(
        (provider) => provider.providerInstanceId === selection.instanceId,
      )
    )
      return selection;
    const driver = (yield* registry.getProviders).find(
      (provider) => provider.instanceId === selection.instanceId,
    )?.driver;
    const same = capabilities.providers.find(
      (provider) => provider.driverKind === driver && provider.canRunChildTask,
    );
    if (same !== undefined)
      return { ...selection, instanceId: same.providerInstanceId as ProviderInstanceId };
    return yield* invalid(
      `No ${driver ?? selection.instanceId} agent on "${link.label}" can start a thread. Its agents: ${capabilities.providers.map((provider) => `${provider.displayName ?? provider.driverKind} (${provider.providerInstanceId})`).join(", ") || "none"}. Pass a modelSelection from there, or pick another computer.`,
    );
  });

  /** The project there with this PM's repository; cloned first when the user agreed (`cloneTo`). */
  const projectThere = Effect.fn("PmRemote.projectThere")(function* (
    scope: ThreadScope,
    pmThreadId: string,
    link: OrchestratorMcpEnvironmentLink,
    cloneTo: string | undefined,
  ) {
    const here = yield* pmProject(pmThreadId);
    if (here === null || here.identity === null)
      return yield* invalid(
        "This project has no git repository to match on another computer, so its workers run here.",
      );
    const found = yield* projectsThere(scope, link.environmentId, here.keys).pipe(
      Effect.mapError(unavailable),
    );
    if (found.length > 1)
      return yield* invalid(
        `Several projects on "${link.label}" have this repository: ${found.map((project) => `"${project.title}"`).join(", ")}. Ask the user which one, then link a thread there with pm_worker_link, or start the worker here.`,
      );
    if (found[0] !== undefined) return found[0].id;
    if (cloneTo === undefined)
      return yield* invalid(
        `"${link.label}" has no copy of this repository. Ask the user with pm_ask whether to clone it there and to which folder (an absolute path on that computer; here it is ${here.project.workspaceRoot}). Once they agree, call pm_worker_start again with clone_to set to that folder.`,
      );
    if (link.access !== "full-access")
      return yield* invalid(
        `Cloning onto "${link.label}" needs a full-access link; it was linked with ${link.access} access. Ask the user to clone it there themselves (and add it as a project), or to link it again with full access.`,
      );
    const remoteUrl = here.identity.origin?.remoteUrl ?? here.identity.locator.remoteUrl;
    const cloned = yield* forwarding
      .call(scope, ProjectToolkit.tools.t3_project_clone, link.environmentId, {
        remoteUrl,
        destinationPath: cloneTo,
      })
      .pipe(Effect.mapError(unavailable));
    const created = yield* forwarding
      .call(scope, ProjectToolkit.tools.t3_project_create, link.environmentId, {
        title: here.project.title,
        workspaceRoot: cloned.cwd,
      })
      .pipe(Effect.mapError(unavailable));
    return created.id;
  });

  const following = new Set<string>();

  /** `pm_worker_start`, here or on a linked computer. */
  const startWorker = Effect.fn("PmRemote.startWorker")(function* (
    scope: ThreadScope,
    pmThreadId: string,
    input: StartWorkerInput & {
      readonly computerName?: string | undefined;
      readonly cloneTo?: string | undefined;
    },
  ) {
    const { computerName, cloneTo, ...rest } = input;
    if (computerName === undefined) return yield* pm.startWorker(pmThreadId, rest);
    const picked = yield* pick(scope, computerName);
    if (picked.here) return yield* pm.startWorker(pmThreadId, rest);
    const { link } = picked;
    const workspace = rest.workspaceStrategy;
    if (workspace !== undefined && workspace.type !== "root" && link.access !== "full-access")
      return yield* invalid(
        `A worktree on "${link.label}" needs a full-access link; it was linked with ${link.access} access. Omit workspaceStrategy to work in that project's checkout there.`,
      );
    const pmShell = yield* pmShellOf(pmThreadId);
    if (pmShell === null) return yield* invalid(`Thread ${pmThreadId} is gone.`);
    const projectId = yield* projectThere(scope, pmThreadId, link, cloneTo);
    const modelSelection = yield* modelThere(
      scope,
      link,
      rest.modelSelection ?? pmShell.modelSelection,
    );
    // Above the link's access, leave the mode out: the other side caps it to what the link allows.
    const runtimeMode: RuntimeMode | undefined =
      runtimeModeRank(rest.runtimeMode) <= runtimeModeRank(link.access as RuntimeMode)
        ? rest.runtimeMode
        : undefined;
    const result = yield* pm.startWorker(pmThreadId, {
      ...rest,
      computer: {
        environmentId: link.environmentId,
        label: link.label,
        launch: ({ key, title, text }) =>
          forwarding
            .call(scope, ProjectToolkit.tools.t3_thread_launch, link.environmentId, {
              projectId,
              title,
              modelSelection,
              ...(runtimeMode === undefined ? {} : { runtimeMode }),
              interactionMode: rest.interactionMode,
              ...(workspace === undefined ? {} : { workspaceStrategy: workspace }),
              message: text,
              clientRequestId: `pm-worker:${pmThreadId}:${key}`,
              // The thread there names this PM, with a way back to it.
              delegatedFrom: {
                environmentId: hereId,
                threadId: ThreadId.make(pmThreadId),
                title: pmShell.title,
              },
            })
            .pipe(
              Effect.map((launched) => ({ threadId: launched.threadId as string })),
              Effect.mapError(
                (error) =>
                  new PmError({
                    code: "unavailable",
                    message: `The worker did not start on "${link.label}": ${error.message}`,
                  }),
              ),
            ),
      },
    });
    return result;
  });

  /** `pm_worker_link`, here or for a thread on a linked computer. */
  const linkWorker = Effect.fn("PmRemote.linkWorker")(function* (
    scope: ThreadScope,
    pmThreadId: string,
    input: {
      readonly thread: string;
      readonly item?: string | number | undefined;
      readonly computerName?: string | undefined;
    },
  ) {
    const { computerName, ...rest } = input;
    if (computerName === undefined) return yield* pm.linkWorker(pmThreadId, rest);
    const picked = yield* pick(scope, computerName);
    if (picked.here) return yield* pm.linkWorker(pmThreadId, rest);
    const { link } = picked;
    const read = yield* forwarding
      .readThread(scope, link.environmentId, {
        threadId: ThreadId.make(rest.thread),
        limit: 1,
        runLimit: 1,
        maxCharsPerItem: 100,
      })
      .pipe(Effect.mapError(unavailable));
    const here = yield* pmProject(pmThreadId);
    const sameRepo = yield* projectsThere(scope, link.environmentId, here?.keys ?? []).pipe(
      Effect.mapError(unavailable),
    );
    if (!sameRepo.some((project) => project.id === read.thread.projectId))
      return yield* invalid(
        `Thread ${rest.thread} on "${link.label}" is in a project without this repository.`,
      );
    const latest = read.recentRuns.find((run) => run.runId === read.thread.latestRunId);
    const result = yield* pm.linkRemoteWorker(pmThreadId, {
      thread: rest.thread,
      title: read.thread.title,
      // Its last turn ended before it was adopted: that one is not news.
      skipRunId: latest !== undefined && TERMINAL.has(latest.status) ? latest.runId : undefined,
      item: rest.item,
      environmentId: link.environmentId,
      label: link.label,
    });
    return result;
  });

  const followScope = (
    pmThreadId: string,
    providerInstanceId: ProviderInstanceId,
  ): ThreadScope => ({
    environmentId: hereId,
    requestNamespace: `pm-remote:${pmThreadId}`,
    thread: {
      threadId: ThreadId.make(pmThreadId),
      providerSessionId: `pm-remote:${pmThreadId}`,
      providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  const report = Effect.fn("PmRemote.report")(function* (input: {
    readonly worker: PmWorkerRow;
    readonly title: string;
    readonly kind: "finished" | "waiting" | "quiet" | "stopped";
    readonly dedupeKey: string;
    readonly body: string;
    readonly line: string;
  }) {
    const label = input.worker.environmentLabel ?? input.worker.environmentId ?? "";
    return yield* pm
      .deliverReport({
        pmThreadId: input.worker.pmThreadId,
        workerThreadId: input.worker.workerThreadId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        line: input.line,
        summary: `Report from ${input.title} (on ${label}): ${REPORT_LABELS[input.kind]}`,
        text: reportMessage({
          kind: input.kind,
          workerTitle: input.title,
          workerThreadId: input.worker.workerThreadId,
          body: `It runs on "${label}" (environmentId ${input.worker.environmentId}: pass it to t3_thread_read, t3_thread_send and t3_thread_interrupt).\n\n${input.body}`,
        }),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("PM remote report delivery failed", { kind: input.kind, error }).pipe(
            Effect.as(false),
          ),
        ),
      );
  });

  const writeRemote = Effect.fn("PmRemote.writeRemote")(function* (
    worker: PmWorkerRow,
    remote: PmRemoteWatch,
    extra: Partial<PmWorkerRow["watch"]> = {},
  ) {
    const before = worker.watch.remote ?? {};
    yield* store.updateWatch(worker.workerThreadId, { ...worker.watch, ...extra, remote });
    if (
      before.status !== remote.status ||
      before.pendingRequests !== remote.pendingRequests ||
      before.unreachableSince !== remote.unreachableSince ||
      before.lostReason !== remote.lostReason ||
      before.title !== remote.title
    )
      yield* pm.changed(worker.pmThreadId);
  });

  const newestActivity = (read: OrchestratorMcpThreadReadResult) =>
    Math.max(
      isoMillis(read.thread.updatedAt),
      ...read.items.map((item) => isoMillis(item.updatedAt)),
    );

  type Step = "done" | "again" | "idle";

  /** One look at a worker there: record it, report what changed, and wait while it runs. */
  const look = Effect.fn("PmRemote.look")(function* (workerThreadId: string) {
    const worker = yield* store.getWorker(workerThreadId).pipe(Effect.orElseSucceed(() => null));
    if (
      worker === null ||
      worker.resolvedAt !== null ||
      worker.environmentId === null ||
      worker.watch.remote?.lostReason !== undefined
    )
      return "done" satisfies Step;
    // Off, archived or gone: stop; turning PMs on or unarchiving starts it again.
    if (!(yield* pm.isEnabled)) return "done" satisfies Step;
    const pmShell = yield* pmShellOf(worker.pmThreadId);
    if (pmShell === null || pmShell.archivedAt !== null) return "done" satisfies Step;
    const environmentId = EnvironmentId.make(worker.environmentId);
    const scope = followScope(worker.pmThreadId, pmShell.modelSelection.instanceId);
    const read = yield* forwarding
      .readThread(scope, environmentId, {
        threadId: ThreadId.make(worker.workerThreadId),
        view: "messages",
        limit: 20,
        runLimit: 3,
        maxCharsPerItem: 12_000,
      })
      .pipe(
        Effect.tapError((error) => (isFinal(error) ? lost(worker, error) : unreachable(worker))),
      );
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const before = worker.watch.remote ?? {};
    const runId = read.thread.latestRunId;
    const run = read.recentRuns.find((candidate) => candidate.runId === runId);
    const pending = read.thread.pendingRequestCount;
    const activity = newestActivity(read);
    const title = read.thread.title;
    const remote: PmRemoteWatch = {
      ...(before.skipRunId === undefined ? {} : { skipRunId: before.skipRunId }),
      title,
      status: run?.status ?? read.thread.status,
      runId,
      pendingRequests: pending,
      activityAt: DateTime.formatIso(DateTime.makeUnsafe(activity)),
    };
    const label = worker.environmentLabel ?? worker.environmentId;

    if (pending > 0 && (before.pendingRequests ?? 0) === 0 && RUNNING.has(remote.status ?? "")) {
      yield* writeRemote(worker, remote);
      yield* report({
        worker,
        title,
        kind: "waiting",
        dedupeKey: `waiting:${runId}:${read.thread.updatedAt}`,
        body: `It waits for an answer. A question it asks you may answer with t3_pending_request (with this environmentId) only when it is settled; bring the rest to the user. Approvals can only be answered on "${label}": tell the user to open the thread there. Never approve for the user.`,
        line: `Waiting for an answer on ${label}`,
      });
      return "again" satisfies Step;
    }

    if (
      run !== undefined &&
      TERMINAL.has(run.status) &&
      // By run, not time: the other computer's clock may differ from this one's.
      run.runId !== before.skipRunId
    ) {
      yield* writeRemote(worker, remote);
      if (run.status === "completed") {
        const reply = read.items.findLast(
          (item) => item.type === "assistant_message" && item.runId === run.runId,
        );
        const text = reply?.text ?? "";
        yield* report({
          worker,
          title,
          kind: "finished",
          dedupeKey: `run:${run.runId}`,
          body:
            text.trim().length === 0
              ? "It finished its turn without a final message. Read it with t3_thread_read."
              : `Its final message:\n\n${cutReportText(text)}${reply?.textTruncated === true ? "\n\n[Longer there. Read the rest with t3_thread_read.]" : ""}`,
          line: `Finished on ${label}: ${firstLine(text) || "no final message"}`,
        });
      } else {
        yield* report({
          worker,
          title,
          kind: "stopped",
          dedupeKey: `run:${run.runId}`,
          body: `Its turn stopped before it ended (${run.status}). It is not finished: read it with t3_thread_read and heal it.`,
          line: `Stopped mid-turn on ${label} (${run.status})`,
        });
      }
      return "idle" satisfies Step;
    }

    if (run !== undefined && RUNNING.has(run.status)) {
      const round = Math.floor((nowMs - activity) / QUIET_AFTER_MS);
      const watch = worker.watch;
      if (round >= 1 && !(watch.quietRunId === run.runId && (watch.quietRound ?? 0) >= round)) {
        const nudge = watch.nudgedRunId !== run.runId;
        if (nudge)
          yield* forwarding
            .call(scope, RemoteThreadSendTool, environmentId, {
              threadId: ThreadId.make(worker.workerThreadId),
              message: QUIET_NUDGE,
              mode: "queue",
              clientRequestId: `pm-quiet-nudge:${run.runId}`,
            })
            .pipe(Effect.ignore);
        yield* writeRemote(worker, remote, {
          quietRunId: run.runId,
          quietRound: round,
          nudgedRunId: run.runId,
        });
        yield* report({
          worker,
          title,
          kind: "quiet",
          dedupeKey: `quiet:${run.runId}:${round}`,
          body: nudge
            ? "No new output for 8 minutes while its turn runs. PM3code nudged it once. Read it with t3_thread_read: a build whose output still comes is not stuck."
            : `Still no new output (${round * 8} minutes), even after PM3code nudged it. Not nudged again: heal it if it hung.`,
          line: `Quiet for ${round * 8} min on ${label}`,
        });
      } else yield* writeRemote(worker, remote);
      // Returns as soon as the run ends there, so the finished report goes out at once.
      yield* forwarding.waitForThread(scope, environmentId, {
        threadId: ThreadId.make(worker.workerThreadId),
        runId: run.runId,
        timeoutMs: FOLLOW_WAIT_MS,
      });
      return "again" satisfies Step;
    }
    yield* writeRemote(worker, remote);
    return "idle" satisfies Step;
  });

  /** Not answering: shown on the worker until it answers again. Reports wait; nothing is judged. */
  const unreachable = Effect.fn("PmRemote.unreachable")(
    function* (worker: PmWorkerRow) {
      const fresh = yield* store.getWorker(worker.workerThreadId);
      if (fresh === null || fresh.watch.remote?.unreachableSince !== undefined) return;
      yield* writeRemote(fresh, {
        ...fresh.watch.remote,
        unreachableSince: DateTime.formatIso(yield* DateTime.now),
      });
    },
    (effect) => Effect.ignore(effect),
  );

  /** The link is gone or the thread is gone there: told once, then no longer followed. */
  const lost = Effect.fn("PmRemote.lost")(
    function* (worker: PmWorkerRow, error: OrchestratorMcpFailure) {
      const fresh = yield* store.getWorker(worker.workerThreadId);
      if (fresh === null) return;
      const label = fresh.environmentLabel ?? fresh.environmentId ?? "";
      const reason = `its thread is gone on "${label}"`;
      yield* writeRemote(fresh, { ...fresh.watch.remote, lostReason: reason });
      yield* report({
        worker: fresh,
        title: fresh.watch.remote?.title ?? fresh.workerThreadId,
        kind: "stopped",
        dedupeKey: "lost",
        body: `PM3code lost it: ${reason} (${error.message}). Tell the user, and resolve this worker with pm_worker_resolve once its work is taken or redone.`,
        line: `Lost contact: ${reason}`,
      });
    },
    (effect) => Effect.ignore(effect),
  );

  const idleLook = yield* PmRemoteIdleLook;

  /** Follows one worker until it is resolved, lost, or its PM stops; backs off while it can't be reached. */
  const follow = Effect.fn("PmRemote.follow")(
    function* (workerThreadId: string) {
      let failures = 0;
      while (true) {
        const step = yield* Effect.result(
          look(workerThreadId).pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("PM remote follower failed", { workerThreadId, defect }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new OrchestratorMcpFailure({ code: "orchestration_error", message: "defect" }),
                  ),
                ),
              ),
            ),
          ),
        );
        if (Result.isSuccess(step)) {
          failures = 0;
          if (step.success === "done") return;
          if (step.success === "idle") yield* Effect.sleep(idleLook);
          continue;
        }
        const error = step.failure;
        if (isMcpFailure(error) && isFinal(error)) return;
        failures += 1;
        yield* Effect.sleep(Duration.millis(backoffMs(failures)));
      }
    },
    (effect, workerThreadId) =>
      effect.pipe(
        Effect.ensuring(Effect.sync(() => following.delete(workerThreadId))),
        Effect.catchCause((cause) => Effect.logWarning("PM remote follower stopped", { cause })),
      ),
  );

  /** Starts a follower for every worker on another computer that has none. Cheap: one query. */
  const ensureFollowers: Effect.Effect<void> = Effect.gen(function* () {
    if (!(yield* pm.isEnabled)) return;
    const workers = yield* store.listWorkers().pipe(Effect.orElseSucceed(() => []));
    for (const worker of workers) {
      if (
        worker.environmentId === null ||
        worker.resolvedAt !== null ||
        worker.watch.remote?.lostReason !== undefined ||
        following.has(worker.workerThreadId)
      )
        continue;
      following.add(worker.workerThreadId);
      yield* follow(worker.workerThreadId).pipe(Effect.forkIn(followers));
    }
  });

  const start = Effect.fn("PmRemote.start")(function* () {
    yield* forkParked(ensureFollowers);
    // Turning PMs back on, unarchiving a PM, or a new worker: followers it now needs.
    yield* forkParked(
      Stream.runForEach(pm.changes.pipe(Stream.debounce("1 second")), () => ensureFollowers),
    );
  });

  return {
    computers,
    hostStatus,
    /** One look at a worker there, as the follower takes it; tests drive it step by step. */
    followStep: look,
    startWorker,
    linkWorker,
    ensureFollowers,
    start,
  };
});

export class PmRemote extends Context.Service<PmRemote, Effect.Success<typeof make>>()(
  "t3/pm/PmRemote",
) {}

export const layer = Layer.effect(PmRemote, make);
