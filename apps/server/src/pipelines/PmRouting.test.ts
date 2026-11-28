// pipelines: role routing through the real pm_* tools, over the PM test kit's fakes.
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestratorMcpScheduleTaskInput,
} from "@t3tools/contracts";
import type { ProviderSnapshot } from "@t3tools/pipelines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerPm, layerPmRemoteHere, makeWorld, PROJECT, type PmWorld } from "../pm/Pm.testkit.ts";
import * as PmMcpHandlers from "../pm/PmMcpHandlers.ts";
import { PmToolkit } from "../pm/PmMcpTools.ts";
import { PmService } from "../pm/PmService.ts";
import * as PipelineService from "./PipelineService.ts";

const effort = (id: string) => ({ id, choices: ["low", "medium", "high", "xhigh"] });
const PROVIDERS: ReadonlyArray<ProviderSnapshot> = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    models: [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: effort("effort") },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: effort("effort") },
      { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: effort("effort") },
    ],
  },
  {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    models: [
      { slug: "gpt-6.2-astra", name: "GPT-6.2 Astra", reasoning: effort("reasoningEffort") },
      { slug: "gpt-6.2-sol", name: "GPT-6.2 Sol", reasoning: effort("reasoningEffort") },
    ],
  },
];

const scopeFor = (threadId: string) => ({
  environmentId: EnvironmentId.make("environment:pm"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

/** Records what pm_worker_schedule asks the scheduler for; T3's own tests cover the scheduler. */
const scheduled: Array<{
  readonly threadId: string;
  readonly input: OrchestratorMcpScheduleTaskInput;
}> = [];
const layerScheduler = Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
  scheduleTask: (scope, input) =>
    input.title === "Worker: Refused"
      ? Effect.fail(
          new OrchestratorMcpFailure({ code: "capability_denied", message: "No run permission." }),
        )
      : Effect.sync(() => {
          scheduled.push({ threadId: scope.thread?.threadId ?? "", input });
          return {
            scheduledTaskId: ScheduledTaskId.make("task-1"),
            title: input.title ?? "",
            prompt: input.prompt,
            enabled: input.enabled ?? true,
            projectId: ProjectId.make("project-1"),
            boundThreadId: ThreadId.make(scope.thread?.threadId ?? "thread"),
            freshSession: false,
            schedule: { type: "once", runAt: "2026-11-26T09:00:00.000Z" } as never,
            nextRunAt: "2026-11-26T09:00:00.000Z" as never,
            lastRunStatus: "never" as never,
          };
        }),
});

const harness = (world: PmWorld, files: PipelineService.TestFiles = []) =>
  McpToolAccess.HandlersLayer.layer(PmMcpHandlers.layer).pipe(
    Layer.provideMerge(layerPmRemoteHere),
    Layer.provideMerge(layerPm(world)),
    Layer.provideMerge(PipelineService.layerTest({ providers: PROVIDERS, files })),
    Layer.provideMerge(layerScheduler),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

type ToolName = keyof typeof PmToolkit.tools;

const callAs = Effect.fn("test.callAs")(function* (
  threadId: string,
  name: ToolName,
  params: Record<string, unknown>,
) {
  const toolkit = yield* PmToolkit;
  const parts = yield* toolkit
    .handle(name as never, params as never)
    .pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
    );
  return parts.at(-1)?.result as unknown as { result?: string; code?: string; message?: string };
});

const createPm = Effect.fn("test.createPm")(function* (world: PmWorld) {
  const service = yield* PmService;
  const { threadId } = yield* service.create({
    projectId: PROJECT,
    createdBy: "user",
    creationSource: "web",
  });
  const shell = world.shells.get(threadId)!;
  world.shells.set(threadId, {
    ...shell,
    status: "running",
    activeRunId: RunId.make(`run:${threadId}`),
  });
  yield* callAs(threadId, "pm_guide", {});
  return threadId;
});

const workerId = (result: { result?: string }) =>
  result.result?.match(/\(thread ([^)]+)\)/)?.[1] ?? "";

