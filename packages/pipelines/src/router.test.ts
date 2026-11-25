import { describe, expect, it } from "@effect/vitest";

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
});
