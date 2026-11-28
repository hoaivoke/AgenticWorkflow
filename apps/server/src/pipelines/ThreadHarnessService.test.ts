import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PipelineService from "./PipelineService.ts";
import * as ThreadHarnessService from "./ThreadHarnessService.ts";
import * as ThreadHarnessStore from "./ThreadHarnessStore.ts";

const NOW = DateTime.makeUnsafe("2026-11-26T00:00:00.000Z");

const baseTurnItem = {
  id: TurnItemId.make("item-1"),
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  nodeId: NodeId.make("node-1"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: NOW,
  completedAt: NOW,
  updatedAt: NOW,
};

describe("ThreadHarnessService", () => {
  it("extracts skills and trackable context files from command, file change, and tool items", () => {
    const cmdItem: OrchestrationV2TurnItem = {
      ...baseTurnItem,
      type: "command_execution",
      input: "cat /repo/.pipelines/skills/modern-web/SKILL.md && cat /repo/AGENTS.md",
      exitCode: 0,
    };
    expect(ThreadHarnessService.extractProvenanceFromTurnItem(cmdItem, "/repo")).toEqual({
      skills: ["modern-web"],
      contextFiles: ["AGENTS.md"],
    });

    const editItem: OrchestrationV2TurnItem = {
      ...baseTurnItem,
      type: "file_change",
      fileName: "/repo/docs/architecture.md",
      changes: [
        { operation: "modify", path: "/repo/.pipelines/runs/01/spec.md" },
        { operation: "modify", path: "/repo/node_modules/pkg/README.md" },
      ],
    };
    expect(ThreadHarnessService.extractProvenanceFromTurnItem(editItem, "/repo")).toEqual({
      skills: [],
      contextFiles: ["docs/architecture.md", ".pipelines/runs/01/spec.md"],
    });

    const toolItem: OrchestrationV2TurnItem = {
      ...baseTurnItem,
      type: "dynamic_tool",
      toolName: "read_file",
      input: { path: "/Users/me/.gemini/skills/ui-polish/SKILL.md", ref: "/repo/CLAUDE.md" },
    };
    expect(ThreadHarnessService.extractProvenanceFromTurnItem(toolItem, "/repo")).toEqual({
      skills: ["ui-polish"],
      contextFiles: ["CLAUDE.md"],
    });

    // Skill Database slugs named in commands/tool inputs count as usage; look-alikes do not.
    const slugItem: OrchestrationV2TurnItem = {
      ...baseTurnItem,
      type: "dynamic_tool",
      toolName: "activate_skill",
      input: { skill: "TDD-Verification", note: "skip a11y-debugging-extra and team-rust-safety" },
    };
    expect(
      ThreadHarnessService.extractProvenanceFromTurnItem(slugItem, "/repo", [
        "tdd-verification",
        "a11y-debugging",
        "rust-safety",
        "docs",
      ]).skills,
    ).toEqual(["tdd-verification"]);
    const builtinCmd: OrchestrationV2TurnItem = {
      ...baseTurnItem,
      type: "command_execution",
      input: "agy skills run gemini-frontend-design --docs",
      exitCode: 0,
    };
    expect(ThreadHarnessService.extractProvenanceFromTurnItem(builtinCmd, "/repo").skills).toEqual([
      "gemini-frontend-design",
    ]);
  });

  it.effect("resolves model family, required and missing skills from the thread's model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "agent-space-family-" });
      const projectId = ProjectId.make("project-family");
      const threadId = ThreadId.make("thread-family");

      const projectLayer = Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedSome({ id: projectId, workspaceRoot: workspace } as never),
      });
      const projectionLayer = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId,
            modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
          } as never),
      });
      const serviceLayer = ThreadHarnessService.layerWithoutProjectionStore.pipe(
        Layer.provide(ThreadHarnessStore.layer),
        Layer.provide(projectionLayer),
        Layer.provideMerge(PipelineService.layer.pipe(Layer.provide(projectLayer))),
        Layer.provide(SqlitePersistence.layerMemory),
      );

      yield* Effect.gen(function* () {
        const harness = yield* ThreadHarnessService.ThreadHarnessService;
        yield* harness.setHarness({ threadId, roleName: "ui-builder" });

        const initial = yield* harness.getState(threadId);
        expect(initial.modelFamily).toBe("gemini");
        expect(initial.requiredSkills?.slice(0, 2)).toEqual([
          "modern-web-guidance",
          "a11y-debugging",
        ]);
        expect(initial.requiredSkills).toContain("gemini-frontend-design");
        expect(initial.missingSkills).toEqual(initial.requiredSkills);

        const recorded = yield* harness.recordTurnItem({
          threadId,
          workspaceRoot: workspace,
          item: {
            ...baseTurnItem,
            threadId,
            type: "command_execution",
            input: "agy skills run gemini-frontend-design",
            exitCode: 0,
          },
        });
        expect(recorded).toBe(true);

        const after = yield* harness.getState(threadId);
        expect(after.trackedSkills).toEqual(["gemini-frontend-design"]);
        expect(after.missingSkills).not.toContain("gemini-frontend-design");
        expect(after.missingSkills).toHaveLength(after.requiredSkills!.length - 1);

        const turn = yield* harness.prepareTurnContext({
          threadId,
          projectId,
          providerThreadId: "pt-gemini",
          isNewNativeSession: true,
        });
        expect(turn).not.toBeNull();
        expect(turn!.context).toContain("gemini harness)");
        expect(turn!.context).toContain("Required skills for this role: modern-web-guidance");
        expect(turn!.context).toContain("Model-family guidance (gemini):");
        expect(turn!.context).toContain("Skills used in this thread: gemini-frontend-design");
        expect(turn!.context).toContain("Required skills not yet used: modern-web-guidance");
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("carries selected role harness and live tracked skills/context across providers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "agent-space-harness-" });
      yield* fs.makeDirectory(path.join(workspace, ".pipelines", "skills", "custom-skill"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(workspace, ".pipelines", "skills", "custom-skill", "SKILL.md"),
        "---\nname: custom-skill\n---\nAlways run typecheck after editing.",
      );
      yield* fs.writeFileString(
        path.join(workspace, "AGENTS.md"),
        "# Repo Rules\nKeep edits focused and tested.",
      );

      const projectId = ProjectId.make("project-harness");
      const threadId = ThreadId.make("thread-harness");

      const projectLayer = Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            workspaceRoot: workspace,
          } as never),
      });
      const pipelinesLayer = PipelineService.layer.pipe(Layer.provide(projectLayer));
      const serviceLayer = ThreadHarnessService.layer.pipe(
        Layer.provide(ThreadHarnessStore.layer),
        Layer.provideMerge(pipelinesLayer),
        Layer.provide(SqlitePersistence.layerMemory),
      );

      yield* Effect.gen(function* () {
        const harness = yield* ThreadHarnessService.ThreadHarnessService;

        // 1. User selects a role from the composer.
        const initial = yield* harness.setHarness({ threadId, roleName: "builder" });
        expect(initial.roleName).toBe("builder");
        expect(initial.revision).toBe(1);

        // 2. First turn on Claude gets the role harness packet.
        const claudeTurn = yield* harness.prepareTurnContext({
          threadId,
          projectId,
          providerThreadId: "pt-claude",
          isNewNativeSession: true,
        });
        expect(claudeTurn).not.toBeNull();
        expect(claudeTurn!.context).toContain("### Workspace Harness Context");
        expect(claudeTurn!.context).toContain("Your role: builder");
        yield* harness.markDelivered({
          threadId,
          providerThreadId: "pt-claude",
          revision: claudeTurn!.revision,
        });

        // 3. Same provider at same revision does not re-inject redundantly.
        const claudeSecondTurn = yield* harness.prepareTurnContext({
          threadId,
          projectId,
          providerThreadId: "pt-claude",
          isNewNativeSession: false,
        });
        expect(claudeSecondTurn).toBeNull();

        // 4. While Claude runs, it reads a skill and AGENTS.md; watcher records them.
        const recorded = yield* harness.recordTurnItem({
          threadId,
          workspaceRoot: workspace,
          item: {
            ...baseTurnItem,
            type: "command_execution",
            input: `cat ${workspace}/.pipelines/skills/custom-skill/SKILL.md && cat ${workspace}/AGENTS.md`,
            exitCode: 0,
          },
        });
        expect(recorded).toBe(true);

        // 5. User switches to Antigravity/Gemini -> new provider thread automatically receives
        //    both the builder role harness AND the skill + AGENTS.md Claude used!
        const geminiTurn = yield* harness.prepareTurnContext({
          threadId,
          projectId,
          providerThreadId: "pt-gemini",
          isNewNativeSession: true,
        });
        expect(geminiTurn).not.toBeNull();
        expect(geminiTurn!.context).toContain("Your role: builder");
        expect(geminiTurn!.context).toContain("custom-skill");
        expect(geminiTurn!.context).toContain("Always run typecheck after editing.");
        expect(geminiTurn!.context).toContain("Keep edits focused and tested.");
        expect(geminiTurn!.context).toContain("Skills used in this thread: custom-skill");
        expect(geminiTurn!.context).toContain("Key context files read/edited: AGENTS.md");
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("saves and reloads custom roles and pipelines in .pipelines/", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "agent-space-pipelines-" });
      const projectId = ProjectId.make("project-save");

      const projectLayer = Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            workspaceRoot: workspace,
          } as never),
      });
      const pipelinesLayer = PipelineService.layer.pipe(Layer.provide(projectLayer));

      yield* Effect.gen(function* () {
        const pipelines = yield* PipelineService.PipelineService;
        const afterRole = yield* pipelines.saveRole({
          projectId,
          role: {
            name: "design-reviewer",
            description: "Reviews UI accessibility and motion polish.",
            tier: "mid",
            access: "read-only",
            candidates: [{ provider: "claude", model: "claude-sonnet-4-6", effort: "medium" }],
            skills: ["modern-web-guidance"],
            contextFiles: ["AGENTS.md"],
            outputContract: "Return PASS or FAIL with concrete a11y findings.",
            instructions: "Check keyboard navigation, focus rings, and label associations.",
          },
        });
        const savedRole = afterRole.roles.find((entry) => entry.role.name === "design-reviewer");
        expect(savedRole).toBeDefined();
        expect(savedRole!.isOverridden).toBe(true);
        expect(savedRole!.role.skills).toEqual(["modern-web-guidance"]);

        const afterPipeline = yield* pipelines.savePipeline({
          projectId,
          pipeline: {
            name: "ui-polish-loop",
            description: "Build UI then review accessibility with another vendor.",
            stages: [
              {
                id: "build",
                role: "builder",
                goal: "Implement the requested UI change.",
                workspace: "worktree",
              },
              {
                id: "review",
                role: "design-reviewer",
                goal: "Audit accessibility and semantics.",
                differentProviderFrom: "build",
                onFail: "build",
              },
            ],
          },
        });
        const savedPipeline = afterPipeline.pipelines.find(
          (entry) => entry.pipeline.name === "ui-polish-loop",
        );
        expect(savedPipeline).toBeDefined();
        expect(savedPipeline!.pipeline.stages).toHaveLength(2);
        expect(afterPipeline.problems).toEqual([]);

        const afterDelete = yield* pipelines.deletePipeline({
          projectId,
          name: "ui-polish-loop",
        });
        expect(
          afterDelete.pipelines.find((entry) => entry.pipeline.name === "ui-polish-loop"),
        ).toBeUndefined();
      }).pipe(Effect.provide(pipelinesLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
