// @effect-diagnostics-next-line nodeBuiltinImport:off - ephemeral HTTP test fixture.
import * as NodeHttp from "node:http";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerPm, makeWorld, PROJECT } from "../pm/Pm.testkit.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { runAppVerifyGate } from "./AppVerifyGate.ts";
import {
  classifyModelPriceTier,
  computeCacheHitPercent,
  computeSavingsPercent,
  estimateUsageCost,
} from "./CostEstimator.ts";
import * as OrchestrationStudioService from "./OrchestrationStudioService.ts";
import * as PipelineService from "./PipelineService.ts";

describe("CostEstimator", () => {
  it("classifies models and computes routing savings + cache discount accurately", () => {
    expect(classifyModelPriceTier("claude-opus-5-5")).toBe("frontier");
    expect(classifyModelPriceTier("claude-fable-5-2")).toBe("frontier");
    expect(classifyModelPriceTier("gpt-6.2-astra")).toBe("frontier");
    expect(classifyModelPriceTier("gemini-4-carbon")).toBe("frontier");
    expect(classifyModelPriceTier("claude-sonnet-4-6")).toBe("mid");
    expect(classifyModelPriceTier("gemini-4-neon")).toBe("mid");
    expect(classifyModelPriceTier("gemini-2.5-flash")).toBe("small");
    expect(classifyModelPriceTier("gemini-4-hydrogen")).toBe("small");
    expect(classifyModelPriceTier("gpt-6.1-terra")).toBe("small");

    const midCost = estimateUsageCost({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedTokens: 800_000,
    });
    expect(midCost.priceTier).toBe("mid");
    // Uncached: 200k * $3/M = $0.60 + cached: 800k * $0.30/M = $0.24 + output: 100k * $15/M = $1.50 => $2.34
    expect(midCost.costUsd).toBe(2.34);
    // Uncached frontier baseline: 1M * $15/M ($15) + 100k * $75/M ($7.50) = $22.50
    expect(midCost.frontierBaselineUsd).toBe(22.5);
    expect(computeSavingsPercent(midCost.costUsd, midCost.frontierBaselineUsd)).toBeGreaterThan(85);
    expect(computeCacheHitPercent(1_000_000, 800_000)).toBe(80);
  });
});

describe("AppVerifyGate", () => {
  it.effect("runs shell checks, probes live HTTP routes, and writes verify reports", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "agent-space-verify-" });

      const server = NodeHttp.createServer((req, res) => {
        res.statusCode = req.url === "/health" ? 200 : 200;
        res.setHeader("content-type", "text/html");
        res.end("<html><body><h1>Hello App</h1></body></html>");
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                resolve(typeof address === "object" && address !== null ? address.port : 0);
              });
            }),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
              }),
          ),
      );

      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      const runnerLayer = Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.succeed({
            code: 0,
            stdout: `ran ${input.args.at(-1) ?? ""}`,
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          } as never),
      });

      const report = yield* runAppVerifyGate({
        workspaceRoot: workspace,
        targetKind: "cli_or_api",
        commands: ["echo ok"],
        url: `http://127.0.0.1:${port}`,
        routes: ["/health"],
        runFolder: ".pipelines/runs/test-verify",
      }).pipe(Effect.provide(runnerLayer));

      expect(report.passed).toBe(true);
      expect(report.checks).toHaveLength(1);
      expect(report.checks[0]?.passed).toBe(true);
      expect(report.routesChecked).toHaveLength(1);
      expect(report.routesChecked[0]?.status).toBe(200);
      expect(report.browserUsed).toBe(false);
      expect(report.reportPath).toBe(".pipelines/runs/test-verify/verify-report.md");
      expect(
        yield* fs.exists(
          path.join(workspace, ".pipelines", "runs", "test-verify", "verify-report.json"),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("OrchestrationStudioService", () => {
  it.effect("tracks pipeline runs with budget guardrails and applies learnings to role YAML", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "agent-space-studio-" });
      const world = makeWorld();
      const projectId = ProjectId.make(PROJECT);

      const projectLayer = Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            workspaceRoot: workspace,
          } as never),
      });
      const pmLayer = layerPm(world);
      const pipelinesLayer = PipelineService.layer.pipe(Layer.provide(projectLayer));
      const sharedDeps = Layer.mergeAll(pmLayer, pipelinesLayer, projectLayer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      );
      const studioLayer = OrchestrationStudioService.layer.pipe(Layer.provideMerge(sharedDeps));

      yield* Effect.gen(function* () {
        const studio = yield* OrchestrationStudioService.OrchestrationStudioService;
        const pipelines = yield* PipelineService.PipelineService;

        // 1. Live pipeline run start + stage decision
        const started = yield* studio.startRun({
          projectId,
          pipelineName: "website-studio",
          goal: "Build a crisp landing page",
          budgetUsd: 5.0,
        });
        expect(started.pipelineName).toBe("website-studio");
        expect(started.status).toBe("running");
        expect(started.stages.map((s) => s.stageId)).toEqual(["spec", "build", "verify", "review"]);

        const waiting = yield* studio.updateStage({
          runId: started.runId,
          stageId: "spec",
          status: "waiting_approval",
          summary: "Spec ready for review",
        });
        expect(waiting.status).toBe("waiting_approval");

        const approved = yield* studio.decideStage({
          runId: started.runId,
          stageId: "spec",
          decision: "approve",
          note: "Looks good",
        });
        expect(approved.stages.find((s) => s.stageId === "spec")?.status).toBe("passed");
        expect(approved.status).toBe("running");
        expect(world.commands.length).toBeGreaterThan(0);

        // 2. Propose and apply cross-run learning into .pipelines/roles/builder.yaml
        const proposed = yield* studio.proposeLearning({
          projectId,
          roleName: "builder",
          category: "style_rule",
          title: "Overflow guard",
          ruleText: "Wrap wide tables in overflow-x-auto containers.",
          sourceRunId: started.runId,
        });
        expect(proposed.status).toBe("proposed");

        const applied = yield* studio.applyLearning(proposed.learningId);
        expect(applied.status).toBe("applied");

        const reloaded = yield* pipelines.configFor(projectId);
        const builderRole = reloaded.config.roles.get("builder");
        expect(builderRole?.instructions).toContain(
          "Wrap wide tables in overflow-x-auto containers.",
        );
      }).pipe(Effect.provide(studioLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
