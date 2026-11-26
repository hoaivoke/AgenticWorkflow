// pipelines: live pipeline run graph, cost/budget telemetry, A/B eval arena, app verification, and cross-run self-improving harness learnings.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ModelSelection,
  PmAppVerifyReport,
  PmError,
  ProjectId,
  ThreadId,
  type PmAppVerifyTargetKind,
  type PmEvalArmMetrics,
  type PmEvalRun,
  type PmHarnessLearning,
  type PmHarnessLearningCategory,
  type PmPipelineRun,
  type PmPipelineRunStatus,
  type PmPipelineStageRun,
  type PmPipelineStageRunStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { runPmMigrations } from "../pm/PmMigrations.ts";
import { PmService } from "../pm/PmService.ts";
import { PmStore } from "../pm/PmStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { runAppVerifyGate } from "./AppVerifyGate.ts";
import {
  computeCacheHitPercent,
  computeSavingsPercent,
  estimateUsageCost,
} from "./CostEstimator.ts";
import { PipelineService } from "./PipelineService.ts";

const invalid = (message: string) => new PmError({ code: "invalid_request", message });
const notFound = (message: string) => new PmError({ code: "not_found", message });
const unavailable = (message: string) => new PmError({ code: "unavailable", message });

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const VerifyReportJson = Schema.fromJsonString(PmAppVerifyReport);
const ModelSelectionJson = Schema.fromJsonString(ModelSelection);

const decodeStringArrayJson = Schema.decodeUnknownSync(StringArrayJson);
const encodeStringArrayJson = Schema.encodeSync(StringArrayJson);
const decodeVerifyReportJson = Schema.decodeUnknownEffect(VerifyReportJson);
const encodeVerifyReportJson = Schema.encodeEffect(VerifyReportJson);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(ModelSelectionJson);
const encodeModelSelectionJson = Schema.encodeEffect(ModelSelectionJson);

