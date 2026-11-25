// pipelines: deterministic zero-token command execution for gatekeeper stages (`pm_run_gates`).
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

const GATE_TIMEOUT = "10 minutes";
const MAX_SUMMARY_LINES = 40;
const MAX_OUTPUT_BYTES = 128 * 1024;

export interface GateCommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly summary: string;
}

export interface RunGatesResult {
  readonly passed: boolean;
  readonly results: ReadonlyArray<GateCommandResult>;
  readonly gatesFile: string | null;
  readonly report: string;
}

function summarizeOutput(stdout: string, stderr: string): string {
  const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  if (!combined) return "";
  const lines = combined
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(0, MAX_SUMMARY_LINES).join("\n");
}

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Runs shell check commands directly without spawning an LLM worker. */
export const runDeterministicGates = Effect.fn("PipelineGateRunner.run")(function* (input: {
  readonly commands: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  readonly cwd?: string | undefined;
  readonly runFolder?: string | undefined;
}): Effect.fn.Return<RunGatesResult, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = Option.getOrUndefined(yield* Effect.serviceOption(ProcessRunner.ProcessRunner));
  const platform = Option.getOrElse(yield* Effect.serviceOption(HostProcess.Platform), () =>
    HostProcess.Platform.defaultValue(),
  );

  const root = path.resolve(input.workspaceRoot);
  const resolvedCwd = input.cwd ? path.resolve(root, input.cwd) : root;
  const workDir = isInsideRoot(path, root, resolvedCwd) ? resolvedCwd : root;
  const shell = platform === "win32" ? "cmd" : "sh";
  const results: Array<GateCommandResult> = [];

  for (const command of input.commands) {
    if (runner === undefined) {
      results.push({
        command,
        exitCode: 1,
        summary: "ProcessRunner is unavailable in this test/runtime environment.",
      });
      continue;
    }
    const args = platform === "win32" ? ["/c", command] : ["-lc", command];
    const outcome = yield* runner
      .run({
        command: shell,
        args,
        cwd: workDir,
        timeout: GATE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      })
      .pipe(
        Effect.map((out) => ({
          exitCode: out.timedOut ? 124 : out.code === null ? 1 : Number(out.code),
          summary: out.timedOut
            ? `Command timed out after ${GATE_TIMEOUT}.\n${summarizeOutput(out.stdout, out.stderr)}`.trim()
            : summarizeOutput(out.stdout, out.stderr),
        })),
        Effect.catch((error) =>
          Effect.succeed({
            exitCode: 1,
            summary: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    results.push({ command, exitCode: outcome.exitCode, summary: outcome.summary });
  }

  const passed = results.every((entry) => entry.exitCode === 0);
  let gatesFile: string | null = null;
  if (input.runFolder) {
    const folder = path.resolve(root, input.runFolder);
    if (isInsideRoot(path, root, folder)) {
      const target = path.join(folder, "gates.json");
      // @effect-diagnostics-next-line globalJsonInEffect:off - serializes structured GateCommandResult values.
      const serialized = `${JSON.stringify(results, null, 2)}\n`;
      const wrote = yield* fs.makeDirectory(folder, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(target, serialized)),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (wrote) gatesFile = target;
    }
  }

  const header = passed ? "PASS" : "FAIL";
  const lines = results.map(
    (entry) =>
      `- \`${entry.command}\`: exit ${entry.exitCode}${entry.exitCode === 0 ? "" : entry.summary ? `\n  ${entry.summary.replaceAll("\n", "\n  ")}` : ""}`,
  );
  return {
    passed,
    results,
    gatesFile,
    report: `${header} (${results.filter((r) => r.exitCode === 0).length}/${results.length} commands passed)${gatesFile ? `, wrote ${gatesFile}` : ""}\n${lines.join("\n")}`,
  };
});
