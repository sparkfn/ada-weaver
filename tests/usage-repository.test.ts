import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryUsageRepository } from '../src/usage-repository.js';
import type { LLMUsageRecord } from '../src/usage-types.js';

function makeRecord(overrides: Partial<LLMUsageRecord> = {}): LLMUsageRecord {
  return {
    id: `usage-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    agent: 'architect',
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    durationMs: 2000,
    estimatedCost: 0.0105,
    ...overrides,
  };
}

describe('InMemoryUsageRepository', () => {
  let repo: InMemoryUsageRepository;

  beforeEach(() => {
    repo = new InMemoryUsageRepository();
  });

  describe('add + query', () => {
    it('stores and retrieves records', () => {
      const r = makeRecord({ id: 'test-1' });
      repo.add(r);
      const results = repo.query();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('test-1');
    });

    it('returns newest first', () => {
      repo.add(makeRecord({ id: 'first' }));
      repo.add(makeRecord({ id: 'second' }));
      const results = repo.query();
      expect(results[0].id).toBe('second');
      expect(results[1].id).toBe('first');
    });
  });

  describe('getById', () => {
    it('finds a record by id', () => {
      repo.add(makeRecord({ id: 'find-me' }));
      expect(repo.getById('find-me')).toBeDefined();
      expect(repo.getById('find-me')!.id).toBe('find-me');
    });

    it('returns undefined for unknown id', () => {
      expect(repo.getById('nope')).toBeUndefined();
    });
  });

  describe('filtering', () => {
    it('filters by agent', () => {
      repo.add(makeRecord({ agent: 'architect' }));
      repo.add(makeRecord({ agent: 'coder' }));
      repo.add(makeRecord({ agent: 'reviewer' }));
      expect(repo.query({ agent: 'coder' })).toHaveLength(1);
    });

    it('filters by provider', () => {
      repo.add(makeRecord({ provider: 'anthropic' }));
      repo.add(makeRecord({ provider: 'openai' }));
      expect(repo.query({ provider: 'openai' })).toHaveLength(1);
    });

    it('filters by model', () => {
      repo.add(makeRecord({ model: 'claude-sonnet-4-20250514' }));
      repo.add(makeRecord({ model: 'gpt-4o' }));
      expect(repo.query({ model: 'gpt-4o' })).toHaveLength(1);
    });

    it('filters by processId', () => {
      repo.add(makeRecord({ processId: 'proc-1' }));
      repo.add(makeRecord({ processId: 'proc-2' }));
      expect(repo.query({ processId: 'proc-1' })).toHaveLength(1);
    });

    it('filters by issueNumber', () => {
      repo.add(makeRecord({ issueNumber: 42 }));
      repo.add(makeRecord({ issueNumber: 99 }));
      expect(repo.query({ issueNumber: 42 })).toHaveLength(1);
    });

    it('filters by date range (since)', () => {
      repo.add(makeRecord({ timestamp: '2024-01-01T00:00:00Z' }));
      repo.add(makeRecord({ timestamp: '2024-06-01T00:00:00Z' }));
      expect(repo.query({ since: '2024-03-01T00:00:00Z' })).toHaveLength(1);
    });

    it('filters by date range (until)', () => {
      repo.add(makeRecord({ timestamp: '2024-01-01T00:00:00Z' }));
      repo.add(makeRecord({ timestamp: '2024-06-01T00:00:00Z' }));
      expect(repo.query({ until: '2024-03-01T00:00:00Z' })).toHaveLength(1);
    });

    it('supports pagination with limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        repo.add(makeRecord({ id: `r-${i}` }));
      }
      const page = repo.query({ limit: 3, offset: 2 });
      expect(page).toHaveLength(3);
    });
  });

  describe('summarize', () => {
    it('returns zero summary for empty repo', () => {
      const s = repo.summarize();
      expect(s.totalRecords).toBe(0);
      expect(s.totalTokens).toBe(0);
      expect(s.avgDurationMs).toBe(0);
    });

    it('aggregates totals correctly', () => {
      repo.add(makeRecord({ inputTokens: 100, outputTokens: 50, totalTokens: 150, durationMs: 1000, estimatedCost: 0.01 }));
      repo.add(makeRecord({ inputTokens: 200, outputTokens: 100, totalTokens: 300, durationMs: 2000, estimatedCost: 0.02 }));
      const s = repo.summarize();
      expect(s.totalRecords).toBe(2);
      expect(s.totalInputTokens).toBe(300);
      expect(s.totalOutputTokens).toBe(150);
      expect(s.totalTokens).toBe(450);
      expect(s.totalDurationMs).toBe(3000);
      expect(s.totalEstimatedCost).toBeCloseTo(0.03);
      expect(s.avgDurationMs).toBe(1500);
    });

    it('respects filters', () => {
      repo.add(makeRecord({ agent: 'architect', inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
      repo.add(makeRecord({ agent: 'coder', inputTokens: 200, outputTokens: 100, totalTokens: 300 }));
      const s = repo.summarize({ agent: 'coder' });
      expect(s.totalRecords).toBe(1);
      expect(s.totalInputTokens).toBe(200);
    });
  });

  describe('groupBy', () => {
    beforeEach(() => {
      repo.add(makeRecord({ agent: 'architect', provider: 'anthropic', model: 'claude-sonnet-4-20250514', timestamp: '2024-01-15T10:00:00Z' }));
      repo.add(makeRecord({ agent: 'architect', provider: 'anthropic', model: 'claude-sonnet-4-20250514', timestamp: '2024-01-20T10:00:00Z' }));
      repo.add(makeRecord({ agent: 'coder', provider: 'openai', model: 'gpt-4o', timestamp: '2024-02-01T10:00:00Z' }));
    });

    it('groups by agent', () => {
      const groups = repo.groupBy('agent');
      expect(groups).toHaveLength(2);
      const architectGroup = groups.find(g => g.key === 'architect');
      expect(architectGroup!.summary.totalRecords).toBe(2);
    });

    it('groups by provider', () => {
      const groups = repo.groupBy('provider');
      expect(groups).toHaveLength(2);
    });

    it('groups by model', () => {
      const groups = repo.groupBy('model');
      expect(groups).toHaveLength(2);
    });

    it('groups by day', () => {
      const groups = repo.groupBy('day');
      expect(groups).toHaveLength(3); // 3 different days
    });

    it('groups by month', () => {
      const groups = repo.groupBy('month');
      expect(groups).toHaveLength(2); // 2024-01 and 2024-02
    });

    it('respects filters when grouping', () => {
      const groups = repo.groupBy('agent', { provider: 'anthropic' });
      expect(groups).toHaveLength(1);
      expect(groups[0].key).toBe('architect');
    });
  });

  describe('count', () => {
    it('returns 0 for empty repo', () => {
      expect(repo.count()).toBe(0);
    });

    it('counts all records', () => {
      repo.add(makeRecord());
      repo.add(makeRecord());
      expect(repo.count()).toBe(2);
    });

    it('counts filtered records', () => {
      repo.add(makeRecord({ agent: 'architect' }));
      repo.add(makeRecord({ agent: 'coder' }));
      expect(repo.count({ agent: 'architect' })).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all records', () => {
      repo.add(makeRecord());
      repo.add(makeRecord());
      repo.clear();
      expect(repo.count()).toBe(0);
      expect(repo.query()).toEqual([]);
    });
  });
});
