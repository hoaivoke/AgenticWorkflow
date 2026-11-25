import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestratorMcpEnvironmentLink,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadResult,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { layerPm, makeWorld, messagesTo, PROJECT, type PmWorld } from "./Pm.testkit.ts";
import * as PmRemote from "./PmRemote.ts";
import { PmService } from "./PmService.ts";
import { PmStore } from "./PmStore.ts";
import { QUIET_NUDGE } from "./PmText.ts";

const HERE = EnvironmentId.make("env-here");
const MINI = EnvironmentId.make("env-mac-mini");
const GB = 1024 ** 3;
const KEY = "github.com/acme/app";

/** The linked computers, faked at the link: what each answers, and every call made over it. */
interface Far {
  links: Array<OrchestratorMcpEnvironmentLink>;
  linksOff: boolean;
  projects: Map<string, Array<{ id: string; title: string; key: string }>>;
  hostStatus: Set<string>;
  read: OrchestratorMcpThreadReadResult | OrchestratorMcpFailure;
  reads: number;
  onRead: ((count: number) => Effect.Effect<void>) | null;
  calls: Array<{ tool: string; environmentId: string; params: Record<string, unknown> }>;
}

const link = (
  label: string,
  overrides: Partial<OrchestratorMcpEnvironmentLink> = {},
): OrchestratorMcpEnvironmentLink => ({
  environmentId: EnvironmentId.make(`env-${label.toLowerCase().replaceAll(" ", "-")}`),
  label,
  status: "reachable",
  access: "auto",
  expiresAt: "2026-12-26T00:00:00.000Z",
  lastError: null,
  ...overrides,
});

const makeFar = (): Far => ({
  links: [link("Mac mini")],
  linksOff: false,
  projects: new Map([[MINI, [{ id: "project-there", title: "app", key: KEY }]]]),
  hostStatus: new Set([MINI]),
  read: new OrchestratorMcpFailure({ code: "orchestration_error", message: "not set" }),
  reads: 0,
  onRead: null,
  calls: [],
});

const readResult = (input: {
  readonly status: string;
  readonly runId?: string;
  readonly pending?: number;
  readonly reply?: string;
  readonly at?: string;
}): OrchestratorMcpThreadReadResult => {
  const at = input.at ?? "2026-01-01T00:00:00.000Z";
  const runId = input.runId ?? "run-1";
  return {
    thread: {
      threadId: ThreadId.make("far-thread-1"),
      projectId: "project-there",
      title: "Fix pairing",
      status: input.status,
      latestRunId: runId,
      activeRunId: null,
      pendingRequestCount: input.pending ?? 0,
      updatedAt: at,
    },
    recentRuns: [
      { runId, status: input.status, completedAt: input.status === "running" ? null : at },
    ],
    items:
      input.reply === undefined
        ? [{ type: "user_message", runId, text: "brief", textTruncated: false, updatedAt: at }]
        : [
            {
              type: "assistant_message",
              runId,
              text: input.reply,
              textTruncated: false,
              updatedAt: at,
            },
          ],
  } as never;
};

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const fail = (code: OrchestratorMcpFailure["code"], message: string = code) =>
  new OrchestratorMcpFailure({ code, message });

