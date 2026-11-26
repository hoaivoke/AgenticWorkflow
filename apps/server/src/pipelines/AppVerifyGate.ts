// pipelines: zero-token app & website verification gate (shell checks, live server probes, visual screenshots & DOM a11y).
// @effect-diagnostics-next-line nodeBuiltinImport:off - dev server cleanup uses detached process-group SIGTERM.
import * as NodeChildProcess from "node:child_process";

import {
  PmError,
  type PmAppVerifyA11yIssue,
  type PmAppVerifyCheck,
  type PmAppVerifyReport,
  type PmAppVerifyScreenshot,
  type PmAppVerifyTargetKind,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const CHECK_TIMEOUT = "10 minutes";
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_SUMMARY_LINES = 25;
const SERVER_POLL_TIMEOUT_MS = 20_000;
const SERVER_POLL_INTERVAL_MS = 400;

const PackageScriptsSchema = Schema.fromJsonString(
  Schema.Struct({
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const decodePackageScripts = Schema.decodeUnknownEffect(PackageScriptsSchema);

const isInsideRoot = (path: Path.Path, root: string, candidate: string): boolean => {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const summarizeOutput = (stdout: string, stderr: string): string => {
  const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  if (!combined) return "";
  return combined
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, MAX_SUMMARY_LINES)
    .join("\n");
};

const safeRouteSlug = (route: string): string => {
  const cleaned = route
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "home";
};

const waitMs = (ms: number) => Effect.sleep(Duration.millis(ms));

const PAGE_AUDIT_SCRIPT = `(() => {
  const doc = document;
  const overflow = doc.documentElement.scrollWidth > window.innerWidth + 2;
  const imgsWithoutAlt = Array.from(doc.querySelectorAll("img")).filter(
    (img) => !img.hasAttribute("alt"),
  ).length;
  const inputsWithoutLabel = Array.from(
    doc.querySelectorAll("input, select, textarea"),
  ).filter((el) => {
    if (el.tagName === "INPUT" && el.getAttribute("type") === "hidden") return false;
    const hasAria = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
    const id = el.getAttribute("id") || "";
    const hasFor =
      id.length > 0 &&
      typeof CSS !== "undefined" &&
      doc.querySelector('label[for="' + CSS.escape(id) + '"]') !== null;
    const wrapped = el.closest("label") !== null;
    return !hasAria && !hasFor && !wrapped;
  }).length;
  const buttonsWithoutName = Array.from(doc.querySelectorAll("button")).filter((btn) => {
    const text = (btn.textContent || "").trim();
    const hasAria = btn.hasAttribute("aria-label") || btn.hasAttribute("aria-labelledby");
    return text.length === 0 && !hasAria;
  }).length;
  const h1Count = doc.querySelectorAll("h1").length;
  return { overflow, imgsWithoutAlt, inputsWithoutLabel, buttonsWithoutName, h1Count };
})()`;

const CHROME_CANDIDATES_BY_PLATFORM: Partial<Record<NodeJS.Platform, ReadonlyArray<string>>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

interface BrowserAuditOutput {
  readonly browserUsed: boolean;
  readonly browserNote: string | null;
  readonly screenshots: ReadonlyArray<PmAppVerifyScreenshot>;
  readonly consoleErrors: ReadonlyArray<string>;
  readonly a11yIssues: ReadonlyArray<PmAppVerifyA11yIssue>;
}

interface PlaywrightPage {
  on: (event: string, listener: (arg: unknown) => void) => void;
  setViewportSize: (size: { width: number; height: number }) => Promise<void>;
  goto: (url: string, opts: { waitUntil: string; timeout: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  evaluate: <R>(fnOrExpression: string) => Promise<R>;
  screenshot: (opts: { path: string; fullPage: boolean }) => Promise<unknown>;
}

interface PlaywrightBrowser {
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
}

interface PlaywrightCoreModule {
  chromium?: {
    executablePath?: () => string;
    launch: (opts: { executablePath?: string; headless: boolean }) => Promise<PlaywrightBrowser>;
  };
}

const findChromeExecutable = Effect.fn("AppVerifyGate.findChromeExecutable")(function* (
  platform: NodeJS.Platform,
  bundledPath: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const candidates = [...(CHROME_CANDIDATES_BY_PLATFORM[platform] ?? [])];
  if (bundledPath) candidates.push(bundledPath);
  for (const candidate of candidates) {
    const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return undefined;
});

const runBrowserAudit = Effect.fn("AppVerifyGate.runBrowserAudit")(function* (input: {
  readonly baseUrl: string;
  readonly routes: ReadonlyArray<string>;
  readonly screenshotDir: string | null;
  readonly workspaceRoot: string;
  readonly platform: NodeJS.Platform;
}): Effect.fn.Return<BrowserAuditOutput, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const loadedPw = yield* Effect.tryPromise({
    try: () => import("playwright-core") as Promise<PlaywrightCoreModule>,
    catch: () =>
      new PmError({
        code: "unavailable",
        message: "playwright-core is unavailable in this environment.",
      }),
  }).pipe(Effect.option);

  if (Option.isNone(loadedPw) || !loadedPw.value.chromium) {
    return {
      browserUsed: false,
      browserNote: "playwright-core is unavailable in this environment; skipped visual audit.",
      screenshots: [],
      consoleErrors: [],
      a11yIssues: [],
    };
  }

  const chromium = loadedPw.value.chromium;
  const bundledExecutable = yield* Effect.try({
    try: () => chromium.executablePath?.(),
    catch: () =>
      new PmError({
        code: "unavailable",
        message: "Could not resolve bundled Chromium executable path.",
      }),
  }).pipe(Effect.orElseSucceed(() => undefined));
  const executablePath = yield* findChromeExecutable(input.platform, bundledExecutable);
  if (executablePath === undefined) {
    return {
      browserUsed: false,
      browserNote: "No local Chrome/Chromium binary found; HTTP route checks still ran.",
      screenshots: [],
      consoleErrors: [],
      a11yIssues: [],
    };
  }

  if (input.screenshotDir !== null) {
    yield* fs.makeDirectory(input.screenshotDir, { recursive: true }).pipe(Effect.ignore);
  }

  const auditResult = yield* Effect.tryPromise({
    try: async (): Promise<BrowserAuditOutput> => {
      const browser = await chromium.launch({ executablePath, headless: true });
      const screenshots: Array<PmAppVerifyScreenshot> = [];
      const consoleErrors: Array<string> = [];
      const a11yIssues: Array<PmAppVerifyA11yIssue> = [];
      const viewports = [
        { name: "desktop", width: 1440, height: 900 },
        { name: "mobile", width: 390, height: 844 },
      ] as const;

      try {
        const page = await browser.newPage();
        page.on("pageerror", (err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (message && consoleErrors.length < 30) consoleErrors.push(`pageerror: ${message}`);
        });
        page.on("console", (msg) => {
          const entry = msg as { type?: () => string; text?: () => string };
          if (entry.type?.() === "error") {
            const text = entry.text?.() ?? "";
            if (text && consoleErrors.length < 30) consoleErrors.push(`console.error: ${text}`);
          }
        });

        for (const route of input.routes) {
          const targetUrl = new URL(route, input.baseUrl).toString();
          for (const vp of viewports) {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
            await page.waitForTimeout(250);

            const inspection = await page.evaluate<{
              overflow: boolean;
              imgsWithoutAlt: number;
              inputsWithoutLabel: number;
              buttonsWithoutName: number;
              h1Count: number;
            }>(PAGE_AUDIT_SCRIPT);

            if (vp.name === "desktop") {
              if (inspection.imgsWithoutAlt > 0) {
                a11yIssues.push({
                  severity: "error",
                  route,
                  rule: "img-alt",
                  message: `${inspection.imgsWithoutAlt} <img> element(s) missing alt attribute.`,
                  count: inspection.imgsWithoutAlt,
                });
              }
              if (inspection.inputsWithoutLabel > 0) {
                a11yIssues.push({
                  severity: "error",
                  route,
                  rule: "form-label",
                  message: `${inspection.inputsWithoutLabel} form control(s) missing an accessible label.`,
                  count: inspection.inputsWithoutLabel,
                });
              }
              if (inspection.buttonsWithoutName > 0) {
                a11yIssues.push({
                  severity: "error",
                  route,
                  rule: "button-name",
                  message: `${inspection.buttonsWithoutName} <button> element(s) have no accessible name.`,
                  count: inspection.buttonsWithoutName,
                });
              }
              if (inspection.h1Count === 0) {
                a11yIssues.push({
                  severity: "warning",
                  route,
                  rule: "heading-h1",
                  message: "Page has no <h1> landmark heading.",
                  count: 1,
                });
              }
            }

            let savedPath = "(in-memory check)";
            if (input.screenshotDir !== null) {
              const absShot = path.join(
                input.screenshotDir,
                `${vp.name}-${safeRouteSlug(route)}.png`,
              );
              await page.screenshot({ path: absShot, fullPage: true });
              savedPath = path.relative(input.workspaceRoot, absShot);
            }
            screenshots.push({
              viewport: vp.name,
              route,
              path: savedPath,
              width: vp.width,
              height: vp.height,
              horizontalOverflow: inspection.overflow,
            });
          }
        }

        return {
          browserUsed: true,
          browserNote: null,
          screenshots,
          consoleErrors,
          a11yIssues,
        };
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
    catch: (error) =>
      new PmError({
        code: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      }),
  }).pipe(
    Effect.catch((reason) =>
      Effect.succeed<BrowserAuditOutput>({
        browserUsed: false,
        browserNote: `Browser audit failed cleanly: ${reason.message}`,
        screenshots: [],
        consoleErrors: [],
        a11yIssues: [],
      }),
    ),
  );

  return auditResult;
});

function terminateProcessTree(
  child: NodeChildProcess.ChildProcess,
  platform: NodeJS.Platform,
): void {
  if (child.pid === undefined) return;
  try {
    if (platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore already exited child
    }
  }
}

/**
 * Deterministic verification gate for websites and applications:
 * 1) shell checks (`lint`, `typecheck`, `build`, `test`, auto-detected from package.json when omitted),
 * 2) optional live server startup & HTTP route latency probes,
 * 3) optional Playwright headless desktop/mobile screenshots + console/overflow/DOM a11y checks.
 */
export const runAppVerifyGate = Effect.fn("AppVerifyGate.run")(function* (input: {
  readonly workspaceRoot: string;
  readonly targetKind: PmAppVerifyTargetKind;
  readonly cwd?: string | undefined;
  readonly commands?: ReadonlyArray<string> | undefined;
  readonly startCommand?: string | undefined;
  readonly url?: string | undefined;
  readonly routes?: ReadonlyArray<string> | undefined;
  readonly runFolder?: string | undefined;
}): Effect.fn.Return<PmAppVerifyReport, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = Option.getOrUndefined(yield* Effect.serviceOption(ProcessRunner.ProcessRunner));
  const platform = Option.getOrElse(yield* Effect.serviceOption(HostProcess.Platform), () =>
    HostProcess.Platform.defaultValue(),
  );

  const startedAtMs = yield* Clock.currentTimeMillis;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const root = path.resolve(input.workspaceRoot);
  const resolvedCwd = input.cwd ? path.resolve(root, input.cwd) : root;
  const workDir = isInsideRoot(path, root, resolvedCwd) ? resolvedCwd : root;
  const shell = platform === "win32" ? "cmd" : "sh";

  let commandsToRun = (input.commands ?? [])
    .map((cmd) => cmd.trim())
    .filter((cmd) => cmd.length > 0);
  if (commandsToRun.length === 0) {
    const pkgPath = path.join(workDir, "package.json");
    const pkgRaw = yield* fs.readFileString(pkgPath).pipe(Effect.orElseSucceed(() => null));
    if (pkgRaw !== null) {
      const parsed = yield* decodePackageScripts(pkgRaw).pipe(Effect.orElseSucceed(() => null));
      const scripts = parsed?.scripts ?? {};
      const detected: Array<string> = [];
      for (const scriptName of ["typecheck", "lint", "build", "test"]) {
        if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim().length > 0) {
          detected.push(`pnpm ${scriptName}`);
        }
      }
      commandsToRun = detected;
    }
  }

  const checks: Array<PmAppVerifyCheck> = [];
  for (const command of commandsToRun) {
    const cmdStart = yield* Clock.currentTimeMillis;
    if (runner === undefined) {
      checks.push({
        command,
        exitCode: 1,
        durationMs: 0,
        passed: false,
        summary: "ProcessRunner is unavailable in this environment.",
      });
      continue;
    }
    const args = platform === "win32" ? ["/c", command] : ["-lc", command];
    const outcome = yield* runner
      .run({
        command: shell,
        args,
        cwd: workDir,
        timeout: CHECK_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      })
      .pipe(
        Effect.map((out) => ({
          exitCode: out.timedOut ? 124 : out.code === null ? 1 : Number(out.code),
          summary: summarizeOutput(out.stdout, out.stderr),
        })),
        Effect.catch((error) =>
          Effect.succeed({
            exitCode: 1,
            summary: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    const cmdEnd = yield* Clock.currentTimeMillis;
    checks.push({
      command,
      exitCode: outcome.exitCode,
      durationMs: Math.max(0, cmdEnd - cmdStart),
      passed: outcome.exitCode === 0,
      summary: outcome.summary,
    });
  }

  const routes =
    input.routes && input.routes.length > 0
      ? input.routes.map((route) => (route.startsWith("/") ? route : `/${route}`))
      : ["/"];

  const resolvedFolder =
    input.runFolder && isInsideRoot(path, root, path.resolve(root, input.runFolder))
      ? path.resolve(root, input.runFolder)
      : null;

  const targetUrl = input.url?.trim() || undefined;
  const startCmd = input.startCommand?.trim() || undefined;

  const routesChecked: Array<{
    readonly route: string;
    readonly status: number;
    readonly ok: boolean;
    readonly latencyMs: number;
  }> = [];
  let browserOutput: BrowserAuditOutput = {
    browserUsed: false,
    browserNote:
      input.targetKind === "cli_or_api"
        ? "Skipped browser check for cli_or_api target."
        : targetUrl === undefined
          ? "No URL provided; skipped HTTP and browser audit."
          : null,
    screenshots: [],
    consoleErrors: [],
    a11yIssues: [],
  };

  if (targetUrl !== undefined) {
    let spawnedServer: NodeChildProcess.ChildProcess | undefined;
    if (startCmd !== undefined) {
      spawnedServer = NodeChildProcess.spawn(
        shell,
        platform === "win32" ? ["/c", startCmd] : ["-lc", startCmd],
        {
          cwd: workDir,
          detached: platform !== "win32",
          stdio: "ignore",
          env: { ...process.env, CI: "true" },
        },
      );
    }

    const probeLiveTarget = Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      let ready = startCmd === undefined;
      if (!ready) {
        const deadline = (yield* Clock.currentTimeMillis) + SERVER_POLL_TIMEOUT_MS;
        while ((yield* Clock.currentTimeMillis) < deadline) {
          const ok = yield* httpClient.get(targetUrl).pipe(
            Effect.map((res) => res.status > 0),
            Effect.orElseSucceed(() => false),
          );
          if (ok) {
            ready = true;
            break;
          }
          yield* waitMs(SERVER_POLL_INTERVAL_MS);
        }
      }

      if (!ready) {
        routesChecked.push({
          route: "/",
          status: 0,
          ok: false,
          latencyMs: SERVER_POLL_TIMEOUT_MS,
        });
        browserOutput = {
          ...browserOutput,
          browserNote: `Timed out waiting for server at ${targetUrl} after ${SERVER_POLL_TIMEOUT_MS}ms.`,
        };
        return;
      }

      for (const route of routes) {
        const probeUrl = new URL(route, targetUrl).toString();
        const t0 = yield* Clock.currentTimeMillis;
        const status = yield* httpClient.get(probeUrl).pipe(
          Effect.map((res) => res.status),
          Effect.orElseSucceed(() => 0),
        );
        const t1 = yield* Clock.currentTimeMillis;
        routesChecked.push({
          route,
          status,
          ok: status >= 200 && status < 400,
          latencyMs: Math.max(0, t1 - t0),
        });
      }

      if (input.targetKind !== "cli_or_api" && routesChecked.some((route) => route.ok)) {
        browserOutput = yield* runBrowserAudit({
          baseUrl: targetUrl,
          routes,
          screenshotDir: resolvedFolder === null ? null : path.join(resolvedFolder, "screenshots"),
          workspaceRoot: root,
          platform,
        });
      }
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (spawnedServer !== undefined) terminateProcessTree(spawnedServer, platform);
        }),
      ),
    );

    yield* probeLiveTarget;
  }

  const finishedAtMs = yield* Clock.currentTimeMillis;
  const hasFailedCheck = checks.some((check) => !check.passed);
  const hasFailedRoute = routesChecked.some((route) => !route.ok);
  const hasConsoleError = browserOutput.consoleErrors.length > 0;
  const hasOverflow = browserOutput.screenshots.some((shot) => shot.horizontalOverflow);
  const hasA11yError = browserOutput.a11yIssues.some((issue) => issue.severity === "error");
  const passed =
    !hasFailedCheck && !hasFailedRoute && !hasConsoleError && !hasOverflow && !hasA11yError;

  const summaryParts = [
    `${passed ? "PASS" : "FAIL"} (${checks.filter((c) => c.passed).length}/${checks.length} checks)`,
  ];
  if (routesChecked.length > 0) {
    summaryParts.push(
      `${routesChecked.filter((r) => r.ok).length}/${routesChecked.length} routes HTTP ok`,
    );
  }
  if (browserOutput.browserUsed) {
    summaryParts.push(
      `${browserOutput.screenshots.length} screenshots, ${browserOutput.consoleErrors.length} console errors, ${browserOutput.a11yIssues.length} a11y findings`,
    );
  } else if (browserOutput.browserNote) {
    summaryParts.push(browserOutput.browserNote);
  }
  const summary = summaryParts.join(" · ");

  let reportPath: string | null = null;
  if (resolvedFolder !== null) {
    const mdLines = [
      `# Verification Report (${passed ? "PASS" : "FAIL"})`,
      `- Target kind: ${input.targetKind}`,
      `- Checked at: ${checkedAt}`,
      `- Summary: ${summary}`,
      "",
      "## Shell Checks",
      ...(checks.length === 0
        ? ["- None"]
        : checks.map(
            (check) =>
              `- \`${check.command}\`: exit ${check.exitCode} (${check.durationMs}ms)${check.summary && !check.passed ? `\n  \`\`\`\n  ${check.summary}\n  \`\`\`` : ""}`,
          )),
      ...(routesChecked.length === 0
        ? []
        : [
            "",
            "## Routes",
            ...routesChecked.map(
              (route) => `- \`${route.route}\`: HTTP ${route.status} (${route.latencyMs}ms)`,
            ),
          ]),
      ...(browserOutput.a11yIssues.length === 0
        ? []
        : [
            "",
            "## Accessibility Findings",
            ...browserOutput.a11yIssues.map(
              (issue) => `- [${issue.severity}] ${issue.route} (${issue.rule}): ${issue.message}`,
            ),
          ]),
      ...(browserOutput.consoleErrors.length === 0
        ? []
        : ["", "## Console Errors", ...browserOutput.consoleErrors.map((err) => `- ${err}`)]),
    ];

    const report: PmAppVerifyReport = {
      passed,
      targetKind: input.targetKind,
      checkedAt,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      checks,
      routesChecked,
      screenshots: [...browserOutput.screenshots],
      consoleErrors: [...browserOutput.consoleErrors],
      a11yIssues: [...browserOutput.a11yIssues],
      browserUsed: browserOutput.browserUsed,
      browserNote: browserOutput.browserNote,
      reportPath: null,
      summary,
    };

    const jsonTarget = path.join(resolvedFolder, "verify-report.json");
    const mdTarget = path.join(resolvedFolder, "verify-report.md");
    // @effect-diagnostics-next-line globalJsonInEffect:off - serializes structured PmAppVerifyReport artifact to disk.
    const serializedJson = `${JSON.stringify(report, null, 2)}\n`;
    const wrote = yield* fs.makeDirectory(resolvedFolder, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(jsonTarget, serializedJson)),
      Effect.andThen(fs.writeFileString(mdTarget, `${mdLines.join("\n")}\n`)),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (wrote) reportPath = path.relative(root, mdTarget);
  }

  return {
    passed,
    targetKind: input.targetKind,
    checkedAt,
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    checks,
    routesChecked,
    screenshots: [...browserOutput.screenshots],
    consoleErrors: [...browserOutput.consoleErrors],
    a11yIssues: [...browserOutput.a11yIssues],
    browserUsed: browserOutput.browserUsed,
    browserNote: browserOutput.browserNote,
    reportPath,
    summary,
  };
});
