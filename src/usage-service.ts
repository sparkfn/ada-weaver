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

    this.repository.add(record);
    this.emit('usage_recorded', record);
    return record;
  }

  query(filter?: UsageQuery): LLMUsageRecord[] {
    return this.repository.query(filter);
  }

  getById(id: string): LLMUsageRecord | undefined {
    return this.repository.getById(id);
  }

  summarize(filter?: UsageQuery): UsageSummary {
    return this.repository.summarize(filter);
  }

  groupBy(key: UsageGroupBy, filter?: UsageQuery): UsageAggregation[] {
    return this.repository.groupBy(key, filter);
  }

  count(filter?: UsageQuery): number {
    return this.repository.count(filter);
  }

  clear(): void {
    this.repository.clear();
  }
}
