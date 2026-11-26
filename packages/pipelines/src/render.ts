import { CONFIG_DIR, RUNS_DIR } from "./load.ts";
import { resolveRole, type ProviderSnapshot } from "./router.ts";
import type { PipelineConfig, Role, Stage } from "./schema.ts";

const stageRole = (stage: Stage) => stage.role ?? "gatekeeper";

/** One line per pipeline, for choosing one. */
export function renderPipelineList(
  config: PipelineConfig,
  problems: ReadonlyArray<string> = [],
): string {
  const lines = [...config.pipelines.values()].map((pipeline) => {
    const source = config.sources.get(`pipeline:${pipeline.name}`);
    const from = source === undefined || source === "built-in" ? "" : ` [${source}]`;
    return `- ${pipeline.name}${from}: ${pipeline.description} Use when: ${pipeline.when} Stages: ${pipeline.stages.map((stage) => stage.id).join(" → ")}.`;
  });
  return [
    "Pipelines (call pm_pipelines with a name for its full plan):",
    ...lines,
    ...renderProblems(problems),
  ].join("\n");
}

const renderProblems = (problems: ReadonlyArray<string>) =>
  problems.length === 0
    ? []
    : [
        "",
        `Ignored config (tell the user if they wrote it):`,
        ...problems.map((problem) => `- ${problem}`),
      ];

/** A pipeline as a numbered checklist the PM can follow and copy into work item steps. */
export function renderPipeline(
  config: PipelineConfig,
  name: string,
  problems: ReadonlyArray<string> = [],
): string | undefined {
  const pipeline = config.pipelines.get(name);
  if (pipeline === undefined) return undefined;
  const stageLines = pipeline.stages.map((stage, index) => {
    const role = config.roles.get(stageRole(stage));
    const details: Array<string> = [];
    if (stage.reads !== undefined) details.push(`reads ${stage.reads.join(", ")}`);
    if (stage.produces !== undefined) details.push(`produces ${stage.produces.join(", ")}`);
    if (stage.run !== undefined)
      details.push(`runs: ${stage.run.map((command) => `\`${command}\``).join(", ")}`);
    if (stage.foreach === "each-task") details.push("one worker per task card");
    if (stage.parallel !== undefined) details.push(`up to ${stage.parallel} workers at once`);
    if (stage.workspace === "worktree") details.push("each worker in its own worktree");
    if (stage.differentProviderFrom !== undefined)
      details.push(
        `pass avoid_provider_of with the thread of stage ${stage.differentProviderFrom}`,
      );
    if (stage.skipWhen !== undefined) details.push(`skip when ${stage.skipWhen}`);
    if (stage.onFail !== undefined) details.push(`on failure, back to ${stage.onFail}`);
    if (stage.approval === true) details.push("ask the user to approve before moving on");
    return [
      `${index + 1}. ${stage.id}: role ${stageRole(stage)} (${role?.tier ?? "?"} tier). ${stage.goal}`,
      ...(details.length === 0 ? [] : [`   ${details.join("; ")}.`]),
    ].join("\n");
  });
  const rules = [
    `Run folder: ${RUNS_DIR}/<short-run-name>/ under the project root. Create it, give every worker its absolute path, and keep ${RUNS_DIR}/ out of git.`,
    "Call `pm_pipeline_run_start` when starting this pipeline and `pm_pipeline_stage_update` as each stage starts, waits for approval, passes, or fails so the Live Runs graph tracks progress, cost, and budget guardrails.",
    "Start each stage's workers with pm_worker_start and role set to the stage's role. Role harnesses (skills, context files, toolkits) load automatically in prompt-cache-stable order; put only the stage goal, artifact paths, and task card in the brief.",
    "For deterministic checks and app/website verification stages, call `pm_run_gates` or `pm_verify_app` directly at zero LLM cost before spawning an agent.",
    `A failed card goes back to its stage with the failure attached. After ${pipeline.escalateAfter ?? 2} failed attempts on one card, start the next attempt with escalate: 1 (one tier up)${pipeline.replanAfter === undefined ? "" : `; after ${pipeline.replanAfter}, send it back to planning`}.`,
    "Never let a worker review or QA its own work. Read gates.json, verify-report.md, review.md and validated.json yourself; do not take a worker's word that checks passed.",
    "When a review or failure uncovers a reusable lesson for this repository, call `pm_learning_propose` so the user can promote it into the role's `.pipelines/roles/<role>.yaml` harness for future runs.",
  ];
  return [
    `Pipeline ${pipeline.name}: ${pipeline.description}`,
    "",
    ...stageLines,
    "",
    "Rules:",
    ...rules.map((rule) => `- ${rule}`),
    ...renderProblems(problems),
  ].join("\n");
}

/** Each role with the model it would run on right now. */
export function renderRoles(
  config: PipelineConfig,
  providers: ReadonlyArray<ProviderSnapshot>,
  limited: ReadonlyMap<string, string>,
  problems: ReadonlyArray<string> = [],
): string {
  const lines = [...config.roles.values()].map((role) => {
    const resolution = resolveRole({ config, role: role.name, providers, limited });
    const now = resolution.ok
      ? `${resolution.selection.instanceId}/${resolution.selection.model}${resolution.selection.options.length === 0 ? "" : ` (${resolution.selection.options.map((option) => `${option.id}=${String(option.value)}`).join(", ")})`}`
      : `none available (${resolution.reason})`;
    const source = config.sources.get(`role:${role.name}`);
    const from = source === undefined || source === "built-in" ? "" : ` [${source}]`;
    return `- ${role.name}${from}: ${role.tier} tier${role.maxTier === undefined ? "" : `, up to ${role.maxTier}`}${role.access === "read-only" ? ", read-only" : ""}. ${role.description} Now: ${now}.`;
  });
  const limits =
    limited.size === 0
      ? []
      : [
          "",
          "At usage limits:",
          ...[...limited].map(([instance, until]) => `- ${instance} until ${until}`),
        ];
  return [
    `Roles (override any in ${CONFIG_DIR}/roles/<name>.yaml; tiers in ${CONFIG_DIR}/tiers.yaml):`,
    ...lines,
    ...limits,
    ...renderProblems(problems),
  ].join("\n");
}

export const SCHEDULED_WORKER_HEADING = "Scheduled worker:";

/**
 * What a worker schedule posts into its PM's thread on each run. The PM starts the worker
 * itself, so the role picks a model from the accounts and limits of that moment.
 */
export function renderScheduledWorkerPrompt(
  title: string,
  startArguments: Readonly<Record<string, unknown>>,
): string {
  return [
    `${SCHEDULED_WORKER_HEADING} ${title}`,
    "",
    "A schedule you created with pm_worker_schedule just ran. Call pm_worker_start with exactly these arguments, then end your turn:",
    "",
    "```json",
    JSON.stringify(startArguments, null, 2),
    "```",
    "",
    "If webhook data follows below, add what the worker needs from it to the brief.",
    "If the work item is done or the user no longer wants this, do not start the worker: delete this schedule with delete_scheduled_task (list_scheduled_tasks shows its id) and tell the user in one line.",
  ].join("\n");
}

