import type { ModelFamily, PipelineConfig, Role, SkillEntry } from "../schema.ts";

/**
 * Built-in Skill Database for the Big 3 model families (Claude, ChatGPT/Codex, Gemini).
 * Project overrides can be added in `.pipelines/skills.yaml` or `.pipelines/skills/<name>.yaml`.
 */
export const BUILTIN_SKILLS: ReadonlyArray<SkillEntry> = [
  {
    name: "modern-web-guidance",
    title: "Modern Web & CSS Craft",
    description:
      "Semantic HTML, responsive desktop/mobile layout, modern CSS primitives, and clean DOM patterns.",
    category: "frontend",
    roles: ["ui-builder", "ux-reviewer", "qa"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Keep component hierarchy minimal and avoid inventing bespoke CSS wrappers when semantic HTML + existing design tokens suffice.",
      codex:
        "Inspect existing design tokens and layout components before editing styles; verify both desktop (1440px) and mobile (390px) widths.",
      gemini:
        "Use real semantic landmarks, clear visual hierarchy, and verify rendered layout in a browser rather than assuming CSS compiles cleanly.",
    },
    instructions: [
      "Use semantic HTML elements (header, nav, main, section, button, dialog) and existing design-system tokens.",
      "Ensure responsive behavior at desktop (1440px) and mobile (390px) without horizontal overflow.",
      "Verify interactive states: hover, focus-visible, disabled, loading, empty, and error.",
    ].join("\n"),
  },
  {
    name: "gemini-frontend-design",
    title: "Gemini Frontend Design & Visual Polish",
    description:
      "High-craft visual hierarchy, typography, spacing rhythm, and intentional motion for Gemini UI workers.",
    category: "frontend",
    roles: ["ui-builder", "ux-reviewer"],
    families: ["gemini"],
    familyGuidance: {
      gemini:
        "Commit to a cohesive visual system with deliberate typography scale, clean alignment, strong contrast, and zero generic placeholder clutter.",
    },
    instructions: [
      "Establish clear typographic hierarchy, consistent spacing rhythm, and high-contrast readable surfaces.",
      "Avoid generic boilerplate cards or unaligned controls; every label must accurately reflect the live data state.",
      "Check before/after screenshots across light and dark surfaces when applicable.",
    ].join("\n"),
  },
  {
    name: "a11y-debugging",
    title: "Accessibility & Keyboard Audit",
    description:
      "ARIA labels, keyboard navigation, focus management, contrast, and screen-reader semantics.",
    category: "frontend",
    roles: ["ui-builder", "ux-reviewer", "qa"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Audit every interactive control for accessible name, role, and keyboard activation (Enter/Space/Escape).",
      codex:
        "Check form labels, aria-expanded/aria-selected states, and tab order explicitly in tests or DOM snapshots.",
      gemini:
        "Inspect the rendered accessibility tree and verify focus rings, contrast ratios, and non-ambiguous copy labels.",
    },
    instructions: [
      "Every interactive element must have an accessible name, visible focus indicator, and full keyboard support.",
      "Verify headings follow document order, form controls have associated labels, and dynamic status updates use aria-live where needed.",
    ].join("\n"),
  },
  {
    name: "tdd-verification",
    title: "TDD & Behavioral Verification",
    description:
      "Prove behavior with focused tests that fail before the fix and pass after, asserting real outcomes.",
    category: "testing",
    roles: ["builder", "verifier", "qa"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Avoid over-mocking internal helpers; test at the lowest real boundary that would fail without your change.",
      codex:
        "Run the exact targeted test command after every edit and quote the real pass/fail output in your report.",
      gemini:
        "Never claim tests pass from static inspection: execute the test suite and verify exit code 0 before reporting done.",
    },
    instructions: [
      "Write focused tests covering real behavioral regressions, edge cases, and state transitions rather than trivial smoke checks.",
      "For bug fixes, verify the test fails against the broken behavior and passes only after the fix.",
      "Run format, lint, typecheck, and targeted tests on all changed files before reporting completion.",
    ].join("\n"),
  },
  {
    name: "diff-discipline",
    title: "Scoped Diff & Contract Discipline",
    description:
      "Keep edits tightly scoped to the task card, preserve wire contracts, and avoid unrelated churn.",
    category: "backend",
    roles: ["builder", "ui-builder"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Resist refactoring untouched neighbors or adding speculative abstractions beyond the task card.",
      codex:
        "Read the surrounding file and shared contracts before editing so server, web, and mobile types stay aligned.",
      gemini:
        "Check every modified file with git diff before finishing to ensure no accidental deletions or half-finished edits remain.",
    },
    instructions: [
      "Touch only the files required by the task card and update shared contracts first when wire schemas change.",
      "Check reverse states (if you add a way in, add the way out) and all entry points that share the behavior.",
    ].join("\n"),
  },
  {
    name: "adversarial-verification",
    title: "Adversarial Diff & Behavior Verification",
    description:
      "Independently challenge author claims by inspecting diffs, running checks, and hunting edge-case failures.",
    category: "review",
    roles: ["verifier", "reviewer", "plan-reviewer"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Do not anchor on the author's summary; trace every changed branch and check what happens on empty, error, and completed states.",
      codex:
        "Re-run the verification commands yourself and cite exact file:line evidence for every finding.",
      gemini:
        "Actively try to break the implementation on boundary inputs, stale UI labels, and multi-provider edge cases.",
    },
    instructions: [
      "Treat every author claim as unverified until you inspect the diff and execute checks yourself.",
      "Focus on correctness bugs, broken contracts, misleading UI copy/counts, missing edge cases, and untested paths.",
      "End your report with an explicit PASS / FAIL or APPROVE / CHANGES REQUESTED verdict and concrete fixes.",
    ].join("\n"),
  },
  {
    name: "architecture-planning",
    title: "Architecture & Task Decomposition",
    description:
      "Design minimal systems, explicit data/contract boundaries, threat models, and non-overlapping task cards.",
    category: "architecture",
    roles: ["architect", "product"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Optimize for the smallest model that makes the right behavior unsurprising; avoid unnecessary layers.",
      codex:
        "Partition task cards by disjoint file ownership so parallel worktree builders never collide on merges.",
      gemini:
        "Include explicit acceptance criteria, state transitions, and exact verification commands in every task card.",
    },
    instructions: [
      "Define clear module boundaries, contract changes, risks, and independent worker-sized task cards.",
      "Every acceptance criterion must map to a concrete, testable verification step.",
    ].join("\n"),
  },
  {
    name: "security-audit",
    title: "Security & Trust-Boundary Audit",
    description:
      "Trace untrusted inputs across trust boundaries for injection, authz/IDOR, secrets, and sandbox escapes.",
    category: "security",
    roles: ["security-scout", "security-reviewer", "security-validator"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Verify every finding against actual framework sanitizers and call sites before confirming severity.",
      codex: "Trace full data flow from external input to sink and cite exact file:line locations.",
      gemini:
        "Report only concrete exploitable paths with defensive fixes; reject speculative warnings without code evidence.",
    },
    instructions: [
      "Audit injection vectors (SQL, shell, template, SSRF, path traversal), authz/IDOR, secret handling, and dependency risks.",
      "Every confirmed finding must cite exact source lines, trust boundary crossed, and a concrete remediation.",
    ].join("\n"),
  },
  {
    name: "browser-e2e-qa",
    title: "End-to-End Browser & Visual QA",
    description:
      "Verify user journeys in a real browser across empty, active, completed, and error states with screenshots.",
    category: "testing",
    roles: ["qa", "ui-builder", "ux-reviewer"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Test every user-visible flow in a real browser and confirm console/network errors are zero.",
      codex:
        "Capture desktop and narrow-viewport screenshots and verify visible text, counts, and button states match reality.",
      gemini:
        "Inspect rendered screenshots carefully for layout shifts, truncated labels, and stale counters across state transitions.",
    },
    instructions: [
      "Walk every acceptance criterion against the running app in a real browser, not just unit tests.",
      "Check empty, active, completed, and error states; verify zero console errors and save screenshots to the run folder.",
    ].join("\n"),
  },
  {
    name: "scorched-earth-qa",
    title: "Scorched Earth Zero-Trust QA",
    description:
      "Inventory plus git diff scenarios, a seeded state matrix, and live playtesting that trusts nothing it did not observe.",
    category: "testing",
    roles: ["scenario-generator", "playtester", "troubleshooter", "verifier"],
    families: ["claude", "codex", "gemini"],
    familyGuidance: {
      claude:
        "Do not anchor on the builder's inventory or summary; diff it against git diff yourself and treat every unlisted change as untested.",
      codex:
        "Seed each state with exact fixture commands, run the scenario, and quote observed copy, counts, and outputs verbatim next to the expected values.",
      gemini:
        "Inspect every screenshot for stale counters, wrong badges, truncated labels, and tooltips that disagree with the seeded data before marking PASS.",
    },
    instructions: [
      "Build scenarios from BOTH surface-inventory.json and the real git diff, so unlisted side effects and regressions are covered.",
      "Seed a realistic state matrix (empty, in-progress, completed, error or limited) and state the exact expected copy, counts, badges, tooltips, and outputs for each.",
      "Playtest against the live app or runtime only. A scenario passes when you saw it pass, never because the code looks right.",
      "Report PASS/FAIL per scenario with observed vs expected evidence, and diagnose failures to a file:line root cause before any fix.",
    ].join("\n"),
  },
  {
    name: "docs-changelog",
    title: "Docs & PR Summary Craft",
    description:
      "Concise changelogs, accurate user/ops docs, and clear PR descriptions matching repository voice.",
    category: "docs",
    roles: ["writer"],
    families: ["claude", "codex", "gemini"],
    instructions: [
      "Update documentation only where behavior changed or existing guidance became inaccurate.",
      "Write concise PR descriptions covering problem, fix, verification, and risks.",
    ].join("\n"),
  },
];

