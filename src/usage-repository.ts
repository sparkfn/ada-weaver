import type {
  LLMUsageRecord,
  UsageSummary,
  UsageQuery,
  UsageGroupBy,
  UsageAggregation,
} from './usage-types.js';

export interface UsageRepository {
  add(record: LLMUsageRecord): void | Promise<void>;
  query(filter?: UsageQuery): LLMUsageRecord[] | Promise<LLMUsageRecord[]>;
  getById(id: string): LLMUsageRecord | undefined | Promise<LLMUsageRecord | undefined>;
  summarize(filter?: UsageQuery): UsageSummary | Promise<UsageSummary>;
  groupBy(key: UsageGroupBy, filter?: UsageQuery): UsageAggregation[] | Promise<UsageAggregation[]>;
  count(filter?: UsageQuery): number | Promise<number>;
  clear(): void | Promise<void>;
}

function matchesFilter(record: LLMUsageRecord, filter: UsageQuery): boolean {
  if (filter.agent && record.agent !== filter.agent) return false;
  if (filter.provider && record.provider !== filter.provider) return false;
  if (filter.model && record.model !== filter.model) return false;
  if (filter.processId && record.processId !== filter.processId) return false;
  if (filter.issueNumber !== undefined && record.issueNumber !== filter.issueNumber) return false;
  if (filter.repoId !== undefined && record.repoId !== filter.repoId) return false;
  if (filter.since && record.timestamp < filter.since) return false;
  if (filter.until && record.timestamp > filter.until) return false;
  return true;
}

function buildSummary(records: LLMUsageRecord[]): UsageSummary {
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
    totalEstimatedCost += r.estimatedCost;
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

function getGroupKey(record: LLMUsageRecord, key: UsageGroupBy): string {
  switch (key) {
    case 'agent': return record.agent;
    case 'provider': return record.provider;
    case 'model': return record.model;
    case 'processId': return record.processId ?? 'unknown';
    case 'day': return record.timestamp.slice(0, 10);       // YYYY-MM-DD
    case 'month': return record.timestamp.slice(0, 7);      // YYYY-MM
  }
}

export class InMemoryUsageRepository implements UsageRepository {
  private records: LLMUsageRecord[] = [];

  add(record: LLMUsageRecord): void {
    // Insert at front (newest-first)
    this.records.unshift(record);
  }

  query(filter?: UsageQuery): LLMUsageRecord[] {
    let results = filter
      ? this.records.filter(r => matchesFilter(r, filter))
      : [...this.records];

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit;

    if (offset > 0) {
      results = results.slice(offset);
    }
    if (limit !== undefined && limit > 0) {
      results = results.slice(0, limit);
    }

    return results;
  }

  getById(id: string): LLMUsageRecord | undefined {
    return this.records.find(r => r.id === id);
  }

  summarize(filter?: UsageQuery): UsageSummary {
    const filtered = filter
      ? this.records.filter(r => matchesFilter(r, filter))
      : this.records;
    return buildSummary(filtered);
  }

  groupBy(key: UsageGroupBy, filter?: UsageQuery): UsageAggregation[] {
    const filtered = filter
      ? this.records.filter(r => matchesFilter(r, filter))
      : this.records;

    const groups = new Map<string, LLMUsageRecord[]>();
    for (const r of filtered) {
      const groupKey = getGroupKey(r, key);
      const group = groups.get(groupKey);
      if (group) {
        group.push(r);
      } else {
        groups.set(groupKey, [r]);
      }
    }

    return Array.from(groups.entries()).map(([k, recs]) => ({
      key: k,
      summary: buildSummary(recs),
    }));
  }

  count(filter?: UsageQuery): number {
    if (!filter) return this.records.length;
    return this.records.filter(r => matchesFilter(r, filter)).length;
  }

  clear(): void {
    this.records = [];
  }
}