describe("pm_worker_start with a role", () => {
  it.effect("picks the role's tier model, sets effort and adds the role's instructions", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const started = yield* callAs(pm, "pm_worker_start", {
        title: "Build the login form",
        brief: "Implement tasks/T1.md.",
        role: "builder",
      });
      expect(started.result).toContain(
        "Role builder on claudeAgent/claude-sonnet-5-5 (effort=high), mid tier.",
      );
      const launch = world.launches.at(-1)!;
      expect(launch.modelSelection).toEqual({
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "high" }],
      });
      const brief = launch.initialMessage?.text ?? "";
      expect(brief).toContain("## Your role: builder (mid tier)");
      expect(brief.indexOf("## Your role")).toBeLessThan(brief.indexOf("Implement tasks/T1.md."));
      expect(brief).toContain("project manager"); // PM3code's footer still follows
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("sends a reviewer to another vendor, and escalates on request", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const builder = workerId(
        yield* callAs(pm, "pm_worker_start", {
          title: "Build it",
          brief: "Build.",
          role: "builder",
        }),
      );
      const review = yield* callAs(pm, "pm_worker_start", {
        title: "Review it",
        brief: "Review the diff.",
        role: "reviewer",
        avoid_provider_of: [builder],
      });
      expect(review.result).toContain("Role reviewer on codex/gpt-6.2-sol (reasoningEffort=high)");
      const retry = yield* callAs(pm, "pm_worker_start", {
        title: "Build it again",
        brief: "Build, attempt 3.",
        role: "builder",
        escalate: 1,
      });
      expect(retry.result).toContain("claudeAgent/claude-opus-5-5");
      expect(retry.result).toContain("frontier tier");
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("moves to another account when a worker hit its usage limit", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const first = workerId(
        yield* callAs(pm, "pm_worker_start", { title: "Build A", brief: "A.", role: "builder" }),
      );
      const shell = world.shells.get(first)!;
      world.shells.set(first, {
        ...shell,
        status: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: "2099-01-01T00:00:00.000Z" as never,
      });
      const second = yield* callAs(pm, "pm_worker_start", {
        title: "Build B",
        brief: "B.",
        role: "builder",
      });
      expect(second.result).toContain("codex/gpt-6.2-sol");
      expect(second.result).toContain("claudeAgent/sonnet: at its usage limit until 2099-01-01");
      expect((yield* callAs(pm, "pm_roles", {})).result).toContain(
        "- claudeAgent until 2099-01-01",
      );
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("skips providers reported as out of usage by live provider limits", () => {
    const world = makeWorld();
    const providersWithGemini: ReadonlyArray<ProviderSnapshot> = [
      ...PROVIDERS,
      {
        instanceId: "antigravity",
        driver: "antigravity",
        enabled: true,
        models: [
          { slug: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
          { slug: "gemini-4-neon", name: "Gemini 4 Neon" },
          { slug: "gemini-4-carbon", name: "Gemini 4 Carbon" },
        ],
      },
    ];
    const liveLimited = new Map([
      ["claudeAgent", "2099-01-01T00:00:00.000Z"],
      ["codex", "2099-01-01T00:00:00.000Z"],
    ]);
    const customHarness = McpToolAccess.HandlersLayer.layer(PmMcpHandlers.layer).pipe(
      Layer.provideMerge(layerPmRemoteHere),
      Layer.provideMerge(layerPm(world)),
      Layer.provideMerge(
        PipelineService.layerTest({
          providers: providersWithGemini,
          limitedProviders: liveLimited,
        }),
      ),
      Layer.provideMerge(layerScheduler),
      Layer.provideMerge(SqlitePersistence.layerMemory),
    );
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const started = yield* callAs(pm, "pm_worker_start", {
        title: "Build with fallback",
        brief: "Implement task.",
        role: "builder",
      });
      expect(started.result).toContain("antigravity/gemini-4-neon");
      expect((yield* callAs(pm, "pm_roles", {})).result).toContain("Tiers (fallback order):");
    }).pipe(Effect.provide(customHarness));
  });

  it.effect("keeps a model the PM chose, refuses unknown roles", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const chosen = yield* callAs(pm, "pm_worker_start", {
        title: "Plan it",
        brief: "Plan.",
        role: "architect",
        modelSelection: { instanceId: "codex", model: "gpt-6.2-astra" },
      });
      expect(chosen.result).toContain("the model you chose");
      expect(world.launches.at(-1)?.modelSelection.model).toBe("gpt-6.2-astra");
      const unknown = yield* callAs(pm, "pm_worker_start", {
        title: "X",
        brief: "X.",
        role: "wizard",
      });
      expect(unknown.message).toContain('There is no role "wizard"');
    }).pipe(Effect.provide(harness(world)));
  });
});

