import * as Schema from "effect/Schema";

/**
 * Model tiers. Roles name a tier, and the tier map turns it into an ordered list of
 * candidate models across every provider the user has signed in to.
 */
export const Tier = Schema.Literals(["small", "mid", "frontier"]);
export type Tier = typeof Tier.Type;

export const TIER_ORDER: ReadonlyArray<Tier> = ["small", "mid", "frontier"];

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

export const EFFORT_ORDER: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max"];

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

/**
 * One model to try. `provider` matches a provider instance id (for example a second Claude
 * account named `claude-work`) or a driver kind (`claude`, `codex`, `antigravity`, ...), so one
 * candidate can cover several accounts. `model` is an exact model id, or words that must all
 * appear in the id or name (`opus`, `gpt 6 astra`); the newest matching version wins.
 */
export const Candidate = Schema.Struct({
  provider: NonEmpty,
  model: NonEmpty,
  effort: Schema.optional(Effort),
  /** Raw provider options, passed through as given (ids depend on the provider). */
  options: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
  ),
});
export type Candidate = typeof Candidate.Type;

export const TierMap = Schema.Struct({
  small: Schema.Array(Candidate),
  mid: Schema.Array(Candidate),
  frontier: Schema.Array(Candidate),
});
export type TierMap = typeof TierMap.Type;

/** `.pipelines/tiers.yaml`: any tier it names replaces the built-in list for that tier. */
export const TierMapPatch = Schema.Struct({
  small: Schema.optional(Schema.Array(Candidate)),
  mid: Schema.optional(Schema.Array(Candidate)),
  frontier: Schema.optional(Schema.Array(Candidate)),
});
export type TierMapPatch = typeof TierMapPatch.Type;

/**
 * What a worker in this role may do. `read-only` roles are told never to edit files; the
 * runtime mode is still the PM's to choose, so this is an instruction, not a sandbox.
 */
export const Access = Schema.Literals(["read-only", "write"]);
export type Access = typeof Access.Type;

export const Role = Schema.Struct({
  name: NonEmpty,
  description: NonEmpty,
  tier: Tier,
  /** Highest tier escalation may reach. Defaults to `frontier`. */
  maxTier: Schema.optional(Tier),
  access: Schema.optional(Access),
  /** Needs a model that reads images (screenshots, mockups). Prefers candidates marked so. */
  multimodal: Schema.optional(Schema.Boolean),
  /** Overrides the tier map for this role. Tried before nothing else; escalation still uses tiers. */
  candidates: Schema.optional(Schema.Array(Candidate)),
  effort: Schema.optional(Effort),
  /** Skill names or paths bundled into this role's harness (`SKILL.md`). */
  skills: Schema.optional(Schema.Array(NonEmpty)),
  /** Repo-relative context/guideline files loaded into this role's harness. */
  contextFiles: Schema.optional(Schema.Array(NonEmpty)),
  /** Scoped MCP toolkits/capabilities recommended or enforced for this role. */
  toolkits: Schema.optional(Schema.Array(NonEmpty)),
  /** Expected output artifact path and format for this role. */
  outputContract: Schema.optional(NonEmpty),
  /** Instructions added to every brief in this role. */
  instructions: NonEmpty,
});
export type Role = typeof Role.Type;

export const Stage = Schema.Struct({
  id: NonEmpty,
  /** Role that runs the stage. A stage with only `run` is executed by the `gatekeeper` role. */
  role: Schema.optional(NonEmpty),
  goal: NonEmpty,
  /** Files the stage reads, relative to the run folder. */
  reads: Schema.optional(Schema.Array(NonEmpty)),
  /** Files the stage must leave behind, relative to the run folder. */
  produces: Schema.optional(Schema.Array(NonEmpty)),
  /** Commands that decide pass or fail by exit code. */
  run: Schema.optional(Schema.Array(NonEmpty)),
  /** `each-task`: one worker per task card from the plan. */
  foreach: Schema.optional(Schema.Literal("each-task")),
  parallel: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  workspace: Schema.optional(Schema.Literals(["shared", "worktree"])),
  /** Use a different provider from the one that ran this stage (independent review). */
  differentProviderFrom: Schema.optional(NonEmpty),
  /** Ask the user before the pipeline moves past this stage. */
  approval: Schema.optional(Schema.Boolean),
  /** The PM may skip the stage when its `skipWhen` condition holds. */
  skipWhen: Schema.optional(NonEmpty),
  /** Where a failure sends the work, for example `build`. */
  onFail: Schema.optional(NonEmpty),
});
export type Stage = typeof Stage.Type;

export const Pipeline = Schema.Struct({
  name: NonEmpty,
  description: NonEmpty,
  /** When the PM should pick this pipeline. */
  when: NonEmpty,
  stages: Schema.Array(Stage).check(Schema.isMinLength(1)),
  /** Failed attempts on one card before it moves up a tier. */
  escalateAfter: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  /** Failed attempts on one card before it goes back to planning. */
  replanAfter: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
});
export type Pipeline = typeof Pipeline.Type;

/** The whole configuration after built-ins and project files are merged. */
export interface PipelineConfig {
  readonly tiers: TierMap;
  readonly roles: ReadonlyMap<string, Role>;
  readonly pipelines: ReadonlyMap<string, Pipeline>;
  /** Where each entry came from, for `pm_roles` and error messages. */
  readonly sources: ReadonlyMap<string, string>;
}