export interface ResolvedRoleHarness {
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly content: string }>;
  readonly contextFiles?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

/** The role section + resolved harness that goes at the top of a worker's brief. */
export function renderRoleBrief(role: Role, tier: string, harness?: ResolvedRoleHarness): string {
  const access =
    role.access === "read-only"
      ? "You are read-only: never edit, create or delete project files, except the run-folder files your role writes."
      : "You may edit files in your workspace.";
  const lines = [`## Your role: ${role.name} (${tier} tier)`, role.description, access];
  if (role.toolkits && role.toolkits.length > 0) {
    lines.push(`Recommended toolkits/scope: ${role.toolkits.join(", ")}.`);
  }
  if (role.outputContract) {
    lines.push(`Output contract: ${role.outputContract}`);
  }
  lines.push("", role.instructions);
  if (harness?.contextFiles && harness.contextFiles.length > 0) {
    // Stable alphabetical ordering preserves prompt-cache prefix reuse across turns and providers.
    const sortedContext = [...harness.contextFiles].toSorted((a, b) =>
      a.path.localeCompare(b.path),
    );
    lines.push("", "## Role Context");
    for (const file of sortedContext) {
      lines.push(`### ${file.path}`, file.content);
    }
  }
  if (harness?.skills && harness.skills.length > 0) {
    const sortedSkills = [...harness.skills].toSorted((a, b) => a.name.localeCompare(b.name));
    lines.push("", "## Role Skills");
    for (const skill of sortedSkills) {
      lines.push(`### Skill: ${skill.name}`, skill.content);
    }
  }
  return lines.join("\n");
}
