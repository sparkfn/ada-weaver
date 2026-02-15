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
    return this.repository.query(filter);
  }

  async getById(id: string): Promise<LLMUsageRecord | undefined> {
    return this.repository.getById(id);
  }

  async summarize(filter?: UsageQuery): Promise<UsageSummary> {
    return this.repository.summarize(filter);
  }

  async groupBy(key: UsageGroupBy, filter?: UsageQuery): Promise<UsageAggregation[]> {
    return this.repository.groupBy(key, filter);
  }

  async count(filter?: UsageQuery): Promise<number> {
    return this.repository.count(filter);
  }

  clear(): void {
    this.repository.clear();
  }
}
