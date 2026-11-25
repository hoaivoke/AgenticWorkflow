import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { runDeterministicGates } from "./PipelineGateRunner.ts";

describe("runDeterministicGates", () => {
  it.effect(
    "runs shell checks directly, summarizes failures, and writes gates.json inside the workspace",
    () => {
      const written = new Map<string, string>();
      const runnerCalls: Array<string> = [];

      const layer = Layer.mergeAll(
        FileSystem.layerNoop({
          makeDirectory: () => Effect.void,
          writeFileString: (filePath, content) =>
            Effect.sync(() => {
              written.set(filePath, content);
            }),
        }),
        NodePath.layerPosix,
        Layer.succeed(HostProcess.Platform, "darwin"),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) =>
            Effect.sync(() => {
              const cmd = input.args[1] ?? "";
              runnerCalls.push(cmd);
              if (cmd.includes("lint")) {
                return {
                  stdout: "unused variable foo at line 12",
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(1),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }
              return {
                stdout: "ok",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      );

      return Effect.gen(function* () {
        const result = yield* runDeterministicGates({
          commands: ["pnpm typecheck", "pnpm lint"],
          workspaceRoot: "/repo",
          runFolder: ".pipelines/runs/run-1",
        });

        expect(runnerCalls).toEqual(["pnpm typecheck", "pnpm lint"]);
        expect(result.passed).toBe(false);
        expect(result.gatesFile).toBe("/repo/.pipelines/runs/run-1/gates.json");
        expect(result.report).toContain("FAIL (1/2 commands passed)");
        expect(result.report).toContain("unused variable foo at line 12");
        expect(JSON.parse(written.get("/repo/.pipelines/runs/run-1/gates.json")!)).toHaveLength(2);

        const escaped = yield* runDeterministicGates({
          commands: ["pnpm typecheck"],
          workspaceRoot: "/repo",
          runFolder: "../../etc/evil",
        });
        expect(escaped.passed).toBe(true);
        expect(escaped.gatesFile).toBeNull();
      }).pipe(Effect.provide(layer));
    },
  );
});