describe("pm_pipelines and pm_roles", () => {
  it.effect("lists pipelines, renders one, and reports project overrides and problems", () => {
    const world = makeWorld();
    const files = [
      {
        path: "pipelines/hotfix.yaml",
        text: "description: Prod hotfix\nwhen: production is down\nstages:\n  - { id: fix, role: builder, goal: Fix it }\n  - { id: review, role: reviewer, goal: Check it, differentProviderFrom: fix }\n",
      },
      { path: "roles/builder.yaml", text: "tier: nope\n" },
    ];
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const list = (yield* callAs(pm, "pm_pipelines", {})).result ?? "";
      expect(list).toContain("- feature:");
      expect(list).toContain("- hotfix [.pipelines/pipelines/hotfix.yaml]: Prod hotfix");
      expect(list).toContain(".pipelines/roles/builder.yaml");
      const plan = (yield* callAs(pm, "pm_pipelines", { name: "hotfix" })).result ?? "";
      expect(plan).toContain("2. review: role reviewer (mid tier). Check it");
      expect((yield* callAs(pm, "pm_pipelines", { name: "nope" })).message).toContain(
        "There is no pipeline",
      );
      const roles = (yield* callAs(pm, "pm_roles", {})).result ?? "";
      expect(roles).toContain("- triage: small tier, up to mid, read-only.");
      expect(roles).toContain("Now: claudeAgent/claude-haiku-5-5");
    }).pipe(Effect.provide(harness(world, files)));
  });
});

describe("pm_worker_schedule", () => {
  it.effect("binds a schedule to the PM thread whose message replays pm_worker_start", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      scheduled.length = 0;
      const pm = yield* createPm(world);
      const launchesBefore = world.launches.length;
      const result = yield* callAs(pm, "pm_worker_schedule", {
        title: "Nightly audit",
        brief: "Audit the auth routes.",
        role: "security-reviewer",
        schedule: { type: "fixed_time", timeOfDay: "03:00" },
      });
      expect(result.result).toContain('Scheduled worker "Nightly audit" as task task-1.');
      expect(result.result).toContain("Next run: 2026-11-26T09:00:00.000Z.");
      expect(scheduled).toHaveLength(1);
      const { threadId, input } = scheduled[0]!;
      expect(threadId).toBe(pm);
      expect(input.bindToCurrentThread).toBe(true);
      expect(input.title).toBe("Worker: Nightly audit");
      expect(input.schedule).toEqual({ type: "fixed_time", timeOfDay: "03:00" });
      const json = input.prompt.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "";
      expect(JSON.parse(json)).toEqual({
        title: "Nightly audit",
        brief: "Audit the auth routes.",
        role: "security-reviewer",
      });
      expect(world.launches).toHaveLength(launchesBefore);
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("refuses unknown roles before scheduling, and reports scheduler refusals", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      scheduled.length = 0;
      const pm = yield* createPm(world);
      const unknown = yield* callAs(pm, "pm_worker_schedule", {
        title: "X",
        brief: "X.",
        role: "wizard",
        schedule: { type: "interval", everyMs: 3600000 },
      });
      expect(unknown.message).toContain('There is no role "wizard"');
      const refused = yield* callAs(pm, "pm_worker_schedule", {
        title: "Refused",
        brief: "X.",
        schedule: { type: "interval", everyMs: 3600000 },
      });
      expect(refused.message).toBe("No run permission.");
      expect(scheduled).toHaveLength(0);
    }).pipe(Effect.provide(harness(world)));
  });
});

describe("pm_run_gates", () => {
  it.effect("refuses when the project has no workspace root on disk", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const pm = yield* createPm(world);
      const result = yield* callAs(pm, "pm_run_gates", { commands: ["pnpm typecheck"] });
      expect(result.message).toContain("no workspace root on disk");
    }).pipe(Effect.provide(harness(world)));
  });
});
