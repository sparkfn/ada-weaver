export type LLMProvider = 'anthropic' | 'openai' | 'openai-compatible' | 'ollama';
export type AgentRole = 'architect' | 'issuer' | 'coder' | 'reviewer' | 'chat';

export interface LLMUsageRecord {
  id: string;                   // e.g. "usage-1707849600000-1"
  timestamp: string;            // ISO 8601
  provider: LLMProvider;
  model: string;
  agent: AgentRole;
  processId?: string;           // links to AgentProcess.id
  issueNumber?: number;
  prNumber?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  estimatedCost: number;        // USD
}

export interface UsageSummary {
  totalRecords: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  totalEstimatedCost: number;
  avgDurationMs: number;
}

export interface UsageQuery {
  agent?: AgentRole;
  provider?: LLMProvider;
  model?: string;
  processId?: string;
  issueNumber?: number;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export type UsageGroupBy = 'agent' | 'provider' | 'model' | 'processId' | 'day' | 'month';

export interface UsageAggregation {
  key: string;
  summary: UsageSummary;
}