const layerFar = (far: Far) =>
  Layer.mergeAll(
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: ((
        _scope: unknown,
        tool: { readonly name: string },
        environmentId: string,
        params: Record<string, unknown>,
      ) =>
        Effect.suspend(() => {
          far.calls.push({ tool: tool.name, environmentId, params });
          switch (tool.name) {
            case "pm_host_status":
              return far.hostStatus.has(environmentId)
                ? Effect.succeed({
                    agents: [
                      {
                        instanceId: "codex",
                        name: "Codex",
                        ready: true,
                        windows: [{ kind: "session", label: "5 h", usedPercent: 8 }],
                      },
                    ],
                    load: {
                      cpu: 0.05,
                      freeMemoryBytes: 20 * GB,
                      totalMemoryBytes: 24 * GB,
                      runningThreads: 0,
                    },
                  })
                : Effect.fail(fail("invalid_request", "Unknown tool pm_host_status"));
            case "orchestrator_capabilities":
              return Effect.succeed({
                providers: [
                  {
                    providerInstanceId: "claudeAgent",
                    driverKind: "claudeAgent",
                    displayName: "Claude",
                    canRunChildTask: true,
                    constraints: [],
                  },
                  {
                    providerInstanceId: "codex",
                    driverKind: "codex",
                    displayName: "Codex",
                    canRunChildTask: true,
                    constraints: [],
                  },
                ],
              });
            case "t3_project_list":
              return Effect.succeed({
                projects: (far.projects.get(environmentId) ?? []).map((project) => ({
                  id: project.id,
                  title: project.title,
                  repositoryIdentity: { canonicalKey: project.key, locator: { remoteUrl: "x" } },
                })),
                nextCursor: null,
              });
            case "t3_project_clone":
              return Effect.succeed({ cwd: params.destinationPath, remoteUrl: params.remoteUrl });
            case "t3_project_create":
              far.projects.set(environmentId, [
                { id: "project-cloned", title: String(params.title), key: KEY },
              ]);
              return Effect.succeed({ id: "project-cloned", title: params.title });
            case "t3_thread_launch":
              return Effect.succeed({
                threadId: "far-thread-1",
                runId: "run-1",
                status: "running",
              });
            default:
              return Effect.succeed({});
          }
        })) as never,
      readThread: () =>
        Effect.suspend(() => {
          far.reads += 1;
          const read = far.read;
          return (far.onRead?.(far.reads) ?? Effect.void).pipe(
            Effect.andThen(isMcpFailure(read) ? Effect.fail(read) : Effect.succeed(read)),
          );
        }),
      waitForThread: () => Effect.succeed({} as never),
      links: () =>
        far.linksOff
          ? Effect.fail(PeerForwarding.linkedEnvironmentsOff)
          : Effect.sync(() => ({ environmentId: HERE, links: far.links, notListed: "" }) as never),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(HERE),
      getDescriptor: Effect.succeed({ label: "MacBook Pro" } as never),
    }),
    Layer.mock(HostResources.HostResources)({
      read: Effect.succeed({
        cpuUtilization: 0.95,
        cpuCount: 8,
        availableMemoryBytes: 9 * GB,
        totalMemoryBytes: 32 * GB,
      } as never),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated", email: "someone@example.com" },
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          message: "signed in as someone@example.com",
          usageLimits: { windows: [{ id: "w", kind: "session", label: "5 h", usedPercent: 100 }] },
        },
      ] as never),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({ id: PROJECT, title: "app", workspaceRoot: "/Users/me/app" } as never),
    }),
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () =>
        Effect.succeed({
          canonicalKey: KEY,
          locator: { remoteUrl: "git@github.com:acme/app.git" },
        } as never),
    }),
  );

/** One server lifetime over the shared database; call it again to restart. */
const serverStart = <A, E, R>(world: PmWorld, far: Far, effect: Effect.Effect<A, E, R>) =>
  Effect.provide(
    effect,
    PmRemote.layer.pipe(
      Layer.provideMerge(layerPm(world)),
      Layer.provide(layerFar(far)),
      Layer.provide(Layer.succeed(PmRemote.PmRemoteIdleLook, Duration.zero)),
    ),
  );

