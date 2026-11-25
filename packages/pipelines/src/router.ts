import { MULTIMODAL_HINTS, PROVIDER_ALIASES } from "./builtin/tiers.ts";
import {
  EFFORT_ORDER,
  TIER_ORDER,
  type Candidate,
  type Effort,
  type PipelineConfig,
  type Role,
  type Tier,
} from "./schema.ts";

/** What the router needs to know about one installed model. */
export interface ProviderModelInfo {
  readonly slug: string;
  readonly name: string;
  /** The model's reasoning or effort control, when it has one. */
  readonly reasoning?: { readonly id: string; readonly choices: ReadonlyArray<string> } | undefined;
}

/** One provider instance (an account), as the server sees it right now. */
export interface ProviderSnapshot {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly displayName?: string | null | undefined;
  readonly models: ReadonlyArray<ProviderModelInfo>;
}

export interface OptionSelection {
  readonly id: string;
  readonly value: string | boolean;
}

export interface ResolveInput {
  readonly config: PipelineConfig;
  readonly role: string;
  readonly providers: ReadonlyArray<ProviderSnapshot>;
  /** Tiers to climb above the role's tier, after failed attempts. Capped at the role's maxTier. */
  readonly escalate?: number | undefined;
  /** Provider instances out of usage until the given time (ISO). */
  readonly limited?: ReadonlyMap<string, string> | undefined;
  /** Driver kinds to avoid for an independent second opinion (the builder's vendor, say). */
  readonly avoidDrivers?: ReadonlyArray<string> | undefined;
}

export interface ResolvedSelection {
  readonly instanceId: string;
  readonly driver: string;
  readonly model: string;
  readonly options: ReadonlyArray<OptionSelection>;
}

export type Resolution =
  | {
      readonly ok: true;
      readonly role: Role;
      readonly tier: Tier;
      readonly selection: ResolvedSelection;
      readonly candidate: Candidate;
      /** Plain-language notes on any compromise the router made. */
      readonly notes: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Why each candidate was passed over. */
      readonly tried: ReadonlyArray<string>;
    };

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[\s_]+/)
    .filter((word) => word.length > 0);

/** Numbers in a model id, for "newest version wins": claude-opus-5-5 → [5, 5]. */
export const versionOf = (slug: string): ReadonlyArray<number> =>
  (slug.match(/\d+(?:\.\d+)?/g) ?? []).flatMap((part) => part.split(".").map(Number));

