import { EventEmitter } from 'events';
import type {
  LLMProvider,
  AgentRole,
  LLMUsageRecord,
  UsageSummary,
  UsageQuery,
  UsageGroupBy,
  UsageAggregation,
} from './usage-types.js';
import type { UsageRepository } from './usage-repository.js';
import { InMemoryUsageRepository } from './usage-repository.js';
import { calculateCost } from './usage-pricing.js';

export interface RecordUsageInput {
  provider: LLMProvider;
  model: string;
  agent: AgentRole;
  processId?: string;
  issueNumber?: number;
  prNumber?: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

let counter = 0;

function generateId(): string {
  return `usage-${Date.now()}-${++counter}`;
}

export class UsageService extends EventEmitter {
  private repository: UsageRepository;

  constructor(repository?: UsageRepository) {
    super();
    this.repository = repository ?? new InMemoryUsageRepository();
  }

  /**
   * Recalculate estimatedCost using current pricing table.
   * If live cost > 0, use it; otherwise keep stored value (avoids zeroing out
   * records whose model was removed from the pricing table).
   */
  private recalcCost(r: LLMUsageRecord): LLMUsageRecord {
    const liveCost = calculateCost(r.model, r.provider, r.inputTokens, r.outputTokens);
    if (liveCost > 0 && liveCost !== r.estimatedCost) {
      return { ...r, estimatedCost: liveCost };
    }
    return r;
  }

  record(input: RecordUsageInput): LLMUsageRecord {
    const record: LLMUsageRecord = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      provider: input.provider,
      model: input.model,
      agent: input.agent,
      processId: input.processId,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.inputTokens + input.outputTokens,
      durationMs: input.durationMs,
      estimatedCost: calculateCost(input.model, input.provider, input.inputTokens, input.outputTokens),
    };

    // Fire-and-forget: works for both sync (in-memory) and async (PG) repos
    Promise.resolve(this.repository.add(record)).catch(err =>
      console.error('[usage-service] Failed to persist usage record:', err),
    );
    this.emit('usage_recorded', record);
    return record;
  }

  async query(filter?: UsageQuery): Promise<LLMUsageRecord[]> {
    const records = await this.repository.query(filter);
    return records.map(r => this.recalcCost(r));
  }

  async getById(id: string): Promise<LLMUsageRecord | undefined> {
    const record = await this.repository.getById(id);
    return record ? this.recalcCost(record) : undefined;
  }

  async summarize(filter?: UsageQuery): Promise<UsageSummary> {
    // Fetch records and build summary with live cost recalculation,
    // so pricing changes (hardcoded or DB overrides) apply retroactively.
    const allFilter = filter ? { ...filter, limit: undefined, offset: undefined } : undefined;
    const records = await this.repository.query(allFilter);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalDurationMs = 0;
    let totalEstimatedCost = 0;

    for (const r of records) {
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;
      totalTokens += r.totalTokens;
      totalDurationMs += r.durationMs;
      const updated = this.recalcCost(r);
      totalEstimatedCost += updated.estimatedCost;
    }

    return {
      totalRecords: records.length,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalDurationMs,
      totalEstimatedCost,
      avgDurationMs: records.length > 0 ? totalDurationMs / records.length : 0,
    };
  }

  async groupBy(key: UsageGroupBy, filter?: UsageQuery): Promise<UsageAggregation[]> {
    // Fetch records and group with live cost recalculation
    const allFilter = filter ? { ...filter, limit: undefined, offset: undefined } : undefined;
    const records = await this.repository.query(allFilter);

    const keyFn = (r: LLMUsageRecord): string => {
      switch (key) {
        case 'agent': return r.agent;
        case 'provider': return r.provider;
        case 'model': return r.model;
        case 'processId': return r.processId ?? 'unknown';
        case 'day': return r.timestamp.slice(0, 10);
        case 'month': return r.timestamp.slice(0, 7);
      }
    };

    const groups = new Map<string, LLMUsageRecord[]>();
    for (const r of records) {
      const gk = keyFn(r);
      const group = groups.get(gk);
      if (group) group.push(r);
      else groups.set(gk, [r]);
    }

    return Array.from(groups.entries()).map(([k, recs]) => {
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalTokens = 0;
      let totalDurationMs = 0;
      let totalEstimatedCost = 0;
      for (const r of recs) {
        totalInputTokens += r.inputTokens;
        totalOutputTokens += r.outputTokens;
        totalTokens += r.totalTokens;
        totalDurationMs += r.durationMs;
        totalEstimatedCost += this.recalcCost(r).estimatedCost;
      }
      return {
        key: k,
        summary: {
          totalRecords: recs.length,
          totalInputTokens,
          totalOutputTokens,
          totalTokens,
          totalDurationMs,
          totalEstimatedCost,
          avgDurationMs: recs.length > 0 ? totalDurationMs / recs.length : 0,
        },
      };
    });
  }

  async count(filter?: UsageQuery): Promise<number> {
    return this.repository.count(filter);
  }

  clear(): void {
    this.repository.clear();
  }
}
