import type {
  EnvironmentId,
  PmAppVerifyReport,
  PmAppVerifyTargetKind,
  ProjectId,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  CheckCircle2Icon,
  MonitorSmartphoneIcon,
  PlayIcon,
  ShieldCheckIcon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { cn } from "../lib/utils";
import { runPmCommand } from "./actions";
import { pmCommands } from "./state";

const FIELD_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground shadow-2xs transition focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";

function parseLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseCommaList(text: string): ReadonlyArray<string> {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function StudioVerifyTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const [targetKind, setTargetKind] = useState<PmAppVerifyTargetKind>("web_app");
  const [cwd, setCwd] = useState<string>("");
  const [commandsText, setCommandsText] = useState<string>("");
  const [startCommand, setStartCommand] = useState<string>("");
  const [url, setUrl] = useState<string>("");
  const [routesText, setRoutesText] = useState<string>("/");
  const [runFolder, setRunFolder] = useState<string>(".pipelines/runs/manual-verify");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<PmAppVerifyReport | null>(null);

  const handleRunVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running) return;
    setRunning(true);
    const commands = parseLines(commandsText);
    const routes = parseCommaList(routesText);

    const outcome = await runPmCommand(
      pmCommands.appVerifyRun,
      {
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          targetKind,
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          ...(commands.length > 0 ? { commands } : {}),
          ...(startCommand.trim() ? { startCommand: startCommand.trim() } : {}),
          ...(url.trim() ? { url: url.trim() } : {}),
          ...(routes.length > 0 ? { routes } : {}),
          ...(runFolder.trim() ? { runFolder: runFolder.trim() } : {}),
        },
      },
      gt("Verification gate failed to run"),
    ).catch(() => null);
    setRunning(false);

    if (outcome !== null) {
      setReport(outcome);
      toastManager.add({
        type: outcome.passed ? "success" : "error",
        title: outcome.passed ? gt("Verification passed") : gt("Verification found issues"),
        description: outcome.summary,
      });
    }
  };

  return (
    <div className="space-y-5">
      <form
        aria-labelledby="verify-gate-heading"
        onSubmit={(event) => void handleRunVerify(event)}
        className="space-y-4 rounded-xl border border-border bg-card p-4"
      >
        <div className="border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-primary" aria-hidden />
            <h2 id="verify-gate-heading" className="text-sm font-semibold text-foreground">
              <T>Zero-Token App & Website Verification Gate</T>
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <T>
              Runs build/lint/test commands directly without spending LLM tokens, probes live HTTP
              routes, and captures desktop (1440×900) & mobile (390×844) screenshots, console
              errors, and DOM accessibility findings for websites and web/desktop apps.
            </T>
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="verify-target-kind" className="text-xs font-medium text-foreground">
              <T>Target kind</T>
            </label>
            <select
              id="verify-target-kind"
              value={targetKind}
              onChange={(event) => setTargetKind(event.target.value as PmAppVerifyTargetKind)}
              className={FIELD_CLASS}
            >
              <option value="website">{gt("Website / Landing Page")}</option>
              <option value="web_app">{gt("Web App")}</option>
              <option value="fullstack_app">{gt("Full-Stack / Electron App")}</option>
              <option value="cli_or_api">{gt("CLI or Backend API (no browser)")}</option>
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="verify-cwd" className="text-xs font-medium text-foreground">
              <T>Working directory (relative, optional)</T>
            </label>
            <Input
              id="verify-cwd"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder={gt("Project root when blank")}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="verify-run-folder" className="text-xs font-medium text-foreground">
              <T>Artifact output folder</T>
            </label>
            <Input
              id="verify-run-folder"
              value={runFolder}
              onChange={(event) => setRunFolder(event.target.value)}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="verify-commands" className="text-xs font-medium text-foreground">
            <T>Shell check commands (one per line; blank auto-detects package.json scripts)</T>
          </label>
          <textarea
            id="verify-commands"
            rows={3}
            value={commandsText}
            onChange={(event) => setCommandsText(event.target.value)}
            placeholder={gt("pnpm typecheck\npnpm lint\npnpm test")}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className={cn(TEXTAREA_CLASS, "font-mono text-xs")}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="verify-start-command" className="text-xs font-medium text-foreground">
              <T>Temporary server start command (optional)</T>
            </label>
            <Input
              id="verify-start-command"
              value={startCommand}
              onChange={(event) => setStartCommand(event.target.value)}
              placeholder={gt("pnpm dev --port 4173")}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="verify-url" className="text-xs font-medium text-foreground">
              <T>Base URL to probe (optional)</T>
            </label>
            <Input
              id="verify-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={gt("http://127.0.0.1:4173")}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="verify-routes" className="text-xs font-medium text-foreground">
              <T>Routes (comma-separated)</T>
            </label>
            <Input
              id="verify-routes"
              value={routesText}
              onChange={(event) => setRoutesText(event.target.value)}
              placeholder={gt("/, /pricing")}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={running}>
            <PlayIcon className="size-3.5" aria-hidden />
            {running ? gt("Running Verification Gate...") : gt("Run Verification Gate")}
          </Button>
        </div>
      </form>

      {report ? (
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
            <div className="flex items-center gap-2">
              {report.passed ? (
                <CheckCircle2Icon className="size-5 text-primary" aria-hidden />
              ) : (
                <XCircleIcon className="size-5 text-destructive" aria-hidden />
              )}
              <h3 className="text-sm font-semibold text-foreground">{report.summary}</h3>
            </div>
            <Badge variant={report.passed ? "default" : "destructive"} size="sm">
              {report.passed ? gt("PASS") : gt("FAIL")}
            </Badge>
          </div>

          {report.checks.length > 0 ? (
            <div className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <TerminalIcon className="size-3.5" aria-hidden />
                <T>Shell Checks</T>
              </h4>
              <div className="space-y-2">
                {report.checks.map((check) => (
                  <div
                    key={check.command}
                    className={cn(
                      "rounded-lg border p-2.5 text-xs",
                      check.passed
                        ? "border-border bg-background/70"
                        : "border-destructive/50 bg-destructive/10",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <code className="font-mono text-foreground">{check.command}</code>
                      <Badge variant={check.passed ? "default" : "destructive"} size="sm">
                        exit {check.exitCode} ({check.durationMs}ms)
                      </Badge>
                    </div>
                    {check.summary && !check.passed ? (
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-2xs text-destructive">
                        {check.summary}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {report.routesChecked.length > 0 || report.screenshots.length > 0 ? (
            <div className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <MonitorSmartphoneIcon className="size-3.5" aria-hidden />
                <T>HTTP & Visual Viewport Checks</T>
              </h4>
              <div className="flex flex-wrap gap-2">
                {report.routesChecked.map((route) => (
                  <Badge key={route.route} variant={route.ok ? "outline" : "destructive"} size="sm">
                    {gt("{route} · HTTP {status} ({latency}ms)", {
                      route: route.route,
                      status: route.status,
                      latency: route.latencyMs,
                    })}
                  </Badge>
                ))}
                {report.screenshots.map((shot) => (
                  <Badge
                    key={`${shot.viewport}:${shot.route}`}
                    variant={shot.horizontalOverflow ? "destructive" : "secondary"}
                    size="sm"
                  >
                    {shot.viewport} {shot.width}×{shot.height} ·{" "}
                    {shot.horizontalOverflow ? gt("OVERFLOW") : gt("clean")}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {report.a11yIssues.length > 0 ? (
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <T>Accessibility Audit</T>
              </h4>
              <ul className="space-y-1 text-xs">
                {report.a11yIssues.map((issue) => (
                  <li
                    key={`${issue.route}:${issue.rule}`}
                    className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-warning-foreground"
                  >
                    <strong>[{issue.rule}]</strong> {issue.route}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {report.reportPath ? (
            <p className="font-mono text-2xs text-muted-foreground">
              <T>
                Saved report: <Var>{report.reportPath}</Var>
              </T>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
