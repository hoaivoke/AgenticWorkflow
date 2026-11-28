// pipelines: token cost estimation, frontier-baseline comparison, and cache-hit metrics.

export type ModelPriceTier = "frontier" | "mid" | "small";

interface TierRatesPerMillion {
  readonly inputUsd: number;
  readonly cachedInputUsd: number;
  readonly outputUsd: number;
}

const TIER_RATES: Record<ModelPriceTier, TierRatesPerMillion> = {
  frontier: { inputUsd: 15, cachedInputUsd: 1.5, outputUsd: 75 },
  mid: { inputUsd: 3, cachedInputUsd: 0.3, outputUsd: 15 },
  small: { inputUsd: 0.8, cachedInputUsd: 0.08, outputUsd: 4 },
};

/** Classify a model slug or tier hint into pricing tier for cost telemetry & budget guardrails. */
export function classifyModelPriceTier(
  modelOrTier: string | null | undefined,
  explicitTier?: string | null,
): ModelPriceTier {
  if (explicitTier === "small" || explicitTier === "mid" || explicitTier === "frontier") {
    return explicitTier;
  }
  const normalized = (modelOrTier ?? "").toLowerCase();
  if (
    normalized.includes("haiku") ||
    normalized.includes("hydrogen") ||
    normalized.includes("terra") ||
    /(?:^|[-_/.\s])mini(?:$|[-_/.\s])/.test(normalized) ||
    normalized.includes("flash") ||
    /(?:^|[-_/.\s])nano(?:$|[-_/.\s])/.test(normalized)
  ) {
    return "small";
  }
  if (
    normalized.includes("opus") ||
    normalized.includes("fable") ||
    normalized.includes("astra") ||
    normalized.includes("carbon") ||
    normalized.includes("pro-high") ||
    normalized.includes("gpt-5.4") ||
    normalized.includes("o1") ||
    normalized.includes("o3")
  ) {
    return "frontier";
  }
  return "mid";
}

function tokensCostUsd(
  rates: TierRatesPerMillion,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
): number {
  const safeInput = Math.max(0, inputTokens);
  const safeCached = Math.max(0, Math.min(safeInput, cachedTokens));
  const uncachedInput = Math.max(0, safeInput - safeCached);
  const safeOutput = Math.max(0, outputTokens);
  const total =
    (uncachedInput * rates.inputUsd +
      safeCached * rates.cachedInputUsd +
      safeOutput * rates.outputUsd) /
    1_000_000;
  return Math.round(total * 10_000) / 10_000;
}

export function estimateUsageCost(input: {
  readonly model?: string | null | undefined;
  readonly tier?: string | null | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}): {
  readonly priceTier: ModelPriceTier;
  readonly costUsd: number;
  readonly frontierBaselineUsd: number;
} {
  const priceTier = classifyModelPriceTier(input.model, input.tier);
  const costUsd = tokensCostUsd(
    TIER_RATES[priceTier],
    input.inputTokens,
    input.outputTokens,
    input.cachedTokens,
  );
  // Compare against running uncached all-frontier Opus on the full token stream.
  const frontierBaselineUsd = tokensCostUsd(
    TIER_RATES.frontier,
    input.inputTokens,
    input.outputTokens,
    0,
  );
  return { priceTier, costUsd, frontierBaselineUsd };
}

export function computeSavingsPercent(spentUsd: number, baselineFrontierUsd: number): number {
  if (!(baselineFrontierUsd > 0)) return 0;
  const raw = ((baselineFrontierUsd - spentUsd) / baselineFrontierUsd) * 100;
  return Math.round(Math.max(-999, Math.min(100, raw)) * 10) / 10;
}

export function computeCacheHitPercent(inputTokens: number, cachedTokens: number): number {
  if (!(inputTokens > 0)) return 0;
  const pct = (Math.min(inputTokens, Math.max(0, cachedTokens)) / inputTokens) * 100;
  return Math.round(pct * 10) / 10;
}
