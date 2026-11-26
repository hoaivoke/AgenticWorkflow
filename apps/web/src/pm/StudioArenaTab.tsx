import type {
  EnvironmentId,
  ModelSelection,
  PmAppVerifyTargetKind,
  PmEvalArmMetrics,
  PmWorkspacePipelinesSnapshot,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  PlayIcon,
  RefreshCwIcon,
  ScaleIcon,
  ShieldCheckIcon,
  Trash2Icon,
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
import { pmCommands, useEvalRuns } from "./state";

const SELECT_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";

function parseLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function ArmColumn(props: {
  readonly label: string;
  readonly arm: PmEvalArmMetrics;
  readonly highlightSavings?: number | null;
  readonly onOpenThread: (threadId: PmEvalArmMetrics["threadId"]) => void;
}) {
  const gt = useGT();
  const totalTokens = props.arm.inputTokens + props.arm.outputTokens;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-background/70 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-foreground">{props.label}</p>
          <p className="truncate font-mono text-2xs text-muted-foreground">
            {props.arm.modelLabel}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {props.highlightSavings !== undefined &&
          props.highlightSavings !== null &&
          props.highlightSavings < 0 ? (
            <Badge variant="default" size="sm">
              {Math.abs(props.highlightSavings)}% {gt("cheaper")}
            </Badge>
          ) : null}
          <Badge variant={props.arm.status === "running" ? "secondary" : "outline"} size="sm">
            {props.arm.status}
          </Badge>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-2xs text-muted-foreground">
            <T>Est. Cost</T>
          </dt>
          <dd className="font-semibold text-foreground">
            ${props.arm.estimatedCostUsd.toFixed(4)}
          </dd>
        </div>
        <div>
          <dt className="text-2xs text-muted-foreground">
            <T>Tokens (Cache Hit)</T>
          </dt>
          <dd className="font-medium text-foreground">
            {totalTokens.toLocaleString()} ({props.arm.cacheHitPercent}%)
          </dd>
        </div>
        <div>
          <dt className="text-2xs text-muted-foreground">
            <T>Wall Time</T>
          </dt>
          <dd className="font-medium text-foreground">{formatDuration(props.arm.durationMs)}</dd>
        </div>
        <div>
          <dt className="text-2xs text-muted-foreground">
            <T>Follow-ups / Git Diff</T>
          </dt>
          <dd className="font-medium text-foreground">
            {props.arm.humanInterventions} · {props.arm.filesChanged}f (+{props.arm.insertions}/-
            {props.arm.deletions})
          </dd>
        </div>
      </dl>

      {props.arm.verify ? (
        <div
          className={cn(
            "rounded-md border px-2.5 py-2 text-2xs",
            props.arm.verify.passed
              ? "border-primary/40 bg-primary/5 text-foreground"
              : "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          <div className="flex items-center gap-1.5 font-medium">
            {props.arm.verify.passed ? (
              <CheckCircle2Icon className="size-3.5 text-primary" aria-hidden />
            ) : (
              <XCircleIcon className="size-3.5 text-destructive" aria-hidden />
            )}
            <span>{props.arm.verify.summary}</span>
          </div>
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">
          <T>Not verified yet. Click Verify Both Arms once both finishes.</T>
        </p>
      )}

      {props.arm.threadId ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => props.onOpenThread(props.arm.threadId)}
          >
            <T>Open Thread</T>
            <ArrowUpRightIcon className="size-3" aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function StudioArenaTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly snapshot: PmWorkspacePipelinesSnapshot | null;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const evalsQuery = useEvalRuns(props.environmentId, props.projectId);
  const evals = evalsQuery.data ?? [];

  const [title, setTitle] = useState<string>("");
  const [targetKind, setTargetKind] = useState<PmAppVerifyTargetKind>("website");
  const [prompt, setPrompt] = useState<string>("");
  const [baselineModelKey, setBaselineModelKey] = useState<string>("");
  const [treatmentPipeline, setTreatmentPipeline] = useState<string>("website-studio");
  const [verifyCommandsText, setVerifyCommandsText] = useState<string>("");
  const [verifyStartCommand, setVerifyStartCommand] = useState<string>("");
  const [verifyUrl, setVerifyUrl] = useState<string>("");
  const [launching, setLaunching] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const modelOptions: Array<{
    readonly key: string;
    readonly label: string;
    readonly instanceId: string;
    readonly model: string;
  }> = [];
  for (const provider of props.snapshot?.providers ?? []) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      modelOptions.push({
        key: `${provider.instanceId}::${model.slug}`,
        label: `${provider.displayName ?? provider.driver} · ${model.name}`,
        instanceId: provider.instanceId,
        model: model.slug,
      });
    }
  }
  const preferredBaseline =
    modelOptions.find((opt) => opt.model.toLowerCase().includes("opus")) ?? modelOptions[0] ?? null;
  const activeBaselineOption =
    modelOptions.find((opt) => opt.key === baselineModelKey) ?? preferredBaseline;

  const pipelines = props.snapshot?.pipelines ?? [];
  const effectivePipeline =
    pipelines.find((entry) => entry.pipeline.name === treatmentPipeline)?.pipeline.name ??
    pipelines[0]?.pipeline.name ??
    "website-studio";

  const hasRunningEval = evals.some((entry) => entry.status === "running");
  const refresh = evalsQuery.refresh;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls running A/B evals for token and diff telemetry
  useEffect(() => {
    if (!hasRunningEval) return;
    const timer = window.setInterval(() => {
      refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [hasRunningEval, refresh]);

  const handleLaunchEval = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (launching || !prompt.trim() || !title.trim() || !activeBaselineOption) return;
    setLaunching(true);

    const baselineModelSelection: ModelSelection = {
      instanceId: activeBaselineOption.instanceId as ProviderInstanceId,
      model: activeBaselineOption.model,
    };
    const commands = parseLines(verifyCommandsText);
    const created = await runPmCommand(
      pmCommands.evalRunStart,
      {
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          title: title.trim(),
          prompt: prompt.trim(),
          targetKind,
          baselineModelSelection,
          treatmentPipeline: effectivePipeline,
          ...(commands.length > 0 ? { verifyCommands: commands } : {}),
          ...(verifyStartCommand.trim() ? { verifyStartCommand: verifyStartCommand.trim() } : {}),
          ...(verifyUrl.trim() ? { verifyUrl: verifyUrl.trim() } : {}),
        },
      },
      gt("Could not start A/B eval"),
    ).catch(() => null);
    setLaunching(false);

    if (created !== null) {
      setTitle("");
      setPrompt("");
      refresh();
      toastManager.add({
        type: "success",
        title: gt("A/B Eval launched in isolated worktrees"),
        description: gt("Compare raw single-model vs {pipeline} side-by-side.", {
          pipeline: effectivePipeline,
        }),
      });
    }
  };

  const handleVerifyBoth = async (evalId: string) => {
    if (verifyingId !== null) return;
    setVerifyingId(evalId);
    const updated = await runPmCommand(
      pmCommands.evalRunVerify,
      {
        environmentId: props.environmentId,
        input: { evalId },
      },
      gt("Could not verify eval arms"),
    ).catch(() => null);
    setVerifyingId(null);
    if (updated !== null) {
      refresh();
    }
  };

  const handleDeleteEval = async (evalId: string) => {
    const ok = await runPmCommand(
      pmCommands.evalRunDelete,
      {
        environmentId: props.environmentId,
        input: { evalId },
      },
      gt("Could not delete eval"),
    ).catch(() => null);
    if (ok !== null) refresh();
  };

  const openThread = (threadId: PmEvalArmMetrics["threadId"]) => {
    if (!threadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  return (
    <div className="space-y-5">
      <form
        aria-labelledby="arena-launch-heading"
        onSubmit={(event) => void handleLaunchEval(event)}
        className="space-y-4 rounded-xl border border-border bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <div>
            <h2 id="arena-launch-heading" className="text-sm font-semibold text-foreground">
              <T>A/B Eval Arena: Raw Single Model vs Agent Space Pipeline</T>
            </h2>
            <p className="text-xs text-muted-foreground">
              <T>
                Sends one identical prompt to a raw frontier model AND your custom pipeline in two
                isolated git worktrees, then measures cost, tokens, cache rate, git diff, and
                automated verification.
              </T>
            </p>
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={() => refresh()}>
            <RefreshCwIcon className="size-3.5" aria-hidden />
            <T>Refresh</T>
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <label htmlFor="eval-title" className="text-xs font-medium text-foreground">
              <T>Eval name</T>
            </label>
            <Input
              id="eval-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={gt("SaaS Pricing + Nav")}
              required
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="eval-target-kind" className="text-xs font-medium text-foreground">
              <T>Project / app type</T>
            </label>
            <select
              id="eval-target-kind"
              value={targetKind}
              onChange={(event) => {
                const nextKind = event.target.value as PmAppVerifyTargetKind;
                setTargetKind(nextKind);
                setTreatmentPipeline(nextKind === "website" ? "website-studio" : "app-studio");
              }}
              className={SELECT_CLASS}
            >
              <option value="website">{gt("Website / Landing Page")}</option>
              <option value="web_app">{gt("Web App")}</option>
              <option value="fullstack_app">{gt("Full-Stack / Desktop App")}</option>
              <option value="cli_or_api">{gt("CLI Tool or Backend API")}</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="eval-baseline-model" className="text-xs font-medium text-foreground">
              <T>Baseline arm (Raw single model)</T>
            </label>
            <select
              id="eval-baseline-model"
              value={activeBaselineOption?.key ?? ""}
              onChange={(event) => setBaselineModelKey(event.target.value)}
              className={SELECT_CLASS}
            >
              {modelOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="eval-treatment-pipeline"
              className="text-xs font-medium text-foreground"
            >
              <T>Treatment arm (Harness + Pipeline)</T>
            </label>
            <select
              id="eval-treatment-pipeline"
              value={effectivePipeline}
              onChange={(event) => setTreatmentPipeline(event.target.value)}
              className={SELECT_CLASS}
            >
              {pipelines.map((entry) => (
                <option key={entry.pipeline.name} value={entry.pipeline.name}>
                  {entry.pipeline.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="eval-prompt" className="text-xs font-medium text-foreground">
            <T>Shared prompt sent identically to both worktrees</T>
          </label>
          <textarea
            id="eval-prompt"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={gt(
              "Build a responsive SaaS landing page with interactive pricing calculator, dark/light mode, accessible contact form, and passing tests.",
            )}
            className={TEXTAREA_CLASS}
            required
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="eval-verify-cmds" className="text-xs font-medium text-foreground">
              <T>Verify commands (optional, 1 per line)</T>
            </label>
            <textarea
              id="eval-verify-cmds"
              rows={2}
              value={verifyCommandsText}
              onChange={(event) => setVerifyCommandsText(event.target.value)}
              placeholder={gt("Auto-detects package.json scripts when blank")}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className={cn(TEXTAREA_CLASS, "font-mono text-xs")}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="eval-verify-start" className="text-xs font-medium text-foreground">
              <T>Dev server start command (optional)</T>
            </label>
            <Input
              id="eval-verify-start"
              value={verifyStartCommand}
              onChange={(event) => setVerifyStartCommand(event.target.value)}
              placeholder={gt("pnpm dev --port 4173")}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="eval-verify-url" className="text-xs font-medium text-foreground">
              <T>Live URL to screenshot & audit (optional)</T>
            </label>
            <Input
              id="eval-verify-url"
              value={verifyUrl}
              onChange={(event) => setVerifyUrl(event.target.value)}
              placeholder={gt("http://127.0.0.1:4173")}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={launching || activeBaselineOption === null}>
            <PlayIcon className="size-3.5" aria-hidden />
            {launching ? gt("Launching A/B Arms...") : gt("Run A/B Eval")}
          </Button>
        </div>
      </form>

      {evals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <T>
            No A/B evaluations yet. Launch one above to benchmark a pipeline against raw prompts.
          </T>
        </div>
      ) : (
        <div className="space-y-4">
          {evals.map((entry) => (
            <article
              key={entry.evalId}
              className="space-y-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <ScaleIcon className="size-4 text-primary" aria-hidden />
                    <h3 className="text-sm font-semibold text-foreground">{entry.title}</h3>
                    <Badge variant="outline" size="sm">
                      {entry.targetKind}
                    </Badge>
                    <Badge variant={entry.status === "running" ? "secondary" : "default"} size="sm">
                      {entry.status}
                    </Badge>
                    {entry.costDeltaPercent !== null ? (
                      <Badge variant="info" size="sm">
                        <T>
                          Cost delta: <Var>{entry.costDeltaPercent > 0 ? "+" : ""}</Var>
                          <Var>{entry.costDeltaPercent}</Var>%
                        </T>
                      </Badge>
                    ) : null}
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{entry.prompt}</p>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={verifyingId !== null}
                    onClick={() => void handleVerifyBoth(entry.evalId)}
                  >
                    <ShieldCheckIcon className="size-3.5" aria-hidden />
                    {verifyingId === entry.evalId ? gt("Verifying...") : gt("Verify Both Arms")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={gt("Delete eval {title}", { title: entry.title })}
                    onClick={() => void handleDeleteEval(entry.evalId)}
                  >
                    <Trash2Icon className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <ArmColumn
                  label={gt("Arm A · Raw Single Model")}
                  arm={entry.baseline}
                  onOpenThread={openThread}
                />
                <ArmColumn
                  label={gt("Arm B · Agent Space ({pipeline})", {
                    pipeline: entry.treatmentPipeline,
                  })}
                  arm={entry.treatment}
                  highlightSavings={entry.costDeltaPercent}
                  onOpenThread={openThread}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