const scopeFor = (pm: string): PmRemote.ThreadScope => ({
  environmentId: HERE,
  requestNamespace: "test",
  thread: {
    threadId: ThreadId.make(pm),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const createPm = Effect.gen(function* () {
  const service = yield* PmService;
  const { threadId } = yield* service.create({
    projectId: PROJECT,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const startThere = (
  pm: string,
  overrides: Partial<Parameters<PmRemote.PmRemote["Service"]["startWorker"]>[2]> = {},
) =>
  Effect.flatMap(PmRemote.PmRemote, (remote) =>
    remote.startWorker(scopeFor(pm), pm, {
      computerName: "mac mini",
      title: "Fix pairing",
      brief: "Fix it.",
      runtimeMode: "full-access",
      interactionMode: "default",
      ...overrides,
    }),
  );

const step = Effect.flatMap(PmRemote.PmRemote, (remote) => remote.followStep("far-thread-1"));

const reportsTo = (world: PmWorld, pm: string) =>
  messagesTo(world, pm).filter((message) =>
    message.notification?.summary.startsWith("Report from"),
  );

const launches = (far: Far) => far.calls.filter((call) => call.tool === "t3_thread_launch");

const harness = SqlitePersistence.layerMemory;

describe("PmRemote", () => {
  it.effect("pm_computers lists this computer and each linked one, with numbers only", () => {
    const world = makeWorld();
    const far = makeFar();
    far.links = [
      link("Mac mini"),
      link("Old box"),
      link("vps", { status: "unreachable", lastError: "timeout" }),
    ];
    return serverStart(
      world,
      far,
      Effect.gen(function* () {
        const pm = yield* createPm;
        const remote = yield* PmRemote.PmRemote;
        const { result } = yield* remote.computers(scopeFor(pm), pm);
        expect(result).toContain('"MacBook Pro" (this computer, where you run)');
        expect(result).toContain("CPU 95%");
        expect(result).toContain("BUSY");
        expect(result).toContain("Codex: OUT OF USAGE");
        expect(result).toContain('"Mac mini" (linked, auto access, reachable)');
        expect(result).toContain("Codex: ready, 5 h 8%");
        expect(result).toContain('This repository there: project "app"');
        expect(result).toContain("T3 Code without PM3code");
        expect(result).toContain(
          "This repository there: none (ask the user before cloning it there)",
        );
        expect(result).toContain("Not answering now (timeout). Start nothing there.");
        // Provider messages and accounts never leave: only fixed words and numbers.
        const status = yield* remote.hostStatus;
        expect(JSON.stringify(status)).not.toContain("someone@example.com");

        far.linksOff = true;
        const off = yield* remote.computers(scopeFor(pm), pm);
        expect(off.result).toContain("Linked environments is off on this computer");
      }),
    ).pipe(Effect.provide(harness));
  });

  it.effect("starts a worker there through its link and lists it under the PM", () => {
    const world = makeWorld();
    const far = makeFar();
    return serverStart(
      world,
      far,
      Effect.gen(function* () {
        const pm = yield* createPm;
        const started = yield* startThere(pm);
        expect(started.result).toContain(
          'Started worker "Fix pairing" on "Mac mini" (thread far-thread-1 there)',
        );
        const launch = launches(far)[0]!;
        expect(launch.environmentId).toBe(MINI);
        expect(launch.params).toMatchObject({
          projectId: "project-there",
          title: "Fix pairing",
          delegatedFrom: { environmentId: HERE, threadId: pm },
        });
        // Above the link's access, the mode is left out so the other side caps it.
        expect(launch.params.runtimeMode).toBeUndefined();
        expect(String(launch.params.clientRequestId)).toMatch(new RegExp(`^pm-worker:${pm}:`));
        expect(String(launch.params.message)).toContain('You run on "Mac mini"');

        const summary = (yield* (yield* PmService).summaries()).pms.find(
          (entry) => entry.threadId === pm,
        );
        expect(summary?.workerThreadIds).toEqual([]);
        expect(summary?.remoteWorkers).toEqual([
          {
            threadId: "far-thread-1",
            title: "Fix pairing",
            state: "running",
            computer: {
              environmentId: MINI,
              label: "Mac mini",
              unreachableSince: null,
              lost: null,
            },
          },
        ]);

        yield* startThere(pm, { runtimeMode: "approval-required", title: "Second" });
        expect(launches(far)[1]!.params.runtimeMode).toBe("approval-required");
      }),
    ).pipe(Effect.provide(harness));
  });

  it.effect("refuses what the link does not allow, and starts nothing", () => {
    const world = makeWorld();
    const far = makeFar();
    far.links = [
      link("Mac mini"),
      link("Reader", { access: "read-only" }),
      link("vps", { status: "unreachable" }),
      link("laptop", { status: "expired" }),
    ];
    return serverStart(
      world,
      far,
      Effect.gen(function* () {
        const pm = yield* createPm;
        const refusal = (overrides: Parameters<typeof startThere>[1]) =>
          startThere(pm, overrides).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        expect(yield* refusal({ computerName: "reader" })).toContain("read-only access");
        expect(yield* refusal({ computerName: "vps" })).toContain("is not answering now");
        expect(yield* refusal({ computerName: "laptop" })).toContain("expired");
        expect(yield* refusal({ computerName: "Windows box" })).toContain(
          'No computer named "Windows box"',
        );
        expect(
          yield* refusal({ workspaceStrategy: { type: "worktree", baseRef: "main" } as never }),
        ).toContain("needs a full-access link");
        assert.lengthOf(launches(far), 0);
        const store = yield* PmStore;
        assert.lengthOf(yield* store.listWorkers(pm), 0);
      }),
    ).pipe(Effect.provide(harness));
  });

  it.effect(
    "asks before cloning; clones and adds the project only with clone_to and full access",
    () => {
      const world = makeWorld();
      const far = makeFar();
      far.projects = new Map();
      return serverStart(
        world,
        far,
        Effect.gen(function* () {
          const pm = yield* createPm;
          const ask = yield* startThere(pm).pipe(Effect.flip);
          expect(ask.message).toContain(
            '"Mac mini" has no copy of this repository. Ask the user with pm_ask',
          );
          expect(ask.message).toContain("here it is /Users/me/app");
          const limited = yield* startThere(pm, { cloneTo: "/Users/me/app" }).pipe(Effect.flip);
          expect(limited.message).toContain('Cloning onto "Mac mini" needs a full-access link');
          assert.lengthOf(
            far.calls.filter((call) => call.tool === "t3_project_clone"),
            0,
          );

          far.links = [link("Mac mini", { access: "full-access" })];
          yield* startThere(pm, { cloneTo: "/Users/me/app" });
          expect(far.calls.find((call) => call.tool === "t3_project_clone")?.params).toEqual({
            remoteUrl: "git@github.com:acme/app.git",
            destinationPath: "/Users/me/app",
          });
          expect(far.calls.find((call) => call.tool === "t3_project_create")?.params).toEqual({
            title: "app",
            workspaceRoot: "/Users/me/app",
          });
          expect(launches(far)[0]!.params).toMatchObject({
            projectId: "project-cloned",
            runtimeMode: "full-access",
          });
        }),
      ).pipe(Effect.provide(harness));
    },
  );

  it.effect("reports a finished run once, not again on another look or after a restart", () => {
    const world = makeWorld();
    const far = makeFar();
    return Effect.gen(function* () {
      const pm = yield* serverStart(
        world,
        far,
        Effect.gen(function* () {
          const pm = yield* createPm;
          yield* startThere(pm);
          far.read = readResult({ status: "completed", reply: "Pushed fix/pairing." });
          expect(yield* step).toBe("idle");
          expect(yield* step).toBe("idle");
          return pm;
        }),
      );
      yield* serverStart(world, far, step);
      const sent = reportsTo(world, pm);
      assert.lengthOf(sent, 1);
      expect(sent[0]).toMatchObject({
        linkedSender: { environmentId: MINI, threadId: "far-thread-1", title: "Fix pairing" },
        notification: { summary: "Report from Fix pairing (on Mac mini): Finished" },
      });
      expect(sent[0]!.text).toContain('It runs on "Mac mini" (environmentId env-mac-mini');
      expect(sent[0]!.text).toContain("Its final message:\n\nPushed fix/pairing.");
    }).pipe(Effect.provide(harness));
  });

  it.effect("shows an unreachable computer on the worker, then catches up once it answers", () => {
    const world = makeWorld();
    const far = makeFar();
    return serverStart(
      world,
      far,
      Effect.gen(function* () {
        const pm = yield* createPm;
        yield* startThere(pm);
        const service = yield* PmService;
        const computerOf = Effect.map(
          service.summaries(),
          (all) => all.pms.find((entry) => entry.threadId === pm)?.remoteWorkers?.[0]?.computer,
        );

        far.read = fail("orchestration_error", "The linked environment did not answer.");
        yield* Effect.flip(step);
        const down = yield* computerOf;
        expect(down?.unreachableSince).not.toBeNull();
        assert.lengthOf(reportsTo(world, pm), 0);

        // A refused link (Linked environments off, the link revoked) waits the same way.
        far.read = fail("capability_denied", "Linked environments is off on this machine.");
        yield* Effect.flip(step);
        expect((yield* computerOf)?.lost).toBeNull();
        expect((yield* computerOf)?.unreachableSince).toBe(down?.unreachableSince);

        far.read = readResult({ status: "completed", reply: "Done while you were away." });
        yield* step;
        expect((yield* computerOf)?.unreachableSince).toBeNull();
        const sent = reportsTo(world, pm);
        assert.lengthOf(sent, 1);
        expect(sent[0]!.text).toContain("Done while you were away.");
      }),
    ).pipe(Effect.provide(harness));
  });

  it.effect("reports waiting once, and says approvals are answered on that computer", () => {
    const world = makeWorld();
    const far = makeFar();
    return serverStart(
      world,
      far,
      Effect.gen(function* () {
        const pm = yield* createPm;
        yield* startThere(pm);
        far.read = readResult({ status: "waiting", pending: 1 });
        yield* step;
        yield* step;
        const sent = reportsTo(world, pm);
        assert.lengthOf(sent, 1);
        expect(sent[0]!.notification?.summary).toBe(
          "Report from Fix pairing (on Mac mini): Waiting for an answer",
        );
        expect(sent[0]!.text).toContain('Approvals can only be answered on "Mac mini"');

        // That computer restarted: the run ended there but still lists its old request.
        far.read = readResult({ status: "cancelled", pending: 1 });
        yield* step;
        assert.lengthOf(reportsTo(world, pm), 2);
        const summaries = yield* (yield* PmService).summaries();
        expect(
          summaries.pms.find((entry) => entry.threadId === pm)?.remoteWorkers?.[0]?.state,
        ).toBe("idle");
      }),
    ).pipe(Effect.provide(harness));
  });

  it.effect("nudges a quiet worker there once and reports each quiet round", () => {
    const world = makeWorld();
    const far = makeFar();
    return serverStart(
      world,
      far,
      Effect.gen(function* () {
        const pm = yield* createPm;
        yield* startThere(pm);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        far.read = readResult({
          status: "running",
          at: DateTime.formatIso(DateTime.makeUnsafe(now - 9 * 60_000)),
        });
        expect(yield* step).toBe("again");
        expect(yield* step).toBe("again");
        const nudges = far.calls.filter((call) => call.tool === "t3_thread_send");
        assert.lengthOf(nudges, 1);
        expect(nudges[0]!.params).toMatchObject({ message: QUIET_NUDGE, mode: "queue" });
        const sent = reportsTo(world, pm);
        assert.lengthOf(sent, 1);
        expect(sent[0]!.notification?.summary).toContain("Quiet for 8 min");

        // Sixteen minutes: told again, never nudged twice.
        far.read = readResult({
          status: "running",
          at: DateTime.formatIso(DateTime.makeUnsafe(now - 17 * 60_000)),
        });
        yield* step;
        assert.lengthOf(
          far.calls.filter((call) => call.tool === "t3_thread_send"),
          1,
        );
        const again = reportsTo(world, pm);
        assert.lengthOf(again, 2);
        expect(again[1]!.text).toContain("even after PM3code nudged it");
      }),
    ).pipe(Effect.provide(harness));
  });

  it.effect("a thread gone there: told once, then no longer followed", () => {
    const world = makeWorld();
    const far = makeFar();
    return serverStart(
      world,
      far,
      Effect.gen(function* () {
        const pm = yield* createPm;
        yield* startThere(pm);
        far.read = fail("thread_not_found", "No thread far-thread-1.");
        yield* Effect.flip(step);
        expect(yield* step).toBe("done");
        assert.strictEqual(far.reads, 1);
        const sent = reportsTo(world, pm);
        assert.lengthOf(sent, 1);
        expect(sent[0]!.text).toContain('its thread is gone on "Mac mini"');
        const summary = (yield* (yield* PmService).summaries()).pms.find(
          (entry) => entry.threadId === pm,
        );
        expect(summary?.remoteWorkers?.[0]?.computer.lost).toContain("its thread is gone");
      }),
    ).pipe(Effect.provide(harness));
  });

  it.effect("an adopted thread's turn that ended before is not news; its next one is", () => {
    const world = makeWorld();
    const far = makeFar();
    return serverStart(
      world,
      far,
      Effect.gen(function* () {
        const pm = yield* createPm;
        far.read = readResult({ status: "completed", reply: "Old news." });
        const remote = yield* PmRemote.PmRemote;
        yield* remote.linkWorker(scopeFor(pm), pm, {
          thread: "far-thread-1",
          computerName: "Mac mini",
        });
        yield* step;
        assert.lengthOf(reportsTo(world, pm), 0);
        far.read = readResult({ status: "completed", runId: "run-2", reply: "New work." });
        yield* step;
        const sent = reportsTo(world, pm);
        assert.lengthOf(sent, 1);
        expect(sent[0]!.text).toContain("New work.");
      }),
    ).pipe(Effect.provide(harness));
  });

  it.effect("after a restart the follower picks up its workers there by itself", () => {
    const world = makeWorld();
    const far = makeFar();
    return Effect.gen(function* () {
      const pm = yield* serverStart(
        world,
        far,
        Effect.gen(function* () {
          const pm = yield* createPm;
          yield* startThere(pm);
          return pm;
        }),
      );
      far.read = readResult({ status: "completed", reply: "Finished during the restart." });
      far.reads = 0;
      const secondLook = yield* Deferred.make<void>();
      far.onRead = (count) => (count === 2 ? Deferred.succeed(secondLook, undefined) : Effect.void);
      yield* serverStart(
        world,
        far,
        Effect.gen(function* () {
          const remote = yield* PmRemote.PmRemote;
          yield* remote.ensureFollowers;
          yield* Deferred.await(secondLook);
        }),
      );
      const sent = reportsTo(world, pm);
      assert.lengthOf(sent, 1);
      expect(sent[0]!.text).toContain("Finished during the restart.");
    }).pipe(Effect.provide(harness));
  });
});
