import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import type { ModelFamily, ProviderSnapshot, Role, SkillEntry } from "@t3tools/pipelines";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { expandSwarmCommandText } from "../orchestration-v2/ContextHandoffDelivery.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PipelineService from "../pipelines/PipelineService.ts";
import {
  layerFakes,
  makeWorld,
  messagesTo,
  PROJECT,
  shellFor,
  type PmWorld,
} from "../pm/Pm.testkit.ts";
import * as SwarmMcpHandlers from "./SwarmMcpHandlers.ts";
import { SwarmToolkit } from "./SwarmMcpTools.ts";
import * as SwarmService from "./SwarmService.ts";
import * as SwarmStore from "./SwarmStore.ts";

const effort = (id: string) => ({ id, choices: ["low", "medium", "high", "xhigh"] });
const PROVIDERS: ReadonlyArray<ProviderSnapshot> = [
  {
    instanceId: "antigravity",
    driver: "antigravity",
    enabled: true,
    models: [
      { slug: "gemini-4-neon", name: "Gemini 4 Neon", reasoning: effort("thinkingLevel") },
      { slug: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", reasoning: effort("thinkingLevel") },
    ],
  },
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    models: [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: effort("effort") },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: effort("effort") },
    ],
  },
];

const scopeFor = (world: PmWorld, threadId: string) => {
  const shell = world.shells.get(threadId);
  return {
    environmentId: EnvironmentId.make("environment:swarm"),
    requestNamespace: `provider:${threadId}`,
    thread: {
      threadId: ThreadId.make(threadId),
      providerSessionId: `provider:${threadId}`,
      providerInstanceId: shell?.providerInstanceId ?? ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  };
};

type ToolName = keyof typeof SwarmToolkit.tools;

const harness = (
  world: PmWorld,
  pipelineOptions?: {
    readonly providers?: ReadonlyArray<ProviderSnapshot>;
    readonly limitedProviders?: ReadonlyMap<string, string>;
    readonly onResolveHarness?: (input: {
      readonly role: Role;
      readonly modelFamily: ModelFamily | null | undefined;
      readonly skillCatalog: ReadonlyMap<string, SkillEntry> | undefined;
    }) => void;
  },
) => {
  const swarmLayer = SwarmService.layer.pipe(Layer.provideMerge(SwarmStore.layer));
  const basePipelineLayer = PipelineService.layerTest({
    providers: pipelineOptions?.providers ?? PROVIDERS,
    ...(pipelineOptions?.limitedProviders
      ? { limitedProviders: pipelineOptions.limitedProviders }
      : {}),
  });
  const pipelineLayer =
    pipelineOptions?.onResolveHarness === undefined
      ? basePipelineLayer
      : Layer.effect(
          PipelineService.PipelineService,
          Effect.gen(function* () {
            const base = yield* PipelineService.PipelineService;
            return {
              ...base,
              resolveHarness: (role, root, options) => {
                pipelineOptions.onResolveHarness?.({
                  role,
                  modelFamily: options?.modelFamily,
                  skillCatalog: options?.skillCatalog,
                });
                const family = options?.modelFamily ?? null;
                const matched = [...(options?.skillCatalog?.values() ?? [])]
                  .filter(
                    (skill) =>
                      skill.roles.includes(role.name) &&
                      (family === null || skill.families.includes(family)),
                  )
                  .map((skill) => skill.name);
                return Effect.succeed({
                  modelFamily: family,
                  matchedSkills: matched,
                  skills: matched.map((name) => ({
                    name,
                    content: `Injected ${name} for ${family ?? "generic"}`,
                  })),
                });
              },
            };
          }),
        ).pipe(Layer.provide(basePipelineLayer));
  return McpToolAccess.HandlersLayer.layer(SwarmMcpHandlers.layer).pipe(
    Layer.provideMerge(swarmLayer),
    Layer.provideMerge(layerFakes(world)),
    Layer.provideMerge(pipelineLayer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
};

const callAs = Effect.fn("swarmTest.callAs")(function* (
  world: PmWorld,
  threadId: string,
  name: ToolName,
  params: Record<string, unknown>,
) {
  const toolkit = yield* SwarmToolkit;
  const parts = yield* toolkit
    .handle(name as never, params as never)
    .pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(world, threadId)),
    );
  return parts.at(-1)?.result as unknown as {
    result?: string;
    seq?: number;
    headSeq?: number;
    code?: string;
    message?: string;
  };
});

describe("Swarm mode MCP toolkit & service", () => {
  it.effect(
    "spawns sharded/worktree workers, wakes parked peers on @mention, supports channels, kill, and user posts",
    () => {
      const world = makeWorld();
      const coordId = ThreadId.make("thread:coord-1");
      world.shells.set(
        coordId,
        shellFor(coordId, {
          projectId: ProjectId.make(PROJECT),
          title: "Refactor auth",
          status: "running",
          activeRunId: RunId.make("run:coord-1"),
        }),
      );

      const markWorkerRunning = (threadId: string) => {
        const shell = world.shells.get(threadId)!;
        const matched = world.launches.find((launch) => launch.threadId === threadId);
        world.shells.set(threadId, {
          ...shell,
          providerInstanceId:
            matched?.modelSelection && "instanceId" in matched.modelSelection
              ? matched.modelSelection.instanceId
              : shell.providerInstanceId,
          status: "running",
          activeRunId: RunId.make(`run:${threadId}`),
        });
      };

      return Effect.gen(function* () {
        const titled = yield* callAs(world, coordId, "swarm", {
          action: "title",
          title: "Auth Swarm",
        });
        expect(titled.result).toContain("Auth Swarm");

        const models = yield* callAs(world, coordId, "swarm", { action: "models" });
        expect(models.result).toContain("gemini-4-neon");
        expect(models.result).toContain("claude-opus-5-5");

        // Spawn a single worktree writer and two sharded readers
        const addWriter = yield* callAs(world, coordId, "swarm", {
          action: "add",
          name: "writer",
          role: "builder",
          workspace: "worktree",
          brief: "Implement token validation",
        });
        expect(addWriter.result).toContain("@writer");
        expect(addWriter.result).toContain("workspace=worktree");

        const writerLaunch = world.launches.at(-1)!;
        expect(writerLaunch.workspaceStrategy).toEqual({
          type: "worktree",
          baseRef: "main",
        });

        const addScanners = yield* callAs(world, coordId, "swarm", {
          action: "add",
          name: "scan",
          role: "verifier",
          workspace: "inherit",
          tasks: ["packages/auth", "apps/server"],
          brief: "Audit module:",
        });
        expect(addScanners.result).toContain("@scan-1");
        expect(addScanners.result).toContain("@scan-2");

        const boardAfterAdd = yield* (yield* SwarmService.SwarmService).getBoardForThread(coordId);
        expect(boardAfterAdd?.members.map((m) => m.name).toSorted()).toEqual([
          "scan-1",
          "scan-2",
          "writer",
        ]);

        const writerThreadId = boardAfterAdd!.members.find((m) => m.name === "writer")!.threadId;
        const scan1ThreadId = boardAfterAdd!.members.find((m) => m.name === "scan-1")!.threadId;
        markWorkerRunning(writerThreadId);
        markWorkerRunning(scan1ThreadId);

        // Writer parks at zero cost on the board
        const parked = yield* callAs(world, writerThreadId, "swarm_wait", { mentions_only: true });
        expect(parked.result).toContain("Parked @writer");

        // scan-1 posts a #done message mentioning @writer and @coordinator -> wakes both!
        const posted = yield* callAs(world, scan1ThreadId, "post_message", {
          text: "@writer @coordinator [done] Found token bug in #1",
        });
        expect(posted.seq).toBeGreaterThan(0);

        expect(messagesTo(world, writerThreadId).at(-1)?.text).toContain("Found token bug");
        expect(messagesTo(world, coordId).at(-1)?.text).toContain("Found token bug");

        // Create & subscribe a channel
        const ch = yield* callAs(world, coordId, "swarm", {
          action: "channel",
          op: "create",
          channel: "reviews",
          topic: "Code review findings",
        });
        expect(ch.result).toContain("#reviews");
        yield* callAs(world, scan1ThreadId, "swarm", {
          action: "channel",
          op: "subscribe",
          channel: "reviews",
        });

        // User posts via UI endpoint to #reviews -> wakes scan-1 via @#reviews
        const service = yield* SwarmService.SwarmService;
        const userPost = yield* service.postFromUser(
          coordId,
          "@#reviews Please verify edge cases",
          "reviews",
        );
        expect(userPost.channel).toBe("reviews");
        expect(messagesTo(world, scan1ThreadId).at(-1)?.text).toContain("verify edge cases");

        // Kill scan-2 and finish swarm
        const killed = yield* callAs(world, coordId, "swarm", { action: "kill", name: "scan-2" });
        expect(killed.result).toContain("Killed @scan-2");

        const readAll = yield* callAs(world, coordId, "read_board", { since: 0, channel: "*" });
        expect(readAll.result).toContain("Found token bug");

        const done = yield* callAs(world, coordId, "swarm", { action: "done" });
        expect(done.result).toContain("marked done");
      }).pipe(Effect.provide(harness(world)));
    },
  );

  it.effect(
    "binds a customizable pipeline, posts its blueprint to #main, and shows it in status",
    () => {
      const world = makeWorld();
      const coordId = ThreadId.make("thread:coord-pipe");
      world.shells.set(
        coordId,
        shellFor(coordId, {
          projectId: ProjectId.make(PROJECT),
          title: "",
          status: "running",
          activeRunId: RunId.make("run:coord-pipe"),
        }),
      );

      return Effect.gen(function* () {
        const bound = yield* callAs(world, coordId, "swarm", {
          action: "pipeline",
          pipeline: "feature",
          goal: "Ship OAuth login",
        });
        expect(bound.result).toContain('Bound pipeline "feature"');
        expect(bound.result).toContain("Stage checklist:");
        expect(bound.result).toContain("claude:");
        expect(bound.result).toContain("codex:");
        expect(bound.result).toContain("gemini:");

        const status = yield* callAs(world, coordId, "swarm", { action: "status" });
        expect(status.result).toContain("Pipeline: feature");
        expect(status.result).toContain("feature: Ship OAuth login");

        const board = yield* callAs(world, coordId, "read_board", { since: 0, channel: "main" });
        expect(board.result).toContain("Pipeline feature:");
        expect(board.result).toContain("Goal: Ship OAuth login");
      }).pipe(Effect.provide(harness(world)));
    },
  );

  it.effect(
    "hot-switches a worker model with automatic usage-limit failover and injects model-family skills on add",
    () => {
      const world = makeWorld();
      const coordId = ThreadId.make("thread:coord-model");
      world.shells.set(
        coordId,
        shellFor(coordId, {
          projectId: ProjectId.make(PROJECT),
          title: "UI Overhaul",
          status: "running",
          activeRunId: RunId.make("run:coord-model"),
        }),
      );

      const harnessCalls: Array<{
        readonly role: string;
        readonly modelFamily: ModelFamily | null | undefined;
        readonly catalogSize: number;
      }> = [];
      const limited = new Map<string, string>([["claudeAgent", "2026-12-01T00:00:00Z"]]);

      return Effect.gen(function* () {
        // claudeAgent is at its usage limit -> ui-builder routes to antigravity/gemini and gets gemini skills
        const added = yield* callAs(world, coordId, "swarm", {
          action: "add",
          name: "designer",
          role: "ui-builder",
          brief: "Polish the studio skills matrix",
        });
        expect(added.result).toContain("@designer");

        expect(harnessCalls).toHaveLength(1);
        expect(harnessCalls[0]?.role).toBe("ui-builder");
        expect(harnessCalls[0]?.modelFamily).toBe("gemini");
        expect(harnessCalls[0]?.catalogSize).toBeGreaterThan(0);

        const launch = world.launches.at(-1)!;
        expect(launch.initialMessage?.text).toContain("gemini-frontend-design");
        expect(launch.initialMessage?.text).toContain("gemini harness");

        // Now mark antigravity limited and un-limit claudeAgent via explicit failover test:
        // first verify explicit modelSelection hot-switch dispatches thread.model-selection.set
        const switchedExplicit = yield* callAs(world, coordId, "swarm", {
          action: "model",
          name: "designer",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-5-5",
          },
        });
        expect(switchedExplicit.result).toContain("claudeAgent/claude-sonnet-5-5");

        const setModelCommands = world.commands.filter(
          (cmd) => cmd.type === "thread.model-selection.set",
        );
        expect(setModelCommands).toHaveLength(1);
        expect(setModelCommands[0]?.modelSelection.instanceId).toBe("claudeAgent");
        expect(setModelCommands[0]?.modelSelection.model).toBe("claude-sonnet-5-5");

        // Auto-failover when modelSelection is omitted: claudeAgent is in `limited`, so it routes to antigravity
        const switchedAuto = yield* callAs(world, coordId, "swarm", {
          action: "model",
          name: "designer",
        });
        expect(switchedAuto.result).toContain("antigravity/");

        const allSetModelCommands = world.commands.filter(
          (cmd) => cmd.type === "thread.model-selection.set",
        );
        expect(allSetModelCommands).toHaveLength(2);
        expect(allSetModelCommands[1]?.modelSelection.instanceId).toBe("antigravity");

        const board = yield* (yield* SwarmService.SwarmService).getBoardForThread(coordId);
        const designerThreadId = board!.members.find((m) => m.name === "designer")!.threadId;
        expect(messagesTo(world, designerThreadId).at(-1)?.text).toContain("model switched to");
      }).pipe(
        Effect.provide(
          harness(world, {
            limitedProviders: limited,
            onResolveHarness: ({ role, modelFamily, skillCatalog }) => {
              harnessCalls.push({
                role: role.name,
                modelFamily,
                catalogSize: skillCatalog?.size ?? 0,
              });
            },
          }),
        ),
      );
    },
  );

  it("expands /swarm --pipeline <name> [goal] with pipeline and failover instructions", () => {
    const expanded = expandSwarmCommandText("/swarm --pipeline feature Build billing settings");
    expect(expanded).not.toBeNull();
    expect(expanded).toContain('swarm(action: "pipeline", pipeline: "feature"');
    expect(expanded).toContain('swarm(action: "model", name, escalate?)');
    expect(expanded).toContain("Build billing settings");
  });

  it.effect("expands /swarm --scorched-earth with loop-cap guidance and binds the pipeline", () => {
    const expanded = expandSwarmCommandText("/swarm --scorched-earth verify worker counts");
    expect(expanded).toContain("[Swarm Mode Coordinator Brief: Pipeline scorched-earth]");
    expect(expanded).toContain('swarm(action: "pipeline", pipeline: "scorched-earth"');
    expect(expanded).toContain("surface-inventory.json");
    expect(expanded).toContain("`empty`, `in-progress`, `completed`, `error/limited`");
    expect(expanded).toContain("cap Troubleshooter -> Fixer -> Playtester retries at 3 cycles");
    expect(expanded).toContain("verify worker counts");
    expect(expanded).not.toContain("—");
    // The long form carries the same rule; other pipelines do not.
    expect(expandSwarmCommandText("/swarm --pipeline scorched-earth verify worker counts")).toBe(
      expanded,
    );
    expect(expandSwarmCommandText("/swarm --pipeline feature x")).not.toContain(
      "surface-inventory.json",
    );

    const world = makeWorld();
    const coordId = ThreadId.make("thread:coord-scorched");
    world.shells.set(
      coordId,
      shellFor(coordId, {
        projectId: ProjectId.make(PROJECT),
        title: "",
        status: "running",
        activeRunId: RunId.make("run:coord-scorched"),
      }),
    );
    return Effect.gen(function* () {
      const bound = yield* callAs(world, coordId, "swarm", {
        action: "pipeline",
        pipeline: "scorched-earth",
        goal: "verify worker counts",
      });
      expect(bound.result).toContain('Bound pipeline "scorched-earth"');
      expect(bound.result).toContain("scenario-generator");
      expect(bound.result).toContain("playtester");
      expect(bound.result).toContain("troubleshooter");

      const status = yield* callAs(world, coordId, "swarm", { action: "status" });
      expect(status.result).toContain("Pipeline: scorched-earth");
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect(
    "forks warm context from an existing member and nudges stalled workers via checkStalls",
    () => {
      const world = makeWorld();
      const coordId = ThreadId.make("thread:coord-fork-stall");
      world.shells.set(
        coordId,
        shellFor(coordId, {
          projectId: ProjectId.make(PROJECT),
          title: "Fork & stall test",
          status: "running",
          activeRunId: RunId.make("run:coord-fork-stall"),
        }),
      );
      return Effect.gen(function* () {
        yield* callAs(world, coordId, "swarm", {
          action: "add",
          name: "scout",
          role: "researcher",
          brief: "Inspect the auth flow",
        });
        const boardBefore = yield* (yield* SwarmService.SwarmService).getBoardForThread(coordId);
        const scoutThreadId = boardBefore!.members.find((m) => m.name === "scout")!.threadId;

        // Seed scout's thread with an assistant finding so fork carries it forward
        world.messages.set(scoutThreadId, [
          { role: "assistant", text: "Root cause: token refresh races on reconnect." } as never,
        ]);

        const forked = yield* callAs(world, coordId, "swarm", {
          action: "add",
          name: "fixer",
          role: "builder",
          fork: "scout",
          brief: "Fix the token refresh race",
        });
        expect(forked.result).toContain("@fixer");
        const fixerLaunch = world.launches.at(-1)!;
        expect(fixerLaunch.initialMessage?.text).toContain("## Forked Context (from @scout)");
        expect(fixerLaunch.initialMessage?.text).toContain(
          "Root cause: token refresh races on reconnect.",
        );

        // Advance clock past the 8-minute stall threshold and run checkStalls
        const scoutShell = world.shells.get(scoutThreadId)!;
        world.shells.set(scoutThreadId, {
          ...scoutShell,
          updatedAt: yield* DateTime.now,
          activityRunStartedAt: null,
        });
        yield* TestClock.adjust("10 minutes");
        yield* (yield* SwarmService.SwarmService).checkStalls();

        const boardAfter = yield* (yield* SwarmService.SwarmService).getBoardForThread(coordId);
        const stallPost = boardAfter!.posts.find((p) => p.sender === "monitor");
        expect(stallPost?.text).toContain("@scout [stall]");
      }).pipe(Effect.provide(harness(world)));
    },
  );
});