/** Map a provider driver, instance id, or model slug to one of the Big-3 model families. */
export function detectModelFamily(driverOrModel: string | null | undefined): ModelFamily | null {
  const normalized = (driverOrModel ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized.includes("claude") ||
    normalized.includes("anthropic") ||
    normalized.includes("opus") ||
    normalized.includes("sonnet") ||
    normalized.includes("haiku") ||
    normalized.includes("fable")
  ) {
    return "claude";
  }
  if (
    normalized.includes("codex") ||
    normalized.includes("openai") ||
    normalized.includes("chatgpt") ||
    normalized.includes("gpt") ||
    normalized.includes("astra") ||
    normalized.includes("terra") ||
    /(?:^|[-_/.\s])(sol|o1|o3|o4)(?:$|[-_/.\s])/.test(normalized)
  ) {
    return "codex";
  }
  if (
    normalized.includes("gemini") ||
    normalized.includes("antigravity") ||
    normalized.includes("google") ||
    normalized.includes("hydrogen") ||
    normalized.includes("neon") ||
    normalized.includes("carbon") ||
    normalized.includes("argon")
  ) {
    return "gemini";
  }
  return null;
}

export interface MatchedSkill {
  readonly name: string;
  readonly entry: SkillEntry | null;
  readonly source: "role" | "catalog";
  readonly familyGuidance: string | null;
}

