import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import type { ProviderSnapshot } from "@t3tools/pipelines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
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

const harness = (world: PmWorld) => {
  const swarmLayer = SwarmService.layer.pipe(Layer.provideMerge(SwarmStore.layer));
  return McpToolAccess.HandlersLayer.layer(SwarmMcpHandlers.layer).pipe(
    Layer.provideMerge(swarmLayer),
    Layer.provideMerge(layerFakes(world)),
    Layer.provideMerge(PipelineService.layerTest({ providers: PROVIDERS })),
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
});
