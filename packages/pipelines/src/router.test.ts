import { describe, expect, it } from "@effect/vitest";

import {
  detectModelFamily,
  findGeminiOrchestratorUpgrade,
  matchSkillsForRole,
} from "./builtin/skills.ts";
import { loadPipelineConfig } from "./load.ts";
import {
  renderPipeline,
  renderPipelineList,
  renderRoleBrief,
  renderRoles,
  renderScheduledWorkerPrompt,
} from "./render.ts";
import { matchModel, pickEffort, resolveRole, versionOf, type ProviderSnapshot } from "./router.ts";

const reasoning = (id: string) => ({ id, choices: ["low", "medium", "high", "xhigh"] });

const claude: ProviderSnapshot = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  enabled: true,
  models: [
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: reasoning("effort") },
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: reasoning("effort") },
    { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: reasoning("effort") },
    {
      slug: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      reasoning: { id: "effort", choices: ["low", "medium"] },
    },
  ],
};
const claudeWork: ProviderSnapshot = { ...claude, instanceId: "claude-work" };
const codex: ProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  models: [
    { slug: "gpt-6.2-astra", name: "GPT-6.2 Astra", reasoning: reasoning("reasoningEffort") },
    { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoning: reasoning("reasoningEffort") },
    { slug: "gpt-6.2-sol", name: "GPT-6.2 Sol", reasoning: reasoning("reasoningEffort") },
    { slug: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
  ],
};
const antigravity: ProviderSnapshot = {
  instanceId: "antigravity",
  driver: "antigravity",
  enabled: true,
  models: [
    { slug: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
    { slug: "gemini-4-neon", name: "Gemini 4 Neon" },
    { slug: "gemini-4-carbon", name: "Gemini 4 Carbon" },
  ],
};

const { config } = loadPipelineConfig([]);
const all = [claude, codex, antigravity];

describe("matchModel", () => {
  it("prefers an exact id, else the newest version containing the words", () => {
    expect(matchModel(claude.models, "claude-opus-4-6")?.slug).toBe("claude-opus-4-6");
    expect(matchModel(claude.models, "opus")?.slug).toBe("claude-opus-5-5");
    expect(matchModel(codex.models, "sol")?.slug).toBe("gpt-6.2-sol");
    expect(matchModel(codex.models, "gpt 6.1 sol")?.slug).toBe("gpt-6.1-sol");
    expect(matchModel(codex.models, "haiku")).toBeUndefined();
  });

  it("reads versions from ids", () => {
    expect(versionOf("claude-opus-5-5")).toEqual([5, 5]);
    expect(versionOf("gpt-6.2-astra")).toEqual([6, 2]);
  });
});

describe("pickEffort", () => {
  it("takes the wanted level, else the nearest, lower first", () => {
    expect(pickEffort(["low", "medium", "high"], "high")).toBe("high");
    expect(pickEffort(["low", "medium"], "high")).toBe("medium");
    expect(pickEffort(["high", "max"], "low")).toBe("high");
    expect(pickEffort([], "high")).toBeUndefined();
  });
});

describe("resolveRole", () => {
  it("runs a role on its tier's first available model, with its effort option", () => {
    const result = resolveRole({ config, role: "builder", providers: all });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe("mid");
    expect(result.selection).toEqual({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(result.notes).toEqual([]);
  });

  it("maps effort onto each provider's own option id", () => {
    const result = resolveRole({ config, role: "builder", providers: [codex] });
    expect(result.ok && result.selection.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("uses small models for small roles and clamps effort to what the model offers", () => {
    const result = resolveRole({ config, role: "triage", providers: all });
    expect(result.ok && result.selection.model).toBe("claude-haiku-5-5");
    expect(result.ok && result.selection.options).toEqual([{ id: "effort", value: "medium" }]);
  });

  it("falls over to another vendor when an account is at its usage limit", () => {
    const limited = new Map([["claudeAgent", "2026-11-25T03:00:00Z"]]);
    const result = resolveRole({ config, role: "builder", providers: all, limited });
    expect(result.ok && result.selection.model).toBe("gpt-6.2-sol");
    expect(result.ok && result.notes.join(" ")).toContain("usage limit");
  });

  it("falls over to antigravity across tiers when both claude and codex are out of usage", () => {
    const limited = new Map([
      ["claudeAgent", "2026-11-25T03:00:00Z"],
      ["codex", "2026-11-25T03:00:00Z"],
    ]);
    const light = resolveRole({ config, role: "triage", providers: all, limited });
    expect(light.ok && light.selection.model).toBe("gemini-4-hydrogen");
    const mid = resolveRole({ config, role: "builder", providers: all, limited });
    expect(mid.ok && mid.selection.model).toBe("gemini-4-neon");
    const heavy = resolveRole({ config, role: "architect", providers: all, limited });
    expect(heavy.ok && heavy.selection.model).toBe("gemini-4-carbon");
    const noCarbon = [
      claude,
      codex,
      { ...antigravity, models: antigravity.models.filter((m) => !m.slug.includes("carbon")) },
    ];
    const heavyNeon = resolveRole({ config, role: "architect", providers: noCarbon, limited });
    expect(heavyNeon.ok && heavyNeon.selection.model).toBe("gemini-4-neon");
    const fableClaude: ProviderSnapshot = {
      ...claude,
      models: [
        { slug: "claude-fable-5-2", name: "Claude Fable 5.2", reasoning: reasoning("effort") },
      ],
    };
    const heavyFable = resolveRole({ config, role: "architect", providers: [fableClaude] });
    expect(heavyFable.ok && heavyFable.selection.model).toBe("claude-fable-5-2");
  });

  it("falls over from direct Claude to Antigravity-hosted Sonnet and Opus before other vendors, never gpt-oss", () => {
    const agWithClaude: ProviderSnapshot = {
      ...antigravity,
      models: [
        ...antigravity.models,
        { slug: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
        { slug: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
        { slug: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    };
    const claudeLimited = new Map([["claudeAgent", "2026-11-25T03:00:00Z"]]);
    const mid = resolveRole({
      config,
      role: "builder",
      providers: [claude, codex, agWithClaude],
      limited: claudeLimited,
    });
    expect(mid.ok && mid.selection.instanceId).toBe("antigravity");
    expect(mid.ok && mid.selection.model).toBe("claude-sonnet-5-5-high");

    const heavy = resolveRole({
      config,
      role: "architect",
      providers: [claude, codex, agWithClaude],
      limited: claudeLimited,
    });
    expect(heavy.ok && heavy.selection.instanceId).toBe("antigravity");
    expect(heavy.ok && heavy.selection.model).toBe("claude-opus-5-5-high");

    const onlyGptOss: ProviderSnapshot = {
      ...antigravity,
      models: [{ slug: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }],
    };
    const none = resolveRole({ config, role: "builder", providers: [onlyGptOss] });
    expect(none.ok).toBe(false);
  });

  it("tries a second account of the same vendor first", () => {
    const limited = new Map([["claudeAgent", "2026-11-25T03:00:00Z"]]);
    const result = resolveRole({
      config,
      role: "builder",
      providers: [claude, claudeWork, codex],
      limited,
    });
    expect(result.ok && result.selection.instanceId).toBe("claude-work");
  });

  it("picks another vendor for independent review, at the same tier", () => {
    const result = resolveRole({
      config,
      role: "reviewer",
      providers: all,
      avoidDrivers: ["claudeAgent"],
    });
    expect(result.ok && result.selection.instanceId).toBe("codex");
    expect(result.ok && result.tier).toBe("mid");
  });

  it("keeps the tier rather than switching vendor when only a weaker tier differs", () => {
    const onlyClaudeMid = [claude, { ...antigravity, models: [antigravity.models[0]!] }];
    const result = resolveRole({
      config,
      role: "reviewer",
      providers: onlyClaudeMid,
      avoidDrivers: ["claudeAgent"],
    });
    expect(result.ok && result.selection.model).toBe("claude-sonnet-5-5");
    expect(result.ok && result.notes.join(" ")).toContain("Same vendor");
  });

  it("escalates one tier on request, up to the role's cap", () => {
    const up = resolveRole({ config, role: "builder", providers: all, escalate: 1 });
    expect(up.ok && up.selection.model).toBe("claude-opus-5-5");
    const capped = resolveRole({ config, role: "gatekeeper", providers: all, escalate: 2 });
    expect(capped.ok && capped.tier).toBe("small");
  });

  it("climbs a tier when its own tier has nothing, and says so", () => {
    const noMid = [
      { ...claude, models: claude.models.filter((model) => !model.slug.includes("sonnet")) },
    ];
    const result = resolveRole({ config, role: "builder", providers: noMid });
    expect(result.ok && result.selection.model).toBe("claude-opus-5-5");
    expect(result.ok && result.notes[0]).toContain("frontier tier");
  });

  it("orders image-reading models first for multimodal roles", () => {
    const result = resolveRole({ config, role: "ui-builder", providers: all });
    expect(result.ok && result.selection.model).toBe("gemini-4-neon");
  });

  it("explains when nothing can run", () => {
    const result = resolveRole({
      config,
      role: "builder",
      providers: [{ ...claude, enabled: false }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.tried.join(" ")).toContain("turned off");
    expect(resolveRole({ config, role: "nope", providers: all }).ok).toBe(false);
  });
});

describe("loadPipelineConfig", () => {
  it("ships consistent built-ins", () => {
    expect(loadPipelineConfig([]).problems.join(" | ")).toBe("");
    expect([...config.pipelines.keys()]).toContain("feature");
  });

  it("lets a project override tiers, roles and pipelines", () => {
    const { config: custom, problems } = loadPipelineConfig([
      { path: "tiers.yaml", text: "mid:\n  - { provider: codex, model: sol, effort: medium }\n" },
      {
        path: "roles/builder.yaml",
        text: "description: Builds\ntier: small\ninstructions: Build it.\n",
      },
      {
        path: "pipelines/tiny.yaml",
        text: "description: Tiny\nwhen: always\nstages:\n  - { id: build, role: builder, goal: Do it }\n",
      },
    ]);
    expect(problems).toEqual([]);
    expect(custom.roles.get("builder")?.tier).toBe("small");
    expect(custom.tiers.mid).toHaveLength(1);
    expect(custom.tiers.frontier.length).toBeGreaterThan(0);
    expect(custom.pipelines.get("tiny")?.stages).toHaveLength(1);
    expect(custom.sources.get("role:builder")).toBe(".pipelines/roles/builder.yaml");
  });

  it("skips broken files and bad references without losing the built-ins", () => {
    const { config: custom, problems } = loadPipelineConfig([
      { path: "roles/builder.yaml", text: "tier: huge\n" },
      {
        path: "pipelines/feature.yaml",
        text: "description: x\nwhen: y\nstages:\n  - { id: a, role: ghost, goal: g }\n",
      },
      { path: "tiers.yaml", text: "mid: [ {" },
    ]);
    expect(problems).toHaveLength(3);
    expect(custom.roles.get("builder")?.tier).toBe("mid");
    expect(custom.pipelines.get("feature")?.stages.length).toBeGreaterThan(5);
  });
});

describe("skill database", () => {
  it("maps drivers, instance ids and model slugs to Big-3 families", () => {
    expect(detectModelFamily("claudeAgent")).toBe("claude");
    expect(detectModelFamily("claude-haiku-5-5")).toBe("claude");
    expect(detectModelFamily("codex")).toBe("codex");
    expect(detectModelFamily("gpt-6.2-sol")).toBe("codex");
    expect(detectModelFamily("antigravity")).toBe("gemini");
    expect(detectModelFamily("gemini-4-neon")).toBe("gemini");
    expect(detectModelFamily("cursor")).toBeNull();
    expect(detectModelFamily("")).toBeNull();
    expect(detectModelFamily(null)).toBeNull();
  });

  it("finds the matching Antigravity Orchestrator upgrade for standard Gemini models", () => {
    const models = [
      { slug: "gemini-4-neon", name: "Gemini 4 Neon" },
      { slug: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
      { slug: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
      { slug: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)" },
      { slug: "gemini-4-hydrogen-orchestrator", name: "Orchestrator (Hydrogen)" },
    ];
    expect(findGeminiOrchestratorUpgrade("gemini-4-neon-medium", models)).toEqual({
      slug: "gemini-pro-orchestrator-neon",
      name: "Orchestrator (Neon)",
    });
    expect(findGeminiOrchestratorUpgrade("gemini-4-carbon-high", models)).toEqual({
      slug: "gemini-pro-orchestrator",
      name: "Orchestrator (Carbon)",
    });
    expect(findGeminiOrchestratorUpgrade("gemini-4-argon-low", models)).toEqual({
      slug: "gemini-pro-orchestrator-argon",
      name: "Orchestrator (Argon)",
    });
    expect(findGeminiOrchestratorUpgrade("gemini-4-hydrogen-medium", models)).toEqual({
      slug: "gemini-4-hydrogen-orchestrator",
      name: "Orchestrator (Hydrogen)",
    });
    expect(findGeminiOrchestratorUpgrade("gemini-pro-orchestrator-neon", models)).toBeNull();
    expect(findGeminiOrchestratorUpgrade("claude-opus-5-5", models)).toBeNull();
  });

  it("matches role skills first, then catalog skills for the role's family", () => {
    const uiBuilder = config.roles.get("ui-builder")!;
    const names = (family: "claude" | "codex" | "gemini" | null) =>
      matchSkillsForRole({ config, role: uiBuilder, modelFamily: family }).map((s) => s.name);

    const gemini = names("gemini");
    expect(gemini.slice(0, 2)).toEqual(["modern-web-guidance", "a11y-debugging"]);
    expect(gemini).toContain("gemini-frontend-design");
    expect(gemini).toContain("browser-e2e-qa");
    expect(names("claude")).not.toContain("gemini-frontend-design");
    expect(names("codex")).not.toContain("gemini-frontend-design");
    // Unknown family includes every family's skills.
    expect(names(null)).toContain("gemini-frontend-design");

    const [first] = matchSkillsForRole({ config, role: uiBuilder, modelFamily: "codex" });
    expect(first?.source).toBe("role");
    expect(first?.familyGuidance).toContain("1440px");

    const builder = matchSkillsForRole({
      config,
      role: config.roles.get("builder")!,
      modelFamily: "claude",
    });
    expect(builder.map((s) => s.name)).toEqual(["tdd-verification", "diff-discipline"]);
    expect(builder.every((s) => s.source === "catalog")).toBe(true);
  });

  it("lets .pipelines/skills.yaml and skills/*.yaml override and extend the catalog", () => {
    const { config: custom, problems } = loadPipelineConfig([
      {
        path: "skills.yaml",
        text: [
          "- name: tdd-verification",
          "  title: Project TDD",
          "  description: Our TDD rules",
          "  category: testing",
          "  roles: [builder]",
          "  families: [codex]",
          "  instructions: Run vp test run.",
        ].join("\n"),
      },
      {
        path: "skills/rust-safety.yaml",
        text: [
          "title: Rust safety",
          "description: Unsafe audit",
          "category: backend",
          "roles: [builder]",
          "families: [claude, gemini]",
          "familyGuidance: { claude: Check every unsafe block. }",
          "instructions: Audit unsafe code.",
        ].join("\n"),
      },
      { path: "skills/broken.yaml", text: "title: Broken\n" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("skills/broken.yaml");
    expect(custom.skills.get("tdd-verification")?.instructions).toBe("Run vp test run.");
    expect(custom.sources.get("skill:tdd-verification")).toBe(".pipelines/skills.yaml");
    expect(custom.sources.get("skill:rust-safety")).toBe(".pipelines/skills/rust-safety.yaml");
    expect(custom.sources.get("skill:diff-discipline")).toBe("built-in");

    const builder = custom.roles.get("builder")!;
    const forClaude = matchSkillsForRole({ config: custom, role: builder, modelFamily: "claude" });
    expect(forClaude.map((s) => s.name)).toEqual(["diff-discipline", "rust-safety"]);
    expect(forClaude[1]?.familyGuidance).toBe("Check every unsafe block.");
    const forCodex = matchSkillsForRole({ config: custom, role: builder, modelFamily: "codex" });
    expect(forCodex.map((s) => s.name)).toEqual(["tdd-verification", "diff-discipline"]);
  });
});

describe("render", () => {
  it("lists pipelines and renders a plan with the routing rules", () => {
    expect(renderPipelineList(config)).toContain("- feature:");
    const plan = renderPipeline(config, "feature") ?? "";
    expect(plan).toContain("1. spec: role product (mid tier).");
    expect(plan).toContain("pass avoid_provider_of with the thread of stage build");
    expect(plan).toContain("escalate: 1");
    expect(renderPipeline(config, "missing")).toBeUndefined();
  });

  it("shows each role's current model and the limits", () => {
    const text = renderRoles(config, all, new Map([["codex", "2026-11-25T03:00:00Z"]]));
    expect(text).toContain("- architect: frontier tier, read-only.");
    expect(text).toContain("Now: claudeAgent/claude-opus-5-5 (effort=high).");
    expect(text).toContain("- codex until 2026-11-25T03:00:00Z");
  });

  it("writes a scheduled worker message the PM can replay exactly", () => {
    const args = {
      title: "Nightly audit",
      brief: 'Audit "auth/".\nReport findings.',
      role: "security-reviewer",
    };
    const prompt = renderScheduledWorkerPrompt("Nightly audit", args);
    expect(prompt.startsWith("Scheduled worker: Nightly audit\n")).toBe(true);
    const json = prompt.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "";
    expect(JSON.parse(json)).toEqual(args);
  });

  it("writes a role brief", () => {
    const brief = renderRoleBrief(config.roles.get("reviewer")!, "mid");
    expect(brief).toContain("## Your role: reviewer (mid tier)");
    expect(brief).toContain("read-only");
  });

  it("loads scorched-earth cleanly with 9 stages, resolvable roles, Big-3 QA skill, and capped loops", () => {
    const { config: loaded, problems } = loadPipelineConfig([]);
    expect(problems).toEqual([]);

    const pipeline = loaded.pipelines.get("scorched-earth");
    expect(pipeline).toBeDefined();
    expect(pipeline?.escalateAfter).toBe(2);
    expect(pipeline?.replanAfter).toBe(3);
    expect(pipeline?.stages.map((stage) => stage.id)).toEqual([
      "spec",
      "plan",
      "build",
      "verify-gates",
      "scenarios",
      "playtest",
      "troubleshoot",
      "fix",
      "review",
    ]);

    for (const stage of pipeline?.stages ?? []) {
      const roleName = stage.role ?? "gatekeeper";
      const resolution = resolveRole({ config: loaded, role: roleName, providers: all });
      expect(resolution.ok).toBe(true);
    }

    const playtester = resolveRole({ config: loaded, role: "playtester", providers: all });
    expect(playtester.ok && playtester.selection.model).toBe("gemini-4-neon");
    expect(loaded.roles.get("scenario-generator")?.tier).toBe("frontier");
    expect(loaded.roles.get("troubleshooter")?.tier).toBe("frontier");

    for (const roleName of ["scenario-generator", "playtester", "troubleshooter"] as const) {
      const role = loaded.roles.get(roleName)!;
      for (const family of ["claude", "codex", "gemini"] as const) {
        const matched = matchSkillsForRole({ config: loaded, role, modelFamily: family });
        const qaSkill = matched.find((skill) => skill.name === "scorched-earth-qa");
        expect(qaSkill).toBeDefined();
        expect(qaSkill?.familyGuidance).toBeTruthy();
      }
    }

    const rendered = renderPipeline(loaded, "scorched-earth") ?? "";
    expect(rendered).toContain("after 3 failed cycles, stop looping and ask the user");
  });
});
