import type {
  EnvironmentId,
  PmPipelineRun,
  PmPipelineRunStatus,
  PmPipelineStageRun,
  PmPipelineStageRunStatus,
  PmWorkspacePipelinesSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import {
  ActivityIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  ClockIcon,
  CpuIcon,
  DollarSignIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { cn } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { runPmCommand } from "./actions";
import { pmCommands, usePipelineRuns } from "./state";

const FIELD_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";

function runBadgeVariant(
  status: PmPipelineRunStatus,
): "default" | "info" | "warning" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "waiting_approval" || status === "budget_paused") return "warning";
  if (status === "failed") return "destructive";
  return "info";
}

function stageBorderClass(status: PmPipelineStageRunStatus): string {
  if (status === "passed") return "border-primary/60 bg-primary/5";
  if (status === "running") return "border-primary bg-accent/60";
  if (status === "waiting_approval") return "border-warning bg-warning/10";
  if (status === "failed") return "border-destructive bg-destructive/10";
  return "border-border bg-background";
}

function stageBadgeVariant(
  status: PmPipelineStageRunStatus,
): "default" | "secondary" | "warning" | "destructive" | "outline" {
  if (status === "passed") return "default";
  if (status === "running") return "secondary";
  if (status === "waiting_approval") return "warning";
  if (status === "failed") return "destructive";
  return "outline";
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

export function StudioLiveRunsTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly snapshot: PmWorkspacePipelinesSnapshot | null;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const runsQuery = usePipelineRuns(props.environmentId, props.projectId);
  const runs = runsQuery.data ?? [];

  const [pipelineName, setPipelineName] = useState<string>("website-studio");
  const [goal, setGoal] = useState<string>("");
  const [budgetText, setBudgetText] = useState<string>("2.50");
  const [launching, setLaunching] = useState(false);
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState<string>("");

  const availablePipelines = props.snapshot?.pipelines ?? [];
  const effectivePipelineName =
    availablePipelines.find((entry) => entry.pipeline.name === pipelineName)?.pipeline.name ??
    availablePipelines[0]?.pipeline.name ??
    pipelineName;

  const hasActiveRun = runs.some(
    (run) => run.status === "running" || run.status === "waiting_approval",
  );
  const refresh = runsQuery.refresh;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls live tracked pipeline runs while active
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => {
      refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, refresh]);

  const handleLaunchRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (launching || !effectivePipelineName) return;
    const parsedBudget = Number(budgetText);
    const budgetUsd =
      budgetText.trim().length > 0 && Number.isFinite(parsedBudget) && parsedBudget > 0
        ? parsedBudget
        : null;

    setLaunching(true);
    const created = await runPmCommand(
      pmCommands.pipelineRunStart,
      {
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          pipelineName: effectivePipelineName,
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          budgetUsd,
        },
      },
      gt("Could not start tracked pipeline run"),
    ).catch(() => null);
    setLaunching(false);

    if (created !== null) {
      setGoal("");
      refresh();
      toastManager.add({
        type: "success",
        title: gt("Pipeline run started"),
        description: gt("Tracking {pipeline} with live cost and stage nodes.", {
          pipeline: created.pipelineName,
        }),
      });
    }
  };

  const handleStageDecision = async (
    run: PmPipelineRun,
    stage: PmPipelineStageRun,
    decision: "approve" | "reject",
  ) => {
    const key = `${run.runId}:${stage.stageId}:${decision}`;
    if (decidingKey !== null) return;
    setDecidingKey(key);
    const updated = await runPmCommand(
      pmCommands.pipelineStageDecide,
      {
        environmentId: props.environmentId,
        input: {
          runId: run.runId,
          stageId: stage.stageId,
          decision,
          ...(decisionNote.trim() ? { note: decisionNote.trim() } : {}),
        },
      },
      gt("Could not submit stage decision"),
    ).catch(() => null);
    setDecidingKey(null);
    if (updated !== null) {
      setDecisionNote("");
      refresh();
    }
  };

  const openThread = (threadId: PmPipelineRun["pmThreadId"]) => {
    if (!threadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  return (
    <div className="space-y-5">
      <form
        aria-labelledby="start-live-run-heading"
        onSubmit={(event) => void handleLaunchRun(event)}
        className="rounded-xl border border-border bg-card p-4"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="start-live-run-heading" className="text-sm font-semibold text-foreground">
              <T>Launch Tracked Pipeline Run</T>
            </h2>
            <p className="text-xs text-muted-foreground">
              <T>
                Starts a PM-coordinated run with live stage status, token spend, prompt cache hit
                rate, frontier savings, and an optional USD budget guardrail.
              </T>
            </p>
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={() => refresh()}>
            <RefreshCwIcon className="size-3.5" aria-hidden />
            <T>Refresh</T>
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[220px_minmax(0,1fr)_140px_auto] sm:items-end">
          <div className="space-y-1">
            <label htmlFor="live-run-pipeline" className="text-xs font-medium text-foreground">
              <T>Pipeline</T>
            </label>
            <select
              id="live-run-pipeline"
              value={effectivePipelineName}
              onChange={(event) => setPipelineName(event.target.value)}
              className={FIELD_CLASS}
            >
              {availablePipelines.map((entry) => (
                <option key={entry.pipeline.name} value={entry.pipeline.name}>
                  {entry.pipeline.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="live-run-goal" className="text-xs font-medium text-foreground">
              <T>Goal / feature brief</T>
            </label>
            <Input
              id="live-run-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder={gt(
                "e.g. Build SaaS pricing page + interactive calculator + responsive nav",
              )}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="live-run-budget" className="text-xs font-medium text-foreground">
              <T>Budget cap (USD)</T>
            </label>
            <Input
              id="live-run-budget"
              type="number"
              step="0.25"
              min="0"
              value={budgetText}
              onChange={(event) => setBudgetText(event.target.value)}
              placeholder={gt("Optional")}
            />
          </div>

          <Button type="submit" size="sm" disabled={launching || !effectivePipelineName}>
            <PlayIcon className="size-3.5" aria-hidden />
            {launching ? gt("Starting...") : gt("Start Tracked Run")}
          </Button>
        </div>
      </form>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <T>
            No tracked pipeline runs yet. Start one above or kick off a pipeline in any PM chat.
          </T>
        </div>
      ) : (
        <div className="space-y-4">
          {runs.map((run) => {
            const budgetRatio =
              run.budgetUsd !== null && run.budgetUsd > 0
                ? Math.min(100, Math.round((run.spentUsd / run.budgetUsd) * 100))
                : null;
            return (
              <article
                key={run.runId}
                className="space-y-4 rounded-xl border border-border bg-card p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ActivityIcon className="size-4 text-primary" aria-hidden />
                      <h3 className="text-sm font-semibold text-foreground">{run.pipelineName}</h3>
                      <Badge variant={runBadgeVariant(run.status)} size="sm">
                        {run.status}
                      </Badge>
                      <span className="font-mono text-2xs text-muted-foreground">{run.runId}</span>
                    </div>
                    {run.goal ? <p className="text-xs text-muted-foreground">{run.goal}</p> : null}
                  </div>

                  {run.pmThreadId ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => openThread(run.pmThreadId)}
                    >
                      <T>Open PM Thread</T>
                      <ArrowUpRightIcon className="size-3" aria-hidden />
                    </Button>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="rounded-lg border border-border/80 bg-background/70 px-3 py-2">
                    <div className="flex items-center gap-1 text-2xs text-muted-foreground">
                      <DollarSignIcon className="size-3" aria-hidden />
                      <T>Actual Spend</T>
                    </div>
                    <p className="mt-0.5 text-sm font-semibold text-foreground">
                      {formatUsd(run.spentUsd)}
                    </p>
                  </div>

                  <div className="rounded-lg border border-border/80 bg-background/70 px-3 py-2">
                    <div className="text-2xs text-muted-foreground">
                      <T>All-Frontier Baseline</T>
                    </div>
                    <p className="mt-0.5 text-sm font-semibold text-foreground">
                      {formatUsd(run.baselineFrontierUsd)}
                    </p>
                  </div>

                  <div className="rounded-lg border border-border/80 bg-background/70 px-3 py-2">
                    <div className="text-2xs text-muted-foreground">
                      <T>Routing Savings</T>
                    </div>
                    <p className="mt-0.5 text-sm font-semibold text-primary">
                      {run.savingsPercent}%
                    </p>
                  </div>

                  <div className="rounded-lg border border-border/80 bg-background/70 px-3 py-2">
                    <div className="text-2xs text-muted-foreground">
                      <T>Prompt Cache Hit</T>
                    </div>
                    <p className="mt-0.5 text-sm font-semibold text-foreground">
                      {run.cacheHitPercent}%
                    </p>
                  </div>
                </div>

                {run.budgetUsd !== null ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-2xs text-muted-foreground">
                      <span>
                        <T>
                          Budget Cap: <Var>{formatUsd(run.spentUsd)}</Var> /{" "}
                          <Var>{formatUsd(run.budgetUsd)}</Var>
                        </T>
                      </span>
                      <span>{budgetRatio ?? 0}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full transition-all",
                          run.status === "budget_paused" ? "bg-warning" : "bg-primary",
                        )}
                        style={{ width: `${budgetRatio ?? 0}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                <ol
                  aria-label={gt("Live execution stages")}
                  className="flex flex-wrap items-stretch gap-2.5"
                >
                  {run.stages.map((stage, index) => (
                    <li key={stage.stageId} className="flex items-center gap-2">
                      <div
                        className={cn(
                          "flex w-60 flex-col gap-1.5 rounded-lg border p-3 transition",
                          stageBorderClass(stage.status),
                        )}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-xs font-semibold text-foreground">
                            {index + 1}. {stage.stageId}
                          </span>
                          <Badge variant={stageBadgeVariant(stage.status)} size="sm">
                            {stage.status}
                          </Badge>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                          <Badge variant="outline" size="sm">
                            {stage.roleName}
                          </Badge>
                          {stage.tier ? <span>{stage.tier}</span> : null}
                          <span className="flex items-center gap-0.5">
                            <ClockIcon className="size-2.5" aria-hidden />
                            {formatDuration(stage.durationMs)}
                          </span>
                        </div>

                        {stage.providerModel ? (
                          <div className="flex items-center gap-1 text-2xs text-muted-foreground">
                            <CpuIcon className="size-3 shrink-0" aria-hidden />
                            <span className="truncate">{stage.providerModel}</span>
                          </div>
                        ) : null}

                        <div className="text-2xs text-muted-foreground">
                          <T>
                            <Var>{(stage.inputTokens + stage.outputTokens).toLocaleString()}</Var>{" "}
                            tok · <Var>{formatUsd(stage.costUsd)}</Var>
                          </T>
                        </div>

                        {stage.summary ? (
                          <p className="line-clamp-2 text-2xs text-foreground">{stage.summary}</p>
                        ) : null}

                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          {stage.workerThreadId ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={() => openThread(stage.workerThreadId)}
                            >
                              <T>Worker</T>
                              <ArrowUpRightIcon className="size-3" aria-hidden />
                            </Button>
                          ) : null}

                          {stage.status === "waiting_approval" ? (
                            <>
                              <Button
                                type="button"
                                size="xs"
                                disabled={decidingKey !== null}
                                onClick={() => void handleStageDecision(run, stage, "approve")}
                              >
                                <CheckCircle2Icon className="size-3" aria-hidden />
                                <T>Approve</T>
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                disabled={decidingKey !== null}
                                onClick={() => void handleStageDecision(run, stage, "reject")}
                              >
                                <XCircleIcon className="size-3" aria-hidden />
                                <T>Reject</T>
                              </Button>
                            </>
                          ) : null}

                          {stage.status === "running" && run.status === "waiting_approval" ? (
                            <ShieldCheckIcon
                              className="size-3.5 text-warning-foreground"
                              aria-hidden
                            />
                          ) : null}
                        </div>
                      </div>
                      {index < run.stages.length - 1 ? (
                        <ArrowRightIcon
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      ) : null}
                    </li>
                  ))}
                </ol>

                {run.status === "waiting_approval" ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5">
                    <label htmlFor={`decide-note-${run.runId}`} className="sr-only">
                      <T>Optional approval note</T>
                    </label>
                    <Input
                      id={`decide-note-${run.runId}`}
                      value={decisionNote}
                      onChange={(event) => setDecisionNote(event.target.value)}
                      placeholder={gt("Optional approval or rejection feedback note...")}
                      className="max-w-md"
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
