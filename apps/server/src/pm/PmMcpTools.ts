import {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  PmPipelineDefinition,
  PmPipelineRole,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTaskUpsertSchedule,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts"; // pipelines:
import { PipelineService } from "../pipelines/PipelineService.ts"; // pipelines:
import { ThreadHarnessService } from "../pipelines/ThreadHarnessService.ts"; // pipelines:
import { PmHostStatus, PmRemote } from "./PmRemote.ts";
import { PmService } from "./PmService.ts";
import { PmStore } from "./PmStore.ts"; // pipelines:
import {
  hiddenUnlessPeerLink,
  hiddenUnlessPm,
  hiddenUnlessPmWorker,
  hiddenUnlessThread,
} from "./PmVisibility.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  success: Schema.Struct({
    result: Schema.String,
    notes: Schema.optional(Schema.Array(Schema.String)),
  }),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PmService,
    PmRemote,
    PmStore, // pipelines:
    PipelineService, // pipelines:
    ThreadHarnessService, // pipelines:
    OrchestratorMcpService.OrchestratorMcpService, // pipelines:
  ],
};

const ItemRef = Schema.Union([Schema.String, Schema.Number]).annotate({
  description: "Work item tag, such as W3.",
});
const AskTagRef = Schema.Union([Schema.String, Schema.Number]).annotate({
  description: "Question tag, such as Q5.",
});
const pmTool = <const Name extends string, P extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  parameters: P,
) =>
  Tool.make(name, { ...shared, description, parameters: Schema.Struct(parameters) }).annotate(
    McpSchema.EnabledWhen,
    hiddenUnlessPm,
  );

// No `parameters`: Tool.make's default serializes to `type: "object"`; an empty Schema.Struct
// serializes to `anyOf: [object, array]`, which MCP clients reject for the whole server.
const pmToolWithoutParameters = <const Name extends string>(name: Name, description: string) =>
  Tool.make(name, { ...shared, description }).annotate(McpSchema.EnabledWhen, hiddenUnlessPm);

