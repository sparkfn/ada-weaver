import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageService } from '../src/usage-service.js';
import { InMemoryUsageRepository } from '../src/usage-repository.js';
import type { RecordUsageInput } from '../src/usage-service.js';

function makeInput(overrides: Partial<RecordUsageInput> = {}): RecordUsageInput {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    agent: 'architect',
    inputTokens: 1000,
    outputTokens: 500,
    durationMs: 2000,
    ...overrides,
  };
}

describe('UsageService', () => {
  let service: UsageService;
  let repo: InMemoryUsageRepository;

  beforeEach(() => {
    repo = new InMemoryUsageRepository();
    service = new UsageService(repo);
  });

  describe('record', () => {
    it('creates a record with auto-generated id', () => {
      const record = service.record(makeInput());
      expect(record.id).toMatch(/^usage-\d+-\d+$/);
    });

    it('creates a record with ISO timestamp', () => {
      const record = service.record(makeInput());
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('calculates totalTokens', () => {
      const record = service.record(makeInput({ inputTokens: 100, outputTokens: 50 }));
      expect(record.totalTokens).toBe(150);
    });

    it('calculates estimatedCost for known models', () => {
      const record = service.record(makeInput({
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }));
      // $3/1M input + $15/1M output = $18
      expect(record.estimatedCost).toBeCloseTo(18, 1);
    });

    it('sets estimatedCost to 0 for free providers', () => {
      const record = service.record(makeInput({
        provider: 'ollama',
        model: 'llama3.2',
      }));
      expect(record.estimatedCost).toBe(0);
    });

    it('stores the record in the repository', () => {
      service.record(makeInput());
      expect(repo.count()).toBe(1);
    });

    it('preserves optional fields', () => {
      const record = service.record(makeInput({
        processId: 'proc-42',
        issueNumber: 10,
        prNumber: 11,
      }));
      expect(record.processId).toBe('proc-42');
      expect(record.issueNumber).toBe(10);
      expect(record.prNumber).toBe(11);
    });
  });

  describe('event emission', () => {
    it('emits usage_recorded event on record()', () => {
      const handler = vi.fn();
      service.on('usage_recorded', handler);
      const record = service.record(makeInput());
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(record);
    });
  });

  describe('delegation to repository', () => {
    it('delegates query()', () => {
      service.record(makeInput({ agent: 'architect' }));
      service.record(makeInput({ agent: 'coder' }));
      const results = service.query({ agent: 'architect' });
      expect(results).toHaveLength(1);
    });

    it('delegates getById()', () => {
      const record = service.record(makeInput());
      expect(service.getById(record.id)).toBeDefined();
      expect(service.getById('nonexistent')).toBeUndefined();
    });

    it('delegates summarize()', () => {
      service.record(makeInput({ inputTokens: 100, outputTokens: 50 }));
      service.record(makeInput({ inputTokens: 200, outputTokens: 100 }));
      const summary = service.summarize();
      expect(summary.totalRecords).toBe(2);
      expect(summary.totalInputTokens).toBe(300);
    });

    it('delegates groupBy()', () => {
      service.record(makeInput({ agent: 'architect' }));
      service.record(makeInput({ agent: 'coder' }));
      const groups = service.groupBy('agent');
      expect(groups).toHaveLength(2);
    });

    it('delegates count()', () => {
      service.record(makeInput());
      service.record(makeInput());
      expect(service.count()).toBe(2);
    });

    it('delegates clear()', () => {
      service.record(makeInput());
      service.clear();
      expect(service.count()).toBe(0);
    });
  });

  describe('default repository', () => {
    it('uses InMemoryUsageRepository when none provided', () => {
      const defaultService = new UsageService();
      defaultService.record(makeInput());
      expect(defaultService.count()).toBe(1);
    });
  });
});
