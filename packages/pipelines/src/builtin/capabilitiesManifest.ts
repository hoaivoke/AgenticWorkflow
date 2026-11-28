import type { SkillEntry } from "../schema.ts";
import { BUILTIN_SKILLS } from "./skills.ts";

export interface ManifestSkillSummary {
  readonly name: string;
  readonly scope?: string;
  readonly path?: string;
  readonly description?: string;
}

export const AGENT_SPACE_SLASH_COMMANDS: ReadonlyArray<{
  readonly command: string;
  readonly label: string;
  readonly tokenCost: "standard" | "high" | "very-high";
  readonly summary: string;
}> = [
  {
    command: "swarm",
    label: "Swarm Mode",
    tokenCost: "high",
    summary:
      "Coordinate parallel worker agents on a shared Swarm board with role routing, worktrees, and live failover.",
  },
  {
    command: "scorched-earth",
    label: "Scorched Earth",
    tokenCost: "very-high",
    summary:
      "Exhaustive verification pipeline: builders emit surface-inventory.json, deterministic gates run first, scenario-generator derives edge cases, playtester executes them, and troubleshooter->fixer->playtester loops up to 3 cycles.",
  },
  {
    command: "plan",
    label: "Plan Mode",
    tokenCost: "standard",
    summary:
      "Research the codebase and produce a concrete, step-by-step architectural plan before making edits.",
  },
  {
    command: "goal",
    label: "Goal Mode",
    tokenCost: "high",
    summary:
      "Autonomous, thorough execution loop that keeps verifying and fixing until every acceptance criterion is proven.",
  },
  {
    command: "boost",
    label: "Boost Mode",
    tokenCost: "high",
    summary:
      "Deep thinking, multi-perspective design critique, edge-case analysis, and rigorous verification.",
  },
  {
    command: "grill-me",
    label: "Grill Me",
    tokenCost: "standard",
    summary:
      "Interactive interview to stress-test requirements, uncover blind spots, and lock in design decisions before coding.",
  },
  {
    command: "teamwork",
    label: "Teamwork",
    tokenCost: "high",
    summary:
      "Decompose a large request into parallel specialist roles working together via Swarm mode.",
  },
  {
    command: "learn",
    label: "Learn",
    tokenCost: "standard",
    summary:
      "Distill a correction, tricky setup, or recurring preference into a persistent skill or rule for future sessions.",
  },
  {
    command: "smart",
    label: "Smart Mode",
    tokenCost: "standard",
    summary:
      "Analyze the request against the full Capabilities Manifest, attach relevant skills, and ask before spending extra tokens on high-stakes Swarm or Scorched Earth verification.",
  },
];

export const AGENT_SPACE_TOOL_CATALOG: ReadonlyArray<{
  readonly name: string;
  readonly category: string;
  readonly summary: string;
}> = [
  {
    name: "swarm",
    category: "Swarm Orchestration",
    summary:
      "Manage multi-agent swarms (actions: title, status, models, pipeline, model, add, channel, kill, done). Supports worktree isolation, warm fork, role-based tier failover, and customizable pipelines.",
  },
  {
    name: "post_message",
    category: "Swarm Orchestration",
    summary:
      "Post a message to the shared Swarm board (#main or custom channels) with @name / @all mentions.",
  },
  {
    name: "read_board",
    category: "Swarm Orchestration",
    summary:
      "Read Swarm board messages by sequence number (`since` or `seqs`) or inspect roster status.",
  },
  {
    name: "swarm_wait",
    category: "Swarm Orchestration",
    summary: "Sleep at zero token cost until another Swarm member posts a relevant mention.",
  },
  {
    name: "pm_ask",
    category: "User Decisions",
    summary:
      "Ask the user a structured question (for approvals, ambiguity, or confirming extra token spend on Swarm / Scorched Earth).",
  },
  {
    name: "pm_pipelines",
    category: "Pipelines & Skills",
    summary:
      "Inspect available customizable pipelines (including feature, bugfix, scorched-earth) and their stages.",
  },
  {
    name: "pm_roles",
    category: "Pipelines & Skills",
    summary: "List role harnesses, tier routing, and Big-3 model-family skill requirements.",
  },
  {
    name: "pm_run_gates",
    category: "Verification",
    summary:
      "Run deterministic verification gates (format, lint, typecheck, unit tests) before handoff.",
  },
  {
    name: "pm_verify_app",
    category: "Verification",
    summary: "Run automated real-app verification checks and smoke probes.",
  },
  {
    name: "t3_thread_read",
    category: "Thread Context",
    summary: "Read prior thread messages or omitted handoff items by threadId and itemId.",
  },
];

/**
 * Renders a compact, agent-readable Markdown capabilities manifest documenting every mode,
 * slash command, orchestration/verification tool, built-in skill, and installed local skill.
 */
export function renderCapabilitiesManifestMarkdown(options?: {
  readonly discoveredSkills?: ReadonlyArray<ManifestSkillSummary>;
  readonly builtInSkills?: ReadonlyArray<SkillEntry>;
}): string {
  const builtIn = options?.builtInSkills ?? BUILTIN_SKILLS;
  const discovered = options?.discoveredSkills ?? [];

  const lines: Array<string> = [
    "# Agent Space Capabilities Manifest",
    "",
    "Use this manifest to choose the right mode, tools, and skills for the user's request.",
    "If a request is high-stakes (e.g. 'make no mistake', 'zero bugs', production-critical, financial/security-sensitive) and the user has NOT already opted into Scorched Earth or Swarm, ask the user first before spending extra tokens on multi-agent verification.",
    "",
    "## Modes & Slash Commands",
  ];

  for (const cmd of AGENT_SPACE_SLASH_COMMANDS) {
    lines.push(
      `- \`/${cmd.command}\` (**${cmd.label}**, token cost: ${cmd.tokenCost}): ${cmd.summary}`,
    );
  }

  lines.push("", "## Agent Tools & Functions");
  for (const tool of AGENT_SPACE_TOOL_CATALOG) {
    lines.push(`- \`${tool.name}\` (${tool.category}): ${tool.summary}`);
  }

  lines.push("", "## Built-in Role Skills");
  for (const skill of builtIn) {
    lines.push(`- \`${skill.name}\` [${skill.category}]: ${skill.description}`);
  }

  if (discovered.length > 0) {
    lines.push("", `## Installed Local & Plugin Skills (${discovered.length} available)`);
    for (const skill of discovered.slice(0, 120)) {
      const scopeTag = skill.scope ? ` (${skill.scope})` : "";
      const desc = skill.description ? `: ${skill.description}` : "";
      const pathHint = skill.path ? ` (\`${skill.path}\`)` : "";
      lines.push(`- \`${skill.name}\`${scopeTag}${desc}${pathHint}`);
    }
    if (discovered.length > 120) {
      lines.push(`- ...and ${discovered.length - 120} more installed skills.`);
    }
  }

  return lines.join("\n");
}