const PmGuideTool = pmTool(
  "pm_guide",
  "Your playbook as a project manager, then the user's overrides. Call before your first reply and after every compaction. `changes: true` returns only what changed since your last read; `pages: true` returns how to write a Live page instead.",
  { changes: Schema.optional(Schema.Boolean), pages: Schema.optional(Schema.Boolean) },
);
const PmStatusTool = pmToolWithoutParameters(
  "pm_status",
  "Your name, mission, standing instructions, memory, work items with their status, open asks, and every worker with its state and last report. Call at the start of every request.",
);
const PmSetNameTool = pmTool(
  "pm_set_name",
  "Rename yourself (2 to 5 words), once you know the brief.",
  { name: TrimmedNonEmptyString },
);
const PmSetMissionTool = pmTool(
  "pm_set_mission",
  "Set your mission in one or two sentences, once you know the brief. Later only when the user asks.",
  { mission: Schema.String },
);
const PmSetInstructionsTool = pmTool(
  "pm_set_instructions",
  "Replace your standing instructions. Only when the user asks.",
  { instructions: Schema.String },
);
const PmRememberTool = pmTool(
  "pm_remember",
  "Save a one-line memory note. Only after the user confirmed its exact wording.",
  { text: TrimmedNonEmptyString },
);
const PmForgetTool = pmTool(
  "pm_forget",
  "Remove memory note `number`; later notes move up one. Only when the user asks.",
  { number: Schema.Number },
);
const PmPlaybookOverrideTool = pmTool(
  "pm_playbook_override",
  "List or change the playbook overrides every PM follows. Change them only after the user confirmed the wording.",
  {
    op: Schema.Literals(["list", "add", "replace", "remove"]),
    text: Schema.optional(Schema.String),
    number: Schema.optional(Schema.Number),
  },
);
const ComputerRef = TrimmedNonEmptyString.annotate({
  description: 'A computer from pm_computers, by name or id. Omit (or "here") for this computer.',
});
const PmComputersTool = pmToolWithoutParameters(
  "pm_computers",
  "This computer and every computer the user linked: whether each answers, its access, its agents with their usage, its load, and whether it has this repository. Call before starting work on another computer.",
);
const PmWorkerStartTool = pmTool(
  "pm_worker_start",
  "Start a worker thread in your project with a brief that stands alone. Agent Space adds your mission, instructions and the reporting rules. Its report arrives as a message: end your turn after it starts. Omit the model to use yours. `computer` starts it on another computer the user linked.",
  {
    computer: Schema.optional(ComputerRef),
    clone_to: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Only after the user agreed: clone this repository to this absolute folder on that computer first, when it has no copy.",
      }),
    ),
    title: TrimmedNonEmptyString.annotate({ description: "Its task, 3 to 6 words." }),
    brief: TrimmedNonEmptyString.check(Schema.isMaxLength(120000)),
    item: Schema.optional(ItemRef),
    modelSelection: Schema.optional(ModelSelection),
    // pipelines: a role picks the model from the user's tiers, accounts and usage limits.
    role: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Role from pm_roles, such as builder, reviewer or architect. Picks the model and adds the role's instructions. Prefer it to modelSelection.",
      }),
    ),
    escalate: Schema.optional(
      Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 2 })).annotate({
        description: "Tiers above the role's own, after failed attempts on the same card.",
      }),
    ),
    avoid_provider_of: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).annotate({
        description:
          "Thread ids whose vendor this worker should not share, such as the builder a reviewer checks.",
      }),
    ),
    workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  },
).annotate(Tool.Destructive, true);
const ScheduleWorkerSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  // OpenCode sends nested union objects as JSON text.
  Schema.fromJsonString(ScheduledTaskUpsertSchedule),
]).annotate({
  description:
    "When: {type:'interval',everyMs} (at least 60000), {type:'fixed_time',timeOfDay,weekdays?}, {type:'once',runAt} or {type:'webhook'}.",
});
const PmWorkerScheduleTool = pmTool(
  // pipelines:
  "pm_worker_schedule",
  "Start a worker later or on a repeat, such as a nightly audit or a retry when a usage limit resets. Takes pm_worker_start's fields plus `schedule`. Each run posts a Scheduled worker message here and you start the worker then, so a role picks the model at that time.",
  {
    ...PmWorkerStartTool.parametersSchema.fields,
    brief: TrimmedNonEmptyString.check(Schema.isMaxLength(100000)),
    schedule: ScheduleWorkerSchedule,
    enabled: Schema.optional(Schema.Boolean.annotate({ description: "Default true." })),
  },
).annotate(Tool.Destructive, true);
const PmPipelinesTool = pmTool(
  // pipelines:
  "pm_pipelines",
  "The pipelines for this project (built-in plus the project's .pipelines folder). Without a name, one line each; with a name, its stages as a checklist with the rules for running it.",
  { name: Schema.optional(TrimmedNonEmptyString) },
);
const PmRolesTool = pmToolWithoutParameters(
  // pipelines:
  "pm_roles",
  "Every worker role, its tier, and the model it would run on right now given the user's accounts and usage limits.",
);
const PmWorkerLinkTool = pmTool(
  "pm_worker_link",
  "Adopt an existing thread in your project as your worker, after the user agreed. Its reports then come to you. `computer` for a thread on another computer the user linked.",
  {
    thread: TrimmedNonEmptyString,
    item: Schema.optional(ItemRef),
    computer: Schema.optional(ComputerRef),
  },
);
const PmWorkerUnlinkTool = pmTool(
  "pm_worker_unlink",
  "Return a worker to the normal thread list; it stops reporting to you.",
  { thread: TrimmedNonEmptyString },
);
const PmWorkerResolveTool = pmTool(
  "pm_worker_resolve",
  "Close a worker whose work you have taken: no more reports from it.",
  { thread: TrimmedNonEmptyString },
);
const PmItemAddTool = pmTool(
  "pm_item_add",
  "Start a work item for one line of work, named as the user would. Returns its W tag.",
  { title: TrimmedNonEmptyString, thread: Schema.optional(TrimmedNonEmptyString) },
);
const PmItemUpdateTool = pmTool(
  "pm_item_update",
  "Update a work item: `now` (replaces the last), `step` (+`chore`), `step_done`, `wait` (W<n>, Q<n> or words), `status` (done needs `done`, the line worth keeping; drop withdraws its asks; later; restore), `title`. Never hand work to the user here: that is pm_ask.",
  {
    item: ItemRef,
    title: Schema.optional(Schema.String),
    now: Schema.optional(Schema.String),
    step: Schema.optional(Schema.String),
    chore: Schema.optional(Schema.Boolean),
    step_done: Schema.optional(Schema.Number),
    wait: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Literals(["done", "drop", "later", "restore"])),
    done: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  },
);
const PmItemListTool = pmTool(
  "pm_item_list",
  "Your work items with their status. Before ending each turn call it with `check: true`: only what to fix first (In progress with nobody on it, Not being worked on, workers not moving after the nudge), or one all-clear line.",
  { check: Schema.optional(Schema.Boolean) },
);
const PmAskTool = pmTool(
  "pm_ask",
  'Ask the user one question; it shows above their chat box. Title names its subject in plain words (no W or Q tags, thread ids or commit hashes); detail holds the full context to decide (at least 120 characters: what it is, what each answer does, what you recommend and why, risks, links, and any text to paste in a ``` block); answers like "A*,B" (* marks yours). `holds` when the work stops until they answer. End your turn after asking.',
  {
    item: Schema.optional(ItemRef),
    title: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
    answers: Schema.optional(Schema.String),
    recommended: Schema.optional(Schema.String),
    holds: Schema.optional(Schema.Boolean),
  },
);
const PmAskDoneTool = pmTool(
  "pm_ask_done",
  "Close an open question the user settled by doing it.",
  { tag: AskTagRef },
);
const PmAskWithdrawTool = pmTool(
  "pm_ask_withdraw",
  "Withdraw an open question the user settled another way.",
  { tag: AskTagRef },
);
const PmNextTagTool = pmToolWithoutParameters(
  "pm_next_tag",
  "Reserves the next free Q tag for a Live page question (never handed out again) and shows the next W tag.",
);
// t3code-pm: the one tool a PM's workers see (Ghostex's `coordinator note`).
const PmWorkerNoteTool = Tool.make("pm_worker_note", {
  ...shared,
  description:
    'Right after every push, tell your project manager in one line what landed ("<commit> <what landed>"), then keep working and still end your turn with your full report.',
  parameters: Schema.Struct({ note: Schema.String }),
}).annotate(McpSchema.EnabledWhen, hiddenUnlessPmWorker);

