import { describe, it, expect } from 'vitest';
import { InMemoryPricingRepository } from '../src/pricing-repository.js';

describe('InMemoryPricingRepository', () => {
  it('list returns empty initially', () => {
    const repo = new InMemoryPricingRepository();
    expect(repo.list()).toEqual([]);
  });

  it('create + list returns record', () => {
    const repo = new InMemoryPricingRepository();
    const record = repo.create('gpt-5.2', 1.75, 14);
    expect(record.modelPrefix).toBe('gpt-5.2');
    expect(record.inputCostPerMillion).toBe(1.75);
    expect(record.outputCostPerMillion).toBe(14);
    expect(record.id).toBeDefined();
    expect(record.updatedAt).toBeDefined();
    const all = repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].modelPrefix).toBe('gpt-5.2');
  });

  it('create duplicate prefix throws with code 23505', () => {
    const repo = new InMemoryPricingRepository();
    repo.create('gpt-5.2', 1.75, 14);
    try {
      repo.create('GPT-5.2', 2, 20); // case-insensitive duplicate
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('23505');
    }
  });

  it('getById returns record', () => {
    const repo = new InMemoryPricingRepository();
    const created = repo.create('gpt-5.2', 1.75, 14);
    const found = repo.getById(created.id);
    expect(found).toBeDefined();
    expect(found!.modelPrefix).toBe('gpt-5.2');
  });

  it('getById returns undefined for missing', () => {
    const repo = new InMemoryPricingRepository();
    expect(repo.getById(999)).toBeUndefined();
  });

  it('getByModelPrefix returns record (case-insensitive)', () => {
    const repo = new InMemoryPricingRepository();
    repo.create('gpt-5.2', 1.75, 14);
    const found = repo.getByModelPrefix('GPT-5.2');
    expect(found).toBeDefined();
    expect(found!.modelPrefix).toBe('gpt-5.2');
  });

  it('update changes fields', () => {
    const repo = new InMemoryPricingRepository();
    const created = repo.create('gpt-5.2', 1.75, 14);
    const updated = repo.update(created.id, { inputCostPerMillion: 2.0, outputCostPerMillion: 16 });
    expect(updated).toBeDefined();
    expect(updated!.inputCostPerMillion).toBe(2.0);
    expect(updated!.outputCostPerMillion).toBe(16);
  });

  it('update returns undefined for missing', () => {
    const repo = new InMemoryPricingRepository();
    expect(repo.update(999, { inputCostPerMillion: 1 })).toBeUndefined();
  });

  it('delete removes record', () => {
    const repo = new InMemoryPricingRepository();
    const created = repo.create('gpt-5.2', 1.75, 14);
    expect(repo.delete(created.id)).toBe(true);
    expect(repo.list()).toEqual([]);
    expect(repo.delete(created.id)).toBe(false);
  });
});