/**
 * Resolve the ordered, deduplicated list of skills required for a `(role, modelFamily)` pair:
 * 1. Explicit `role.skills` (always included, enriched with catalog metadata + family guidance).
 * 2. Skill Database entries matching both `role.name` and `modelFamily` (or all families when null).
 */
export function matchSkillsForRole(input: {
  readonly config: Pick<PipelineConfig, "skills">;
  readonly role: Role;
  readonly modelFamily?: ModelFamily | null | undefined;
}): ReadonlyArray<MatchedSkill> {
  const matched: Array<MatchedSkill> = [];
  const seen = new Set<string>();
  const family = input.modelFamily ?? null;

  const guidanceFor = (entry: SkillEntry | null): string | null => {
    if (entry === null || family === null) return null;
    const note = entry.familyGuidance?.[family]?.trim();
    return note && note.length > 0 ? note : null;
  };

  for (const rawName of input.role.skills ?? []) {
    const name = rawName.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = input.config.skills.get(name) ?? null;
    matched.push({
      name,
      entry,
      source: "role",
      familyGuidance: guidanceFor(entry),
    });
  }

  for (const entry of input.config.skills.values()) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    if (!entry.roles.includes(input.role.name)) continue;
    if (family !== null && !entry.families.includes(family)) continue;
    seen.add(key);
    matched.push({
      name: entry.name,
      entry,
      source: "catalog",
      familyGuidance: guidanceFor(entry),
    });
  }

  return matched;
}

export interface GeminiOrchestratorUpgrade {
  readonly slug: string;
  readonly name: string;
}

const GEMINI_ORCHESTRATOR_CANDIDATES: ReadonlyArray<{
  readonly match: string;
  readonly slugs: ReadonlyArray<string>;
}> = [
  { match: "neon", slugs: ["gemini-pro-orchestrator-neon"] },
  { match: "carbon", slugs: ["gemini-pro-orchestrator"] },
  { match: "argon", slugs: ["gemini-pro-orchestrator-argon", "gemini-pro-orchestrator-g1-pro"] },
  { match: "hydrogen", slugs: ["gemini-4-hydrogen-orchestrator"] },
];

/**
 * When a user picks a standard Gemini model (`gemini-4-neon`, `gemini-4-carbon`, `gemini-4-argon`,
 * `gemini-4-hydrogen`) as a PM or Swarm orchestrator, return the matching Antigravity Orchestrator
 * variant if installed on the same provider.
 */
export function findGeminiOrchestratorUpgrade(
  currentModel: string | null | undefined,
  availableModels: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
): GeminiOrchestratorUpgrade | null {
  const normalized = (currentModel ?? "").trim().toLowerCase();
  if (!normalized || normalized.includes("orchestrator") || !normalized.includes("gemini")) {
    return null;
  }
  const entry = GEMINI_ORCHESTRATOR_CANDIDATES.find((candidate) =>
    normalized.includes(candidate.match),
  );
  if (entry === undefined) return null;
  for (const targetSlug of entry.slugs) {
    const found = availableModels.find((model) => model.slug.toLowerCase() === targetSlug);
    if (found !== undefined) {
      return { slug: found.slug, name: found.name };
    }
  }
  return null;
}
