import { describe, it, expect, afterEach } from 'vitest';
import { calculateCost, setPricingLookup } from '../src/usage-pricing.js';

describe('calculateCost', () => {
  afterEach(() => {
    setPricingLookup(undefined);
  });

  it('calculates cost for Claude Sonnet 4', () => {
    // $3/1M input, $15/1M output
    const cost = calculateCost('claude-sonnet-4-20250514', 'anthropic', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 8);
  });

  it('calculates cost for Claude Opus 4', () => {
    // $15/1M input, $75/1M output
    const cost = calculateCost('claude-opus-4-20250514', 'anthropic', 2000, 1000);
    expect(cost).toBeCloseTo((2000 * 15 + 1000 * 75) / 1_000_000, 8);
  });

  it('calculates cost for Claude Haiku 3.5', () => {
    // $0.80/1M input, $4/1M output
    const cost = calculateCost('claude-haiku-3.5-20250101', 'anthropic', 5000, 2000);
    expect(cost).toBeCloseTo((5000 * 0.80 + 2000 * 4) / 1_000_000, 8);
  });

  it('calculates cost for GPT-4o', () => {
    // $2.50/1M input, $10/1M output
    const cost = calculateCost('gpt-4o-2024-05-13', 'openai', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 2.50 + 500 * 10) / 1_000_000, 8);
  });

  it('calculates cost for GPT-4o-mini', () => {
    // $0.15/1M input, $0.60/1M output
    const cost = calculateCost('gpt-4o-mini-2024-07-18', 'openai', 10000, 5000);
    expect(cost).toBeCloseTo((10000 * 0.15 + 5000 * 0.60) / 1_000_000, 8);
  });

  it('uses longest prefix match (gpt-4o-mini vs gpt-4o)', () => {
    // gpt-4o-mini should match gpt-4o-mini pricing, not gpt-4o
    const costMini = calculateCost('gpt-4o-mini-2024-07-18', 'openai', 1_000_000, 1_000_000);
    const costFull = calculateCost('gpt-4o-2024-05-13', 'openai', 1_000_000, 1_000_000);
    expect(costMini).toBeLessThan(costFull);
  });

  it('calculates cost for openai-responses provider (same as openai)', () => {
    const cost = calculateCost('gpt-4o-2024-05-13', 'openai-responses', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 2.50 + 500 * 10) / 1_000_000, 8);
  });

  it('returns 0 for ollama provider', () => {
    const cost = calculateCost('llama3.2', 'ollama', 10000, 5000);
    expect(cost).toBe(0);
  });

  it('returns 0 for openai-compatible provider', () => {
    const cost = calculateCost('gpt-4o', 'openai-compatible', 10000, 5000);
    expect(cost).toBe(0);
  });

  it('returns 0 for unknown model', () => {
    const cost = calculateCost('some-unknown-model-v2', 'anthropic', 10000, 5000);
    expect(cost).toBe(0);
  });

  it('returns 0 for zero tokens', () => {
    const cost = calculateCost('claude-sonnet-4-20250514', 'anthropic', 0, 0);
    expect(cost).toBe(0);
  });

  it('calculates cost for o1', () => {
    // $15/1M input, $60/1M output
    const cost = calculateCost('o1-2024-12-17', 'openai', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 15 + 500 * 60) / 1_000_000, 8);
  });

  it('calculates cost for o1-mini', () => {
    // $3/1M input, $12/1M output
    const cost = calculateCost('o1-mini-2024-09-12', 'openai', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 3 + 500 * 12) / 1_000_000, 8);
  });

  it('calculates cost for GPT-5.2', () => {
    // $1.75/1M input, $14/1M output
    const cost = calculateCost('gpt-5.2-2026-01-15', 'openai', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 1.75 + 500 * 14) / 1_000_000, 8);
  });

  it('uses DB override when set via setPricingLookup', () => {
    // Override claude-sonnet-4 with custom pricing
    setPricingLookup((model) => {
      if (model.toLowerCase().startsWith('claude-sonnet-4')) return [100, 200];
      return undefined;
    });
    const cost = calculateCost('claude-sonnet-4-20250514', 'anthropic', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 100 + 500 * 200) / 1_000_000, 8);
  });

  it('falls back to hardcoded when DB has no match', () => {
    // DB lookup returns undefined, should fall back to hardcoded table
    setPricingLookup(() => undefined);
    const cost = calculateCost('claude-sonnet-4-20250514', 'anthropic', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 8);
  });

  it('setPricingLookup(undefined) clears override', () => {
    setPricingLookup((model) => {
      if (model.toLowerCase().startsWith('claude-sonnet-4')) return [100, 200];
      return undefined;
    });
    // Override active
    let cost = calculateCost('claude-sonnet-4-20250514', 'anthropic', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 100 + 500 * 200) / 1_000_000, 8);
    // Clear override
    setPricingLookup(undefined);
    cost = calculateCost('claude-sonnet-4-20250514', 'anthropic', 1000, 500);
    expect(cost).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 8);
  });
});