// t3code-pm: asked by another computer's PM over its link, never by a thread here.
const PmHostStatusTool = Tool.make("pm_host_status", {
  description:
    "This computer's agents (ready, usage windows) and load (CPU, free memory, running threads), for a project manager on a linked computer choosing where to start work.",
  success: PmHostStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, PmRemote],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, hiddenUnlessPeerLink);

const PmLinkAddTool = pmTool(
  "pm_link_add",
  "Link an issue, PR or page (full URL) to a work item or worker.",
  {
    url: TrimmedNonEmptyString,
    item: Schema.optional(ItemRef),
    thread: Schema.optional(TrimmedNonEmptyString),
    title: Schema.optional(Schema.String),
  },
);
const PmPageShowTool = pmTool(
  "pm_page_show",
  "Publish a Live page: self-contained HTML (inline images; no outside requests) for the user to look at and answer. Read pm_guide with `pages: true` first for how to write one. Same `source_name` replaces the older page. Question tags come from pm_next_tag.",
  {
    html: Schema.String,
    title: TrimmedNonEmptyString,
    source_name: TrimmedNonEmptyString,
    item: Schema.optional(ItemRef),
    question_tags: Schema.optional(Schema.Array(Schema.String)),
  },
);
const PmPageRetireTool = pmTool(
  "pm_page_retire",
  "Retire an out-of-date Live page; its open questions are withdrawn.",
  { page: TrimmedNonEmptyString },
);

const PmRunGatesTool = pmTool(
  "pm_run_gates",
  "Run deterministic gatekeeper commands (lint, typecheck, tests) directly in the workspace without spawning an LLM worker, and write gates.json.",
  {
    commands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    pipeline: Schema.optional(TrimmedNonEmptyString),
    stage: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    run_folder: Schema.optional(TrimmedNonEmptyString),
  },
);

const PmRoleSaveTool = Tool.make("pm_role_save", {
  ...shared,
  description:
    "Create or update a reusable agent role/harness in the project's `.pipelines/roles/<name>.yaml`. Lets the main agent assign a tier or explicit model candidates, attach skills and repository context files, define an outputContract, and set standing instructions.",
  parameters: Schema.Struct({
    role: PmPipelineRole,
    previous_name: Schema.optional(TrimmedNonEmptyString),
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, hiddenUnlessThread);

const PmPipelineSaveTool = Tool.make("pm_pipeline_save", {
  ...shared,
  description:
    "Create or update a multi-agent workflow pipeline in the project's `.pipelines/pipelines/<name>.yaml`. Defines ordered stages, assigned roles, parallelism, worktrees, approval gates, cross-provider reviews (`differentProviderFrom`), loop-back (`onFail`), and deterministic `run` gates.",
  parameters: Schema.Struct({
    pipeline: PmPipelineDefinition,
    previous_name: Schema.optional(TrimmedNonEmptyString),
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, hiddenUnlessThread);

const PmThreadHarnessGetTool = Tool.make("pm_thread_harness_get", {
  ...shared,
  description:
    "Inspect the active unified role/harness and live tracked skills & repository context files carried across models (Claude, Codex, Antigravity/Gemini) on this thread or another thread.",
  parameters: Schema.Struct({
    thread: Schema.optional(TrimmedNonEmptyString),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenUnlessThread);

export const PmToolkit = Toolkit.make(
  PmGuideTool,
  PmStatusTool,
  PmSetNameTool,
  PmSetMissionTool,
  PmSetInstructionsTool,
  PmRememberTool,
  PmForgetTool,
  PmPlaybookOverrideTool,
  PmComputersTool,
  PmWorkerStartTool,
  PmWorkerLinkTool,
  PmWorkerUnlinkTool,
  PmWorkerResolveTool,
  PmItemAddTool,
  PmItemUpdateTool,
  PmItemListTool,
  PmAskTool,
  PmAskDoneTool,
  PmAskWithdrawTool,
  PmNextTagTool,
  PmWorkerNoteTool,
  PmLinkAddTool,
  PmPageShowTool,
  PmPageRetireTool,
  PmHostStatusTool,
  PmWorkerScheduleTool, // pipelines:
  PmPipelinesTool, // pipelines:
  PmRolesTool, // pipelines:
  PmRunGatesTool, // pipelines:
  PmRoleSaveTool, // pipelines:
  PmPipelineSaveTool, // pipelines:
  PmThreadHarnessGetTool, // pipelines:
);