const compareVersionsDesc = (a: string, b: string) => {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let index = 0; index < Math.max(va.length, vb.length); index++) {
    const difference = (vb[index] ?? -1) - (va[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The model a candidate means on one provider: an exact id first, else the newest model whose
 * id or name contains every word of `wanted`.
 */
export function matchModel(
  models: ReadonlyArray<ProviderModelInfo>,
  wanted: string,
): ProviderModelInfo | undefined {
  const exact = models.find((model) => model.slug.toLowerCase() === wanted.toLowerCase());
  if (exact !== undefined) return exact;
  const needles = words(wanted.replace(/-/g, " "));
  const matches = models.filter((model) => {
    const haystack = `${model.slug} ${model.name}`.toLowerCase();
    return needles.every((needle) => haystack.includes(needle));
  });
  return [...matches].sort((a, b) => compareVersionsDesc(a.slug, b.slug))[0];
}

/** Provider instances a candidate's `provider` names: an instance id, or a driver kind or alias. */
export function matchProviders(
  providers: ReadonlyArray<ProviderSnapshot>,
  wanted: string,
): ReadonlyArray<ProviderSnapshot> {
  const byInstance = providers.filter((provider) => provider.instanceId === wanted);
  if (byInstance.length > 0) return byInstance;
  const drivers = new Set(
    (PROVIDER_ALIASES[wanted.toLowerCase()] ?? [wanted]).map((driver) => driver.toLowerCase()),
  );
  return providers.filter((provider) => drivers.has(provider.driver.toLowerCase()));
}

/** The effort choice closest to `wanted` that the model offers, preferring one step lower. */
export function pickEffort(choices: ReadonlyArray<string>, wanted: Effort): string | undefined {
  const lower = choices.map((choice) => choice.toLowerCase());
  if (lower.includes(wanted)) return choices[lower.indexOf(wanted)];
  const rank = EFFORT_ORDER.indexOf(wanted);
  for (let distance = 1; distance < EFFORT_ORDER.length; distance++) {
    for (const candidate of [EFFORT_ORDER[rank - distance], EFFORT_ORDER[rank + distance]]) {
      if (candidate !== undefined && lower.includes(candidate))
        return choices[lower.indexOf(candidate)];
    }
  }
  return undefined;
}

const isMultimodalHint = (candidate: Candidate) =>
  MULTIMODAL_HINTS.some((hint) => words(candidate.model).some((word) => word.includes(hint)));

const tierIndex = (tier: Tier) => TIER_ORDER.indexOf(tier);

/** Tiers to try, in order: the target tier, higher ones up to the cap, then lower ones. */
const tierWalk = (role: Role, escalate: number): ReadonlyArray<Tier> => {
  const cap = tierIndex(role.maxTier ?? "frontier");
  const start = Math.min(tierIndex(role.tier) + Math.max(0, escalate), cap);
  const walk: Array<Tier> = [];
  for (let index = start; index <= cap; index++) walk.push(TIER_ORDER[index]!);
  for (let index = start - 1; index >= 0; index--) walk.push(TIER_ORDER[index]!);
  return walk;
};

/**
 * Pick the model for a worker in `role`. Walks the role's own candidates, then its tier's,
 * across every signed-in account; skips accounts at their usage limit; prefers a vendor other
 * than `avoidDrivers`, but takes the same vendor rather than nothing.
 */
export function resolveRole(input: ResolveInput): Resolution {
  const role = input.config.roles.get(input.role);
  if (role === undefined) {
    return {
      ok: false,
      reason: `There is no role "${input.role}". Roles: ${[...input.config.roles.keys()].join(", ")}.`,
      tried: [],
    };
  }
  const escalate = input.escalate ?? 0;
  const avoid = new Set((input.avoidDrivers ?? []).map((driver) => driver.toLowerCase()));
  const tried: Array<string> = [];

  type Option = {
    tier: Tier;
    candidate: Candidate;
    provider: ProviderSnapshot;
    model: ProviderModelInfo;
  };
  const options: Array<Option> = [];
  const walk = tierWalk(role, escalate);
  walk.forEach((tier, position) => {
    const fromTier = input.config.tiers[tier];
    const ordered =
      role.multimodal === true
        ? [...fromTier.filter(isMultimodalHint), ...fromTier.filter((c) => !isMultimodalHint(c))]
        : fromTier;
    const list =
      position === 0 && escalate === 0 && role.candidates !== undefined
        ? [...role.candidates, ...ordered]
        : ordered;
    for (const candidate of list) {
      const providers = matchProviders(input.providers, candidate.provider);
      if (providers.length === 0) {
        tried.push(
          `${candidate.provider}/${candidate.model}: no ${candidate.provider} account is set up.`,
        );
        continue;
      }
      for (const provider of providers) {
        const label = `${provider.instanceId}/${candidate.model}`;
        if (!provider.enabled) {
          tried.push(`${label}: the account is turned off.`);
          continue;
        }
        const until = input.limited?.get(provider.instanceId);
        if (until !== undefined) {
          tried.push(`${label}: at its usage limit until ${until}.`);
          continue;
        }
        const model = matchModel(provider.models, candidate.model);
        if (model === undefined) {
          tried.push(`${label}: no installed model matches "${candidate.model}".`);
          continue;
        }
        options.push({ tier, candidate, provider, model });
      }
    }
  });

  if (options.length === 0) {
    return {
      ok: false,
      reason: `No signed-in account can run role ${role.name} right now.`,
      tried,
    };
  }

  // A second vendor is worth having, but not at the cost of a weaker tier.
  const bestTier = options[0]!.tier;
  const preferred = options.find(
    (option) => option.tier === bestTier && !avoid.has(option.provider.driver.toLowerCase()),
  );
  const chosen = preferred ?? options[0]!;
  const notes: Array<string> = [];
  const target = walk[0]!;
  if (chosen.tier !== target) {
    notes.push(
      tierIndex(chosen.tier) > tierIndex(target)
        ? `Ran on the ${chosen.tier} tier because no ${target} model was available.`
        : `Ran on the ${chosen.tier} tier, below the ${target} tier this role wants, because nothing at or above it was available.`,
    );
  }
  if (preferred === undefined && avoid.size > 0) {
    notes.push(
      `Same vendor as the work it checks (${chosen.provider.driver}): no other vendor's account is available, so it is a fresh session rather than a second vendor.`,
    );
  }
  const skippedLimited = tried.filter((line) => line.includes("usage limit"));
  if (skippedLimited.length > 0) notes.push(`Skipped: ${skippedLimited.join(" ")}`);

  const effort = chosen.candidate.effort ?? role.effort;
  const selections: Array<OptionSelection> = [];
  if (effort !== undefined && chosen.model.reasoning !== undefined) {
    const value = pickEffort(chosen.model.reasoning.choices, effort);
    if (value !== undefined) selections.push({ id: chosen.model.reasoning.id, value });
  }
  for (const [id, value] of Object.entries(chosen.candidate.options ?? {})) {
    if (!selections.some((selection) => selection.id === id)) selections.push({ id, value });
  }

  return {
    ok: true,
    role,
    tier: chosen.tier,
    candidate: chosen.candidate,
    selection: {
      instanceId: chosen.provider.instanceId,
      driver: chosen.provider.driver,
      model: chosen.model.slug,
      options: selections,
    },
    notes,
  };
}
