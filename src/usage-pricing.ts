import type { LLMProvider } from './usage-types.js';
import type { PricingRepository, PricingRecord } from './pricing-repository.js';

/**
 * Pricing per 1M tokens: [inputCostPerMillion, outputCostPerMillion]
 * Keyed by model name prefix — longest matching prefix wins.
 */
export const PRICING_TABLE: Record<string, [number, number]> = {
  // Anthropic
  'claude-sonnet-4':        [3, 15],
  'claude-opus-4':          [15, 75],
  'claude-haiku-3.5':       [0.80, 4],
  'claude-3-5-sonnet':      [3, 15],
  'claude-3-5-haiku':       [0.80, 4],
  'claude-3-opus':          [15, 75],
  'claude-3-sonnet':        [3, 15],
  'claude-3-haiku':         [0.25, 1.25],

  // OpenAI
  'gpt-5.2':               [1.75, 14],
  'gpt-4o-mini':            [0.15, 0.60],
  'gpt-4o':                 [2.50, 10],
  'gpt-4-turbo':            [10, 30],
  'gpt-4':                  [30, 60],
  'gpt-3.5-turbo':          [0.50, 1.50],
  'o1-mini':                [3, 12],
  'o1':                     [15, 60],
};

/** Providers that are always free (local / self-hosted). */
const FREE_PROVIDERS = new Set<LLMProvider>(['ollama', 'openai-compatible']);

export type PricingLookup = (model: string) => [number, number] | undefined;

/** Optional DB lookup injected at startup. */
let dbPricingLookup: PricingLookup | undefined;

export function setPricingLookup(lookup: PricingLookup | undefined): void {
  dbPricingLookup = lookup;
}

/**
 * Build a PricingLookup from a repository's records.
 * Uses the same longest-prefix matching logic as findPricing.
 */
export async function buildPricingLookup(repo: PricingRepository): Promise<PricingLookup> {
  const records = await repo.list();
  const table = new Map<string, [number, number]>();
  for (const r of records) {
    table.set(r.modelPrefix.toLowerCase(), [r.inputCostPerMillion, r.outputCostPerMillion]);
  }
  return (model: string): [number, number] | undefined => {
    const lower = model.toLowerCase();
    let bestMatch: [number, number] | undefined;
    let bestLen = 0;
    for (const [prefix, costs] of table) {
      if (lower.startsWith(prefix) && prefix.length > bestLen) {
        bestMatch = costs;
        bestLen = prefix.length;
      }
    }
    return bestMatch;
  };
}

/**
 * Find the pricing entry for a model name using longest-prefix matching.
 */
function findPricing(model: string): [number, number] | undefined {
  const lower = model.toLowerCase();
  let bestMatch: [number, number] | undefined;
  let bestLen = 0;
  for (const [prefix, costs] of Object.entries(PRICING_TABLE)) {
    if (lower.startsWith(prefix) && prefix.length > bestLen) {
      bestMatch = costs;
      bestLen = prefix.length;
    }
  }
  return bestMatch;
}

/**
 * Calculate the estimated cost in USD for a given model call.
 * Returns 0 for free providers (ollama, openai-compatible) and unknown models.
 */
export function calculateCost(
  model: string,
  provider: LLMProvider,
  inputTokens: number,
  outputTokens: number,
): number {
  if (FREE_PROVIDERS.has(provider)) return 0;

  const pricing = dbPricingLookup?.(model) ?? findPricing(model);
  if (!pricing) return 0;

  const [inputRate, outputRate] = pricing;
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}
