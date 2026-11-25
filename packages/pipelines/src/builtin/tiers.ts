import type { TierMap } from "../schema.ts";

/**
 * Default tier map, November 2026 line-ups. Each tier lists one model per vendor so a worker
 * can fall over to another subscription when one hits its usage limit. Model words match
 * the newest installed version (`opus` picks `claude-opus-5-5` over `claude-opus-4-6`).
 * Override in `.pipelines/tiers.yaml`.
 */
export const BUILTIN_TIERS: TierMap = {
  small: [
    { provider: "claude", model: "haiku", effort: "medium" },
    { provider: "antigravity", model: "hydrogen", effort: "medium" },
    { provider: "codex", model: "terra", effort: "medium" },
  ],
  mid: [
    { provider: "claude", model: "sonnet", effort: "high" },
    { provider: "codex", model: "sol", effort: "high" },
    { provider: "antigravity", model: "neon", effort: "high" },
  ],
  frontier: [
    { provider: "claude", model: "opus", effort: "high" },
    { provider: "codex", model: "astra", effort: "high" },
    { provider: "antigravity", model: "carbon", effort: "high" },
  ],
};

/**
 * Models whose vendors lead with image understanding (Gemini 4 Neon takes screenshots, PDFs and
 * video; GPT-6.1 Terra is billed on image understanding and computer use). `multimodal` roles
 * try these first within a tier. Words, matched like candidate models.
 */
export const MULTIMODAL_HINTS: ReadonlyArray<string> = ["neon", "terra"];

/** Words a candidate's `provider` may use for a driver kind. */
export const PROVIDER_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  claude: ["claudeAgent", "claude", "claudeCode"],
  anthropic: ["claudeAgent", "claude", "claudeCode"],
  codex: ["codex"],
  openai: ["codex"],
  antigravity: ["antigravity"],
  gemini: ["antigravity"],
  google: ["antigravity"],
};