const parseStringArray = (raw: string): ReadonlyArray<string> => {
  try {
    return decodeStringArrayJson(raw);
  } catch {
    return [];
  }
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const makeId = Effect.fn("OrchestrationStudio.makeId")(function* (prefix: string) {
  const ms = yield* Clock.currentTimeMillis;
  const salt = yield* Random.nextIntBetween(0, 2 ** 31);
  return `${prefix}-${ms.toString(36)}-${salt.toString(36).padStart(6, "0")}`;
});

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

interface RunDbRow {
  readonly run_id: string;
  readonly project_id: string;
  readonly pm_thread_id: string | null;
  readonly pipeline_name: string;
  readonly goal: string;
  readonly status: PmPipelineRunStatus;
  readonly budget_usd: number | null;
  readonly spent_usd: number;
  readonly baseline_frontier_usd: number;
  readonly started_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface StageRunDbRow {
  readonly run_id: string;
  readonly stage_id: string;
  readonly stage_index: number;
  readonly role_name: string;
  readonly status: PmPipelineStageRunStatus;
  readonly worker_thread_id: string | null;
  readonly provider_model: string | null;
  readonly tier: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_tokens: number;
  readonly cost_usd: number;
  readonly duration_ms: number;
  readonly summary: string | null;
  readonly artifacts_json: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface EvalDbRow {
  readonly eval_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly target_kind: PmAppVerifyTargetKind;
  readonly baseline_model_json: string;
  readonly treatment_pipeline: string;
  readonly baseline_thread_id: string | null;
  readonly treatment_thread_id: string | null;
  readonly baseline_worktree: string | null;
  readonly treatment_worktree: string | null;
  readonly verify_commands_json: string;
  readonly verify_start_command: string | null;
  readonly verify_url: string | null;
  readonly status: "running" | "completed" | "failed";
  readonly baseline_verify_json: string | null;
  readonly treatment_verify_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface LearningDbRow {
  readonly learning_id: string;
  readonly project_id: string;
  readonly role_name: string;
  readonly source_run_id: string | null;
  readonly source_thread_id: string | null;
  readonly category: PmHarnessLearningCategory;
  readonly title: string;
  readonly rule_text: string;
  readonly status: "proposed" | "applied" | "dismissed";
  readonly created_at: string;
  readonly resolved_at: string | null;
}

interface ThreadTelemetry {
  readonly status: string;
  readonly modelLabel: string;
  readonly worktreePath: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly estimatedCostUsd: number;
  readonly frontierBaselineUsd: number;
  readonly durationMs: number;
  readonly humanInterventions: number;
}

const toLearning = (row: LearningDbRow): PmHarnessLearning => ({
  learningId: row.learning_id,
  projectId: ProjectId.make(row.project_id),
  roleName: row.role_name,
  sourceRunId: row.source_run_id,
  sourceThreadId: row.source_thread_id ? ThreadId.make(row.source_thread_id) : null,
  category: row.category,
  title: row.title,
  ruleText: row.rule_text,
  status: row.status,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
});

const toStageRun = (row: StageRunDbRow): PmPipelineStageRun => ({
  runId: row.run_id,
  stageId: row.stage_id,
  stageIndex: row.stage_index,
  roleName: row.role_name,
  status: row.status,
  workerThreadId: row.worker_thread_id ? ThreadId.make(row.worker_thread_id) : null,
  providerModel: row.provider_model,
  tier: row.tier,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cachedTokens: row.cached_tokens,
  costUsd: row.cost_usd,
  durationMs: row.duration_ms,
  summary: row.summary,
  artifacts: parseStringArray(row.artifacts_json),
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

const toPipelineRun = (row: RunDbRow, stages: ReadonlyArray<PmPipelineStageRun>): PmPipelineRun => {
  const totalInput = stages.reduce((sum, stage) => sum + stage.inputTokens, 0);
  const totalCached = stages.reduce((sum, stage) => sum + stage.cachedTokens, 0);
  return {
    runId: row.run_id,
    projectId: ProjectId.make(row.project_id),
    pmThreadId: row.pm_thread_id ? ThreadId.make(row.pm_thread_id) : null,
    pipelineName: row.pipeline_name,
    goal: row.goal,
    status: row.status,
    budgetUsd: row.budget_usd,
    spentUsd: round4(row.spent_usd),
    baselineFrontierUsd: round4(row.baseline_frontier_usd),
    savingsPercent: computeSavingsPercent(row.spent_usd, row.baseline_frontier_usd),
    cacheHitPercent: computeCacheHitPercent(totalInput, totalCached),
    stages,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
};

export interface OrchestrationStudioServiceShape {
  readonly listRuns: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<PmPipelineRun>, PmError>;
  readonly startRun: (input: {
    readonly projectId: ProjectId;
    readonly pmThreadId?: ThreadId | undefined;
    readonly pipelineName: string;
    readonly goal?: string | undefined;
    readonly budgetUsd?: number | null | undefined;
  }) => Effect.Effect<PmPipelineRun, PmError>;
  readonly updateStage: (input: {
    readonly runId: string;
    readonly stageId: string;
    readonly status: PmPipelineStageRunStatus;
    readonly workerThreadId?: ThreadId | undefined;
    readonly providerModel?: string | undefined;
    readonly tier?: string | undefined;
    readonly summary?: string | undefined;
    readonly artifacts?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<PmPipelineRun, PmError>;
  readonly decideStage: (input: {
    readonly runId: string;
    readonly stageId: string;
    readonly decision: "approve" | "reject";
    readonly note?: string | undefined;
  }) => Effect.Effect<PmPipelineRun, PmError>;
  readonly verifyApp: (input: {
    readonly projectId: ProjectId;
    readonly targetKind: PmAppVerifyTargetKind;
    readonly cwd?: string | undefined;
    readonly commands?: ReadonlyArray<string> | undefined;
    readonly startCommand?: string | undefined;
    readonly url?: string | undefined;
    readonly routes?: ReadonlyArray<string> | undefined;
    readonly runFolder?: string | undefined;
  }) => Effect.Effect<PmAppVerifyReport, PmError>;
  readonly listEvals: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<PmEvalRun>, PmError>;
  readonly startEval: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly prompt: string;
    readonly targetKind: PmAppVerifyTargetKind;
    readonly baselineModelSelection: ModelSelection;
    readonly treatmentPipeline: string;
    readonly verifyCommands?: ReadonlyArray<string> | undefined;
    readonly verifyStartCommand?: string | undefined;
    readonly verifyUrl?: string | undefined;
  }) => Effect.Effect<PmEvalRun, PmError>;
  readonly verifyEval: (evalId: string) => Effect.Effect<PmEvalRun, PmError>;
  readonly deleteEval: (evalId: string) => Effect.Effect<void, PmError>;
  readonly listLearnings: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<PmHarnessLearning>, PmError>;
  readonly proposeLearning: (input: {
    readonly projectId: ProjectId;
    readonly roleName: string;
    readonly category: PmHarnessLearningCategory;
    readonly title: string;
    readonly ruleText: string;
    readonly sourceRunId?: string | undefined;
    readonly sourceThreadId?: ThreadId | undefined;
  }) => Effect.Effect<PmHarnessLearning, PmError>;
  readonly applyLearning: (learningId: string) => Effect.Effect<PmHarnessLearning, PmError>;
  readonly dismissLearning: (learningId: string) => Effect.Effect<PmHarnessLearning, PmError>;
}

export class OrchestrationStudioService extends Context.Service<
  OrchestrationStudioService,
  OrchestrationStudioServiceShape
>()("t3/pipelines/OrchestrationStudioService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pipelines = yield* PipelineService;
  const pm = yield* PmService;
  const pmStore = yield* PmStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectService.ProjectService),
  );
  const launches = Option.getOrUndefined(
    yield* Effect.serviceOption(ThreadLaunch.ThreadLaunchService),
  );
  const fs = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
  const path = Option.getOrUndefined(yield* Effect.serviceOption(Path.Path));
  const runner = Option.getOrUndefined(yield* Effect.serviceOption(ProcessRunner.ProcessRunner));
  const platform = Option.getOrElse(yield* Effect.serviceOption(HostProcess.Platform), () =>
    HostProcess.Platform.defaultValue(),
  );

  yield* runPmMigrations().pipe(Effect.ignore);

  const readThreadTelemetry = Effect.fn("OrchestrationStudio.readThreadTelemetry")(function* (
    threadId: string,
    explicitTier?: string | null,
  ) {
    const tid = ThreadId.make(threadId);
    const shell = yield* threads.getThreadShell(tid).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) {
      return {
        status: "unknown",
        modelLabel: "unknown",
        worktreePath: null,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        estimatedCostUsd: 0,
        frontierBaselineUsd: 0,
        durationMs: 0,
        humanInterventions: 0,
      } satisfies ThreadTelemetry;
    }

    const records = yield* threads
      .getThreadRecords(tid, ["providerTurns", "messages", "runs"])
      .pipe(Effect.orElseSucceed(() => null));

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let estimatedCostUsd = 0;
    let frontierBaselineUsd = 0;
    let modelLabel = `${shell.modelSelection.instanceId}/${shell.modelSelection.model}`;

    for (const turn of records?.providerTurns ?? []) {
      const turnInput = turn.turnTokenUsage?.inputTokens ?? turn.tokenUsage?.inputTokens ?? 0;
      const turnOutput = turn.turnTokenUsage?.outputTokens ?? turn.tokenUsage?.outputTokens ?? 0;
      const turnCached =
        turn.turnTokenUsage?.cachedInputTokens ?? turn.tokenUsage?.cachedInputTokens ?? 0;
      const turnModel =
        turn.model ?? turn.turnTokenUsage?.models?.[0] ?? shell.modelSelection.model;
      modelLabel = `${shell.modelSelection.instanceId}/${turnModel}`;
      inputTokens += turnInput;
      outputTokens += turnOutput;
      cachedTokens += turnCached;
      const estimate = estimateUsageCost({
        model: turnModel,
        tier: explicitTier,
        inputTokens: turnInput,
        outputTokens: turnOutput,
        cachedTokens: turnCached,
      });
      estimatedCostUsd += estimate.costUsd;
      frontierBaselineUsd += estimate.frontierBaselineUsd;
    }

    let durationMs = 0;
    const runs = records?.runs ?? [];
    if (runs.length > 0) {
      const firstRequested = runs[0]?.requestedAt ? DateTime.toEpochMillis(runs[0].requestedAt) : 0;
      const lastCompleted = runs.at(-1)?.completedAt
        ? DateTime.toEpochMillis(runs.at(-1)!.completedAt!)
        : firstRequested;
      if (firstRequested > 0 && lastCompleted >= firstRequested) {
        durationMs = lastCompleted - firstRequested;
      }
    }

    const userMessages = (records?.messages ?? []).filter((message) => message.role === "user");
    const humanInterventions = Math.max(0, userMessages.length - 1);

    return {
      status: shell.status,
      modelLabel,
      worktreePath: shell.worktreePath,
      inputTokens,
      outputTokens,
      cachedTokens,
      estimatedCostUsd: round4(estimatedCostUsd),
      frontierBaselineUsd: round4(frontierBaselineUsd),
      durationMs,
      humanInterventions,
    } satisfies ThreadTelemetry;
  });

  const readGitDiffStats = Effect.fn("OrchestrationStudio.readGitDiffStats")(function* (
    cwd: string | null,
  ) {
    if (!cwd || runner === undefined) {
      return { filesChanged: 0, insertions: 0, deletions: 0 };
    }
    const out = yield* runner
      .run({
        command: "git",
        args: ["diff", "--numstat", "HEAD"],
        cwd,
        timeout: "15 seconds",
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (!out || out.code !== 0) {
      return { filesChanged: 0, insertions: 0, deletions: 0 };
    }
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of out.stdout.split(/\r?\n/u)) {
      const parts = line.trim().split(/\s+/u);
      if (parts.length < 3) continue;
      filesChanged += 1;
      const ins = Number(parts[0]);
      const del = Number(parts[1]);
      if (Number.isFinite(ins)) insertions += ins;
      if (Number.isFinite(del)) deletions += del;
    }
    return { filesChanged, insertions, deletions };
  });

  const loadRunById = Effect.fn("OrchestrationStudio.loadRunById")(function* (runId: string) {
    const runRows = yield* sql<RunDbRow>`
      SELECT
        run_id,
        project_id,
        pm_thread_id,
        pipeline_name,
        goal,
        status,
        budget_usd,
        spent_usd,
        baseline_frontier_usd,
        started_at,
        updated_at,
        completed_at
      FROM pm_pipeline_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `.pipe(Effect.mapError(() => unavailable("Could not read pipeline run.")));
    const runRow = runRows[0];
    if (!runRow) return yield* notFound(`Pipeline run "${runId}" was not found.`);

    const stageRows = yield* sql<StageRunDbRow>`
      SELECT
        run_id,
        stage_id,
        stage_index,
        role_name,
        status,
        worker_thread_id,
        provider_model,
        tier,
        input_tokens,
        output_tokens,
        cached_tokens,
        cost_usd,
        duration_ms,
        summary,
        artifacts_json,
        started_at,
        completed_at
      FROM pm_pipeline_stage_runs
      WHERE run_id = ${runId}
      ORDER BY stage_index ASC
    `.pipe(Effect.mapError(() => unavailable("Could not read pipeline stages.")));

    const refreshedStages: Array<PmPipelineStageRun> = [];
    let totalSpent = 0;
    let totalBaseline = 0;

    for (const stageRow of stageRows) {
      let stage = toStageRun(stageRow);
      if (stage.workerThreadId !== null) {
        const telemetry = yield* readThreadTelemetry(stage.workerThreadId, stage.tier);
        const stageInput = Math.max(stage.inputTokens, telemetry.inputTokens);
        const stageOutput = Math.max(stage.outputTokens, telemetry.outputTokens);
        const stageCached = Math.max(stage.cachedTokens, telemetry.cachedTokens);
        const estimate = estimateUsageCost({
          model: stage.providerModel ?? telemetry.modelLabel,
          tier: stage.tier,
          inputTokens: stageInput,
          outputTokens: stageOutput,
          cachedTokens: stageCached,
        });
        const stageCost = Math.max(stage.costUsd, estimate.costUsd);
        const stageDuration = Math.max(stage.durationMs, telemetry.durationMs);
        totalBaseline += estimate.frontierBaselineUsd;
        stage = {
          ...stage,
          providerModel: stage.providerModel ?? telemetry.modelLabel,
          inputTokens: stageInput,
          outputTokens: stageOutput,
          cachedTokens: stageCached,
          costUsd: stageCost,
          durationMs: stageDuration,
        };
        totalSpent += stageCost;
      } else {
        const estimate = estimateUsageCost({
          model: stage.providerModel,
          tier: stage.tier,
          inputTokens: stage.inputTokens,
          outputTokens: stage.outputTokens,
          cachedTokens: stage.cachedTokens,
        });
        totalSpent += stage.costUsd;
        totalBaseline += estimate.frontierBaselineUsd;
      }
      refreshedStages.push(stage);
    }

    let nextStatus = runRow.status;
    if (runRow.budget_usd !== null && totalSpent >= runRow.budget_usd && nextStatus === "running") {
      nextStatus = "budget_paused";
    }

    return toPipelineRun(
      {
        ...runRow,
        status: nextStatus,
        spent_usd: totalSpent,
        baseline_frontier_usd: Math.max(runRow.baseline_frontier_usd, totalBaseline),
      },
      refreshedStages,
    );
  });

  const listRuns: OrchestrationStudioServiceShape["listRuns"] = Effect.fn(
    "OrchestrationStudio.listRuns",
  )(function* (projectId: ProjectId) {
    const rows = yield* sql<{ readonly run_id: string }>`
      SELECT run_id
      FROM pm_pipeline_runs
      WHERE project_id = ${projectId}
      ORDER BY updated_at DESC
      LIMIT 20
    `.pipe(Effect.mapError(() => unavailable("Could not list pipeline runs.")));

    const runs: Array<PmPipelineRun> = [];
    for (const row of rows) {
      const run = yield* loadRunById(row.run_id).pipe(Effect.orElseSucceed(() => null));
      if (run !== null) runs.push(run);
    }
    return runs;
  });

  const startRun: OrchestrationStudioServiceShape["startRun"] = Effect.fn(
    "OrchestrationStudio.startRun",
  )(function* (input) {
    const { config } = yield* pipelines.configFor(input.projectId);
    const pipeline = config.pipelines.get(input.pipelineName);
    if (pipeline === undefined) {
      return yield* invalid(`Pipeline "${input.pipelineName}" was not found for this project.`);
    }

    let pmThreadId = input.pmThreadId;
    const goalText = (input.goal ?? "").trim();

    if (pmThreadId === undefined) {
      const created = yield* pm.create({
        projectId: input.projectId,
        createdBy: "user",
        creationSource: "web",
      });
      pmThreadId = created.threadId;
    }

    const runId = yield* makeId("run");
    const at = yield* nowIso;

    yield* sql`
      INSERT INTO pm_pipeline_runs (
        run_id,
        project_id,
        pm_thread_id,
        pipeline_name,
        goal,
        status,
        budget_usd,
        spent_usd,
        baseline_frontier_usd,
        started_at,
        updated_at,
        completed_at
      ) VALUES (
        ${runId},
        ${input.projectId},
        ${pmThreadId ?? null},
        ${pipeline.name},
        ${goalText},
        'running',
        ${input.budgetUsd ?? null},
        0,
        0,
        ${at},
        ${at},
        NULL
      )
    `.pipe(Effect.mapError(() => unavailable("Could not create pipeline run record.")));

    for (let index = 0; index < pipeline.stages.length; index += 1) {
      const stage = pipeline.stages[index]!;
      const roleName = stage.role ?? "gatekeeper";
      const role = config.roles.get(roleName);
      yield* sql`
        INSERT INTO pm_pipeline_stage_runs (
          run_id,
          stage_id,
          stage_index,
          role_name,
          status,
          tier,
          artifacts_json
        ) VALUES (
          ${runId},
          ${stage.id},
          ${index},
          ${roleName},
          'pending',
          ${role?.tier ?? "mid"},
          '[]'
        )
      `.pipe(Effect.mapError(() => unavailable("Could not seed pipeline stages.")));
    }

    // If initiated directly from the Studio UI, send an immediate kickoff prompt to the new PM thread.
    if (input.pmThreadId === undefined && pmThreadId !== undefined) {
      const kickoffText = [
        `Execute pipeline "${pipeline.name}" (tracked live runId: "${runId}") for this project.`,
        ...(goalText.length > 0 ? ["", `Goal: ${goalText}`] : []),
        ...(input.budgetUsd !== undefined && input.budgetUsd !== null
          ? ["", `Budget guardrail: $${input.budgetUsd.toFixed(2)} USD max. Pause if approached.`]
          : []),
        "",
        `Instructions: Call pm_pipelines(name: "${pipeline.name}") and pm_roles() first. As you run each stage, report state with pm_pipeline_stage_update(run_id: "${runId}", stage_id, status, worker_thread_id, summary) so the Live Runs graph updates in real time. For verify/gate stages call pm_verify_app directly at zero LLM cost, and call pm_learning_propose for any reusable rule discovered.`,
      ].join("\n");

      const msgKey = yield* makeId("kickoff");
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:studio:${msgKey}`),
          threadId: pmThreadId,
          messageId: MessageId.make(`message:studio:${msgKey}`),
          text: kickoffText,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.ignore);
    }

    return yield* loadRunById(runId);
  });

  const updateStage: OrchestrationStudioServiceShape["updateStage"] = Effect.fn(
    "OrchestrationStudio.updateStage",
  )(function* (input) {
    const currentRun = yield* loadRunById(input.runId);
    const existingStage = currentRun.stages.find((stage) => stage.stageId === input.stageId);
    if (!existingStage) {
      return yield* notFound(`Stage "${input.stageId}" does not exist in run "${input.runId}".`);
    }

    const at = yield* nowIso;
    const workerThreadId = input.workerThreadId ?? existingStage.workerThreadId;
    let tier = input.tier ?? existingStage.tier;
    let providerModel = input.providerModel ?? existingStage.providerModel;
    let inputTokens = existingStage.inputTokens;
    let outputTokens = existingStage.outputTokens;
    let cachedTokens = existingStage.cachedTokens;
    let costUsd = existingStage.costUsd;
    let durationMs = existingStage.durationMs;

    if (workerThreadId !== null) {
      const telemetry = yield* readThreadTelemetry(workerThreadId, tier);
      providerModel = providerModel ?? telemetry.modelLabel;
      inputTokens = telemetry.inputTokens;
      outputTokens = telemetry.outputTokens;
      cachedTokens = telemetry.cachedTokens;
      costUsd = telemetry.estimatedCostUsd;
      durationMs = telemetry.durationMs;
    }

    const startedAt =
      existingStage.startedAt ?? (input.status === "running" ? at : existingStage.startedAt);
    const completedAt =
      input.status === "passed" || input.status === "failed" || input.status === "skipped"
        ? at
        : null;
    const artifactsJson =
      input.artifacts !== undefined
        ? encodeStringArrayJson([...input.artifacts])
        : encodeStringArrayJson([...existingStage.artifacts]);

    yield* sql`
      UPDATE pm_pipeline_stage_runs
      SET
        status = ${input.status},
        worker_thread_id = ${workerThreadId ?? null},
        provider_model = ${providerModel ?? null},
        tier = ${tier ?? null},
        input_tokens = ${inputTokens},
        output_tokens = ${outputTokens},
        cached_tokens = ${cachedTokens},
        cost_usd = ${costUsd},
        duration_ms = ${durationMs},
        summary = ${input.summary ?? existingStage.summary ?? null},
        artifacts_json = ${artifactsJson},
        started_at = ${startedAt ?? null},
        completed_at = ${completedAt}
      WHERE run_id = ${input.runId} AND stage_id = ${input.stageId}
    `.pipe(Effect.mapError(() => unavailable("Could not update pipeline stage.")));

    const refreshed = yield* loadRunById(input.runId);
    let nextRunStatus: PmPipelineRunStatus = "running";
    if (
      refreshed.budgetUsd !== null &&
      refreshed.spentUsd >= refreshed.budgetUsd &&
      refreshed.stages.some((stage) => stage.status === "running" || stage.status === "pending")
    ) {
      nextRunStatus = "budget_paused";
    } else if (refreshed.stages.some((stage) => stage.status === "waiting_approval")) {
      nextRunStatus = "waiting_approval";
    } else if (refreshed.stages.some((stage) => stage.status === "failed")) {
      nextRunStatus = "failed";
    } else if (
      refreshed.stages.every((stage) => stage.status === "passed" || stage.status === "skipped")
    ) {
      nextRunStatus = "completed";
    }

    yield* sql`
      UPDATE pm_pipeline_runs
      SET
        status = ${nextRunStatus},
        spent_usd = ${refreshed.spentUsd},
        baseline_frontier_usd = ${refreshed.baselineFrontierUsd},
        updated_at = ${at},
        completed_at = ${nextRunStatus === "completed" || nextRunStatus === "failed" ? at : null}
      WHERE run_id = ${input.runId}
    `.pipe(Effect.ignore);

    return yield* loadRunById(input.runId);
  });

  const decideStage: OrchestrationStudioServiceShape["decideStage"] = Effect.fn(
    "OrchestrationStudio.decideStage",
  )(function* (input) {
    const nextStageStatus: PmPipelineStageRunStatus =
      input.decision === "approve" ? "passed" : "failed";
    const run = yield* updateStage({
      runId: input.runId,
      stageId: input.stageId,
      status: nextStageStatus,
      summary:
        input.note?.trim() ||
        (input.decision === "approve"
          ? "Approved by user in Live Runs studio."
          : "Rejected by user in Live Runs studio."),
    });

    if (run.pmThreadId !== null) {
      const msgKey = yield* makeId("decide");
      const text =
        input.decision === "approve"
          ? `Stage "${input.stageId}" in pipeline run "${run.runId}" was APPROVED by the user.${input.note?.trim() ? ` Note: ${input.note.trim()}` : ""} Proceed to the next stage.`
          : `Stage "${input.stageId}" in pipeline run "${run.runId}" was REJECTED by the user.${input.note?.trim() ? ` Feedback: ${input.note.trim()}` : ""} Address the feedback and loop back.`;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:decide:${msgKey}`),
          threadId: run.pmThreadId,
          messageId: MessageId.make(`message:decide:${msgKey}`),
          text,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.ignore);
    }

    return run;
  });

  const verifyApp: OrchestrationStudioServiceShape["verifyApp"] = Effect.fn(
    "OrchestrationStudio.verifyApp",
  )(function* (input) {
    if (projects === undefined || fs === undefined || path === undefined) {
      return yield* unavailable("Workspace verification services are unavailable in this runtime.");
    }
    const project = yield* projects
      .getById(input.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) {
      return yield* notFound(`Project "${input.projectId}" was not found.`);
    }
    let effect = runAppVerifyGate({
      workspaceRoot: project.value.workspaceRoot,
      targetKind: input.targetKind,
      cwd: input.cwd,
      commands: input.commands,
      startCommand: input.startCommand,
      url: input.url,
      routes: input.routes,
      runFolder: input.runFolder,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );
    if (runner !== undefined) {
      effect = effect.pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));
    }
    return yield* effect;
  });

  const hydrateEvalRow = Effect.fn("OrchestrationStudio.hydrateEvalRow")(function* (
    row: EvalDbRow,
  ) {
    const baselineVerify = row.baseline_verify_json
      ? yield* decodeVerifyReportJson(row.baseline_verify_json).pipe(
          Effect.orElseSucceed(() => null),
        )
      : null;
    const treatmentVerify = row.treatment_verify_json
      ? yield* decodeVerifyReportJson(row.treatment_verify_json).pipe(
          Effect.orElseSucceed(() => null),
        )
      : null;

    const baselineSelection = yield* decodeModelSelectionJson(row.baseline_model_json).pipe(
      Effect.orElseSucceed(() => null),
    );
    const defaultBaselineModel = baselineSelection
      ? `${baselineSelection.instanceId}/${baselineSelection.model}`
      : "baseline";

    const baselineTelemetry = row.baseline_thread_id
      ? yield* readThreadTelemetry(row.baseline_thread_id, "frontier")
      : null;
    const baselineDiff = yield* readGitDiffStats(
      baselineTelemetry?.worktreePath ?? row.baseline_worktree,
    );

    const baselineArm: PmEvalArmMetrics = {
      threadId: row.baseline_thread_id ? ThreadId.make(row.baseline_thread_id) : null,
      status: baselineTelemetry?.status ?? "pending",
      modelLabel: baselineTelemetry?.modelLabel ?? defaultBaselineModel,
      inputTokens: baselineTelemetry?.inputTokens ?? 0,
      outputTokens: baselineTelemetry?.outputTokens ?? 0,
      cachedTokens: baselineTelemetry?.cachedTokens ?? 0,
      cacheHitPercent: computeCacheHitPercent(
        baselineTelemetry?.inputTokens ?? 0,
        baselineTelemetry?.cachedTokens ?? 0,
      ),
      estimatedCostUsd: baselineTelemetry?.estimatedCostUsd ?? 0,
      durationMs: baselineTelemetry?.durationMs ?? 0,
      humanInterventions: baselineTelemetry?.humanInterventions ?? 0,
      filesChanged: baselineDiff.filesChanged,
      insertions: baselineDiff.insertions,
      deletions: baselineDiff.deletions,
      verify: baselineVerify,
    };

    // Treatment arm aggregates PM coordinator thread + all linked worker threads!
    let tInput = 0;
    let tOutput = 0;
    let tCached = 0;
    let tCost = 0;
    let tDuration = 0;
    let tStatus = "pending";
    let tModelLabel = row.treatment_pipeline;
    let tHumanInterventions = 0;
    let tWorktree = row.treatment_worktree;

    if (row.treatment_thread_id) {
      const pmTelemetry = yield* readThreadTelemetry(row.treatment_thread_id, null);
      tInput += pmTelemetry.inputTokens;
      tOutput += pmTelemetry.outputTokens;
      tCached += pmTelemetry.cachedTokens;
      tCost += pmTelemetry.estimatedCostUsd;
      tDuration += pmTelemetry.durationMs;
      tStatus = pmTelemetry.status;
      tHumanInterventions += pmTelemetry.humanInterventions;
      const workers = yield* pmStore
        .listWorkers(row.treatment_thread_id)
        .pipe(Effect.orElseSucceed(() => []));
      if (workers.length > 0) {
        const models = new Set<string>();
        for (const worker of workers) {
          const wt = yield* readThreadTelemetry(worker.workerThreadId, null);
          tInput += wt.inputTokens;
          tOutput += wt.outputTokens;
          tCached += wt.cachedTokens;
          tCost += wt.estimatedCostUsd;
          tDuration = Math.max(tDuration, wt.durationMs);
          models.add(wt.modelLabel);
          if (wt.worktreePath) tWorktree = wt.worktreePath;
        }
        if (models.size > 0) {
          tModelLabel = `${row.treatment_pipeline} (${[...models].join(", ")})`;
        }
      }
    }

    const treatmentDiff = yield* readGitDiffStats(tWorktree);
    const treatmentArm: PmEvalArmMetrics = {
      threadId: row.treatment_thread_id ? ThreadId.make(row.treatment_thread_id) : null,
      status: tStatus,
      modelLabel: tModelLabel,
      inputTokens: tInput,
      outputTokens: tOutput,
      cachedTokens: tCached,
      cacheHitPercent: computeCacheHitPercent(tInput, tCached),
      estimatedCostUsd: round4(tCost),
      durationMs: tDuration,
      humanInterventions: tHumanInterventions,
      filesChanged: treatmentDiff.filesChanged,
      insertions: treatmentDiff.insertions,
      deletions: treatmentDiff.deletions,
      verify: treatmentVerify,
    };

    const costDeltaPercent =
      baselineArm.estimatedCostUsd > 0 && treatmentArm.estimatedCostUsd > 0
        ? Math.round(
            ((treatmentArm.estimatedCostUsd - baselineArm.estimatedCostUsd) /
              baselineArm.estimatedCostUsd) *
              1000,
          ) / 10
        : null;

    const evalStatus =
      baselineArm.status === "running" || treatmentArm.status === "running"
        ? "running"
        : baselineArm.status === "failed" && treatmentArm.status === "failed"
          ? "failed"
          : "completed";

    return {
      evalId: row.eval_id,
      projectId: ProjectId.make(row.project_id),
      title: row.title,
      prompt: row.prompt,
      targetKind: row.target_kind,
      treatmentPipeline: row.treatment_pipeline,
      verifyCommands: parseStringArray(row.verify_commands_json),
      verifyStartCommand: row.verify_start_command,
      verifyUrl: row.verify_url,
      status: evalStatus,
      baseline: baselineArm,
      treatment: treatmentArm,
      costDeltaPercent,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } satisfies PmEvalRun;
  });

  const listEvals: OrchestrationStudioServiceShape["listEvals"] = Effect.fn(
    "OrchestrationStudio.listEvals",
  )(function* (projectId: ProjectId) {
    const rows = yield* sql<EvalDbRow>`
      SELECT
        eval_id,
        project_id,
        title,
        prompt,
        target_kind,
        baseline_model_json,
        treatment_pipeline,
        baseline_thread_id,
        treatment_thread_id,
        baseline_worktree,
        treatment_worktree,
        verify_commands_json,
        verify_start_command,
        verify_url,
        status,
        baseline_verify_json,
        treatment_verify_json,
        created_at,
        updated_at
      FROM pm_eval_runs
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC
      LIMIT 15
    `.pipe(Effect.mapError(() => unavailable("Could not list A/B eval runs.")));

    const results: Array<PmEvalRun> = [];
    for (const row of rows) {
      results.push(yield* hydrateEvalRow(row));
    }
    return results;
  });

  const startEval: OrchestrationStudioServiceShape["startEval"] = Effect.fn(
    "OrchestrationStudio.startEval",
  )(function* (input) {
    if (launches === undefined) {
      return yield* unavailable("ThreadLaunchService is unavailable in this runtime.");
    }
    const evalId = yield* makeId("eval");
    const cmdId = CommandId.make(`command:${evalId}:baseline`);
    const baselineLaunch = yield* launches
      .launch({
        commandId: cmdId,
        projectId: input.projectId,
        title: `Eval Baseline · ${input.title}`.slice(0, 80),
        titleRenamed: true,
        modelSelection: input.baselineModelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
        initialMessage: {
          text: input.prompt,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError((error) => unavailable(`Could not launch baseline arm: ${String(error)}`)),
      );

    const treatmentPm = yield* pm.create({
      projectId: input.projectId,
      createdBy: "user",
      creationSource: "web",
    });

    const trackedRun = yield* startRun({
      projectId: input.projectId,
      pmThreadId: treatmentPm.threadId,
      pipelineName: input.treatmentPipeline,
      goal: input.prompt,
    });

    const verifyBlock = [
      input.verifyCommands && input.verifyCommands.length > 0
        ? `Verify commands: ${input.verifyCommands.join(", ")}`
        : "",
      input.verifyStartCommand ? `Start command: ${input.verifyStartCommand}` : "",
      input.verifyUrl ? `Target URL: ${input.verifyUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const treatmentMsgKey = yield* makeId("eval-pm");
    const treatmentPrompt = [
      `You are the Treatment arm of A/B Eval "${input.title}".`,
      `Run the "${input.treatmentPipeline}" pipeline (tracked runId: "${trackedRun.runId}") inside a worktree to fulfill this exact user request:`,
      "",
      input.prompt,
      ...(verifyBlock ? ["", verifyBlock] : []),
      "",
      `Call pm_pipelines(name: "${input.treatmentPipeline}") and pm_roles() first. Keep updating pm_pipeline_stage_update(run_id: "${trackedRun.runId}", ...) on every stage transition, run pm_verify_app(target_kind: "${input.targetKind}") before finishing, and log reusable rules with pm_learning_propose.`,
    ].join("\n");

    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:eval:${treatmentMsgKey}`),
        threadId: treatmentPm.threadId,
        messageId: MessageId.make(`message:eval:${treatmentMsgKey}`),
        text: treatmentPrompt,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(() => unavailable("Could not dispatch treatment prompt.")));

    const encodedBaseline = yield* encodeModelSelectionJson(input.baselineModelSelection).pipe(
      Effect.mapError(() => invalid("Invalid baseline model selection.")),
    );
    const verifyCommandsJson = encodeStringArrayJson([...(input.verifyCommands ?? [])]);
    const at = yield* nowIso;
    const baselineWorktree = baselineLaunch.projection.thread.worktreePath ?? null;

    yield* sql`
      INSERT INTO pm_eval_runs (
        eval_id,
        project_id,
        title,
        prompt,
        target_kind,
        baseline_model_json,
        treatment_pipeline,
        baseline_thread_id,
        treatment_thread_id,
        baseline_worktree,
        treatment_worktree,
        verify_commands_json,
        verify_start_command,
        verify_url,
        status,
        created_at,
        updated_at
      ) VALUES (
        ${evalId},
        ${input.projectId},
        ${input.title},
        ${input.prompt},
        ${input.targetKind},
        ${encodedBaseline},
        ${input.treatmentPipeline},
        ${baselineLaunch.threadId},
        ${treatmentPm.threadId},
        ${baselineWorktree},
        NULL,
        ${verifyCommandsJson},
        ${input.verifyStartCommand ?? null},
        ${input.verifyUrl ?? null},
        'running',
        ${at},
        ${at}
      )
    `.pipe(Effect.mapError(() => unavailable("Could not save A/B eval run.")));

    const inserted = yield* sql<EvalDbRow>`
      SELECT
        eval_id,
        project_id,
        title,
        prompt,
        target_kind,
        baseline_model_json,
        treatment_pipeline,
        baseline_thread_id,
        treatment_thread_id,
        baseline_worktree,
        treatment_worktree,
        verify_commands_json,
        verify_start_command,
        verify_url,
        status,
        baseline_verify_json,
        treatment_verify_json,
        created_at,
        updated_at
      FROM pm_eval_runs
      WHERE eval_id = ${evalId}
      LIMIT 1
    `.pipe(Effect.mapError(() => unavailable("Could not reload A/B eval run.")));

    return yield* hydrateEvalRow(inserted[0]!);
  });

  const verifyEval: OrchestrationStudioServiceShape["verifyEval"] = Effect.fn(
    "OrchestrationStudio.verifyEval",
  )(function* (evalId: string) {
    const rows = yield* sql<EvalDbRow>`
      SELECT
        eval_id,
        project_id,
        title,
        prompt,
        target_kind,
        baseline_model_json,
        treatment_pipeline,
        baseline_thread_id,
        treatment_thread_id,
        baseline_worktree,
        treatment_worktree,
        verify_commands_json,
        verify_start_command,
        verify_url,
        status,
        baseline_verify_json,
        treatment_verify_json,
        created_at,
        updated_at
      FROM pm_eval_runs
      WHERE eval_id = ${evalId}
      LIMIT 1
    `.pipe(Effect.mapError(() => unavailable("Could not load eval run.")));
    const row = rows[0];
    if (!row) return yield* notFound(`Eval run "${evalId}" was not found.`);

    const hydrated = yield* hydrateEvalRow(row);
    const commands = parseStringArray(row.verify_commands_json);

    let baselineCwd = row.baseline_worktree ?? undefined;
    if (baselineCwd === undefined && row.baseline_thread_id) {
      const shell = yield* threads
        .getThreadShell(ThreadId.make(row.baseline_thread_id))
        .pipe(Effect.orElseSucceed(() => null));
      baselineCwd = shell?.worktreePath ?? undefined;
    }

    let treatmentCwd = row.treatment_worktree ?? undefined;
    if (treatmentCwd === undefined && row.treatment_thread_id) {
      const workers = yield* pmStore
        .listWorkers(row.treatment_thread_id)
        .pipe(Effect.orElseSucceed(() => []));
      for (const worker of workers) {
        const shell = yield* threads
          .getThreadShell(ThreadId.make(worker.workerThreadId))
          .pipe(Effect.orElseSucceed(() => null));
        if (shell?.worktreePath) {
          treatmentCwd = shell.worktreePath;
        }
      }
    }

    const projectId = ProjectId.make(row.project_id);
    const baselineReport = yield* verifyApp({
      projectId,
      targetKind: row.target_kind,
      cwd: baselineCwd,
      commands,
      startCommand: row.verify_start_command ?? undefined,
      url: row.verify_url ?? undefined,
    });
    const treatmentReport = yield* verifyApp({
      projectId,
      targetKind: row.target_kind,
      cwd: treatmentCwd,
      commands,
      startCommand: row.verify_start_command ?? undefined,
      url: row.verify_url ?? undefined,
    });

    const baselineJson = yield* encodeVerifyReportJson(baselineReport).pipe(
      Effect.mapError(() => unavailable("Could not serialize baseline verification report.")),
    );
    const treatmentJson = yield* encodeVerifyReportJson(treatmentReport).pipe(
      Effect.mapError(() => unavailable("Could not serialize treatment verification report.")),
    );
    const at = yield* nowIso;

    yield* sql`
      UPDATE pm_eval_runs
      SET
        baseline_verify_json = ${baselineJson},
        treatment_verify_json = ${treatmentJson},
        treatment_worktree = ${treatmentCwd ?? row.treatment_worktree ?? null},
        status = ${hydrated.status},
        updated_at = ${at}
      WHERE eval_id = ${evalId}
    `.pipe(Effect.mapError(() => unavailable("Could not save eval verification results.")));

    const refreshedRows = yield* sql<EvalDbRow>`
      SELECT
        eval_id,
        project_id,
        title,
        prompt,
        target_kind,
        baseline_model_json,
        treatment_pipeline,
        baseline_thread_id,
        treatment_thread_id,
        baseline_worktree,
        treatment_worktree,
        verify_commands_json,
        verify_start_command,
        verify_url,
        status,
        baseline_verify_json,
        treatment_verify_json,
        created_at,
        updated_at
      FROM pm_eval_runs
      WHERE eval_id = ${evalId}
      LIMIT 1
    `.pipe(Effect.mapError(() => unavailable("Could not reload verified eval run.")));

    return yield* hydrateEvalRow(refreshedRows[0]!);
  });

  const deleteEval: OrchestrationStudioServiceShape["deleteEval"] = Effect.fn(
    "OrchestrationStudio.deleteEval",
  )(function* (evalId: string) {
    yield* sql`DELETE FROM pm_eval_runs WHERE eval_id = ${evalId}`.pipe(
      Effect.mapError(() => unavailable("Could not delete eval run.")),
    );
  });

  const listLearnings: OrchestrationStudioServiceShape["listLearnings"] = Effect.fn(
    "OrchestrationStudio.listLearnings",
  )(function* (projectId: ProjectId) {
    const rows = yield* sql<LearningDbRow>`
      SELECT
        learning_id,
        project_id,
        role_name,
        source_run_id,
        source_thread_id,
        category,
        title,
        rule_text,
        status,
        created_at,
        resolved_at
      FROM pm_harness_learnings
      WHERE project_id = ${projectId}
      ORDER BY
        CASE status WHEN 'proposed' THEN 0 WHEN 'applied' THEN 1 ELSE 2 END ASC,
        created_at DESC
      LIMIT 60
    `.pipe(Effect.mapError(() => unavailable("Could not load harness learnings.")));

    return rows.map(toLearning);
  });

  const proposeLearning: OrchestrationStudioServiceShape["proposeLearning"] = Effect.fn(
    "OrchestrationStudio.proposeLearning",
  )(function* (input) {
    const learningId = yield* makeId("learn");
    const at = yield* nowIso;
    yield* sql`
      INSERT INTO pm_harness_learnings (
        learning_id,
        project_id,
        role_name,
        source_run_id,
        source_thread_id,
        category,
        title,
        rule_text,
        status,
        created_at,
        resolved_at
      ) VALUES (
        ${learningId},
        ${input.projectId},
        ${input.roleName.trim()},
        ${input.sourceRunId ?? null},
        ${input.sourceThreadId ?? null},
        ${input.category},
        ${input.title.trim()},
        ${input.ruleText.trim()},
        'proposed',
        ${at},
        NULL
      )
    `.pipe(Effect.mapError(() => unavailable("Could not save proposed harness learning.")));

    return {
      learningId,
      projectId: input.projectId,
      roleName: input.roleName.trim(),
      sourceRunId: input.sourceRunId ?? null,
      sourceThreadId: input.sourceThreadId ?? null,
      category: input.category,
      title: input.title.trim(),
      ruleText: input.ruleText.trim(),
      status: "proposed",
      createdAt: at,
      resolvedAt: null,
    } satisfies PmHarnessLearning;
  });

  const applyLearning: OrchestrationStudioServiceShape["applyLearning"] = Effect.fn(
    "OrchestrationStudio.applyLearning",
  )(function* (learningId: string) {
    const rows = yield* sql<LearningDbRow>`
      SELECT
        learning_id,
        project_id,
        role_name,
        source_run_id,
        source_thread_id,
        category,
        title,
        rule_text,
        status,
        created_at,
        resolved_at
      FROM pm_harness_learnings
      WHERE learning_id = ${learningId}
      LIMIT 1
    `.pipe(Effect.mapError(() => unavailable("Could not load learning.")));
    const row = rows[0];
    if (!row) return yield* notFound(`Learning "${learningId}" was not found.`);

    const projectId = ProjectId.make(row.project_id);
    const { config } = yield* pipelines.configFor(projectId);
    const role = config.roles.get(row.role_name);
    if (role === undefined) {
      return yield* invalid(
        `Role "${row.role_name}" does not exist. Create the role before applying a learning to it.`,
      );
    }

    const bullet = `- [${row.category}] ${row.title}: ${row.rule_text}`;
    const currentInstructions = role.instructions.trim();
    const nextInstructions = currentInstructions.includes(row.rule_text)
      ? currentInstructions
      : currentInstructions.includes("## Learned Rules")
        ? `${currentInstructions}\n${bullet}`
        : `${currentInstructions}\n\n## Learned Rules\n${bullet}`;

    yield* pipelines.saveRole({
      projectId,
      role: {
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
        instructions: nextInstructions,
      },
    });

    const at = yield* nowIso;
    yield* sql`
      UPDATE pm_harness_learnings
      SET status = 'applied', resolved_at = ${at}
      WHERE learning_id = ${learningId}
    `.pipe(Effect.mapError(() => unavailable("Could not mark learning as applied.")));

    return toLearning({ ...row, status: "applied", resolved_at: at });
  });

  const dismissLearning: OrchestrationStudioServiceShape["dismissLearning"] = Effect.fn(
    "OrchestrationStudio.dismissLearning",
  )(function* (learningId: string) {
    const rows = yield* sql<LearningDbRow>`
      SELECT
        learning_id,
        project_id,
        role_name,
        source_run_id,
        source_thread_id,
        category,
        title,
        rule_text,
        status,
        created_at,
        resolved_at
      FROM pm_harness_learnings
      WHERE learning_id = ${learningId}
      LIMIT 1
    `.pipe(Effect.mapError(() => unavailable("Could not load learning.")));
    const row = rows[0];
    if (!row) return yield* notFound(`Learning "${learningId}" was not found.`);

    const at = yield* nowIso;
    yield* sql`
      UPDATE pm_harness_learnings
      SET status = 'dismissed', resolved_at = ${at}
      WHERE learning_id = ${learningId}
    `.pipe(Effect.mapError(() => unavailable("Could not dismiss learning.")));

    return toLearning({ ...row, status: "dismissed", resolved_at: at });
  });

  return {
    listRuns,
    startRun,
    updateStage,
    decideStage,
    verifyApp,
    listEvals,
    startEval,
    verifyEval,
    deleteEval,
    listLearnings,
    proposeLearning,
    applyLearning,
    dismissLearning,
  } satisfies OrchestrationStudioServiceShape;
});

export const layer = Layer.effect(OrchestrationStudioService, make);
