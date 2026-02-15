import type pg from 'pg';
import type {
  LLMUsageRecord,
  UsageSummary,
  UsageQuery,
  UsageGroupBy,
  UsageAggregation,
} from '../usage-types.js';
import type { UsageRepository } from '../usage-repository.js';

export class PostgresUsageRepository implements UsageRepository {
  constructor(private pool: pg.Pool, private defaultRepoId: number = 0) {}

  async add(record: LLMUsageRecord & { repoId?: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_usage (id, repo_id, timestamp, provider, model, agent, process_id,
         issue_number, pr_number, input_tokens, output_tokens, total_tokens, duration_ms, estimated_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id,
        record.repoId ?? this.defaultRepoId,
        record.timestamp,
        record.provider,
        record.model,
        record.agent,
        record.processId ?? null,
        record.issueNumber ?? null,
        record.prNumber ?? null,
        record.inputTokens,
        record.outputTokens,
        record.totalTokens,
        Math.round(record.durationMs),
        record.estimatedCost,
      ],
    );
  }

  async query(filter?: UsageQuery): Promise<LLMUsageRecord[]> {
    const { where, params } = this.buildWhereClause(filter);
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit;

    let sql = `SELECT id, repo_id, timestamp, provider, model, agent, process_id,
                 issue_number, pr_number, input_tokens, output_tokens, total_tokens,
                 duration_ms, estimated_cost
               FROM llm_usage ${where} ORDER BY timestamp DESC`;

    if (limit) {
      sql += ` LIMIT ${limit}`;
    }
    if (offset > 0) {
      sql += ` OFFSET ${offset}`;
    }

    const { rows } = await this.pool.query<any>(sql, params);
    return rows.map(r => this.toRecord(r));
  }

  async getById(id: string): Promise<LLMUsageRecord | undefined> {
    const { rows } = await this.pool.query<any>(
      `SELECT id, repo_id, timestamp, provider, model, agent, process_id,
         issue_number, pr_number, input_tokens, output_tokens, total_tokens,
         duration_ms, estimated_cost
       FROM llm_usage WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async summarize(filter?: UsageQuery): Promise<UsageSummary> {
    const { where, params } = this.buildWhereClause(filter);
    const { rows } = await this.pool.query<any>(
      `SELECT
         COUNT(*)::int AS total_records,
         COALESCE(SUM(input_tokens), 0)::int AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(duration_ms), 0)::int AS total_duration_ms,
         COALESCE(SUM(estimated_cost), 0)::float AS total_estimated_cost
       FROM llm_usage ${where}`,
      params,
    );

    const r = rows[0];
    return {
      totalRecords: r.total_records,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalTokens: r.total_tokens,
      totalDurationMs: r.total_duration_ms,
      totalEstimatedCost: r.total_estimated_cost,
      avgDurationMs: r.total_records > 0 ? r.total_duration_ms / r.total_records : 0,
    };
  }

  async groupBy(key: UsageGroupBy, filter?: UsageQuery): Promise<UsageAggregation[]> {
    const { where, params } = this.buildWhereClause(filter);
    const groupCol = this.getGroupColumn(key);

    const { rows } = await this.pool.query<any>(
      `SELECT
         ${groupCol} AS group_key,
         COUNT(*)::int AS total_records,
         COALESCE(SUM(input_tokens), 0)::int AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(duration_ms), 0)::int AS total_duration_ms,
         COALESCE(SUM(estimated_cost), 0)::float AS total_estimated_cost
       FROM llm_usage ${where}
       GROUP BY ${groupCol}
       ORDER BY ${groupCol}`,
      params,
    );

    return rows.map((r: any) => ({
      key: r.group_key ?? 'unknown',
      summary: {
        totalRecords: r.total_records,
        totalInputTokens: r.total_input_tokens,
        totalOutputTokens: r.total_output_tokens,
        totalTokens: r.total_tokens,
        totalDurationMs: r.total_duration_ms,
        totalEstimatedCost: r.total_estimated_cost,
        avgDurationMs: r.total_records > 0 ? r.total_duration_ms / r.total_records : 0,
      },
    }));
  }

  async count(filter?: UsageQuery): Promise<number> {
    const { where, params } = this.buildWhereClause(filter);
    const { rows } = await this.pool.query<any>(
      `SELECT COUNT(*)::int AS cnt FROM llm_usage ${where}`,
      params,
    );
    return rows[0].cnt;
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM llm_usage');
  }

  private buildWhereClause(filter?: UsageQuery): { where: string; params: any[] } {
    if (!filter) return { where: '', params: [] };

    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filter.agent) {
      conditions.push(`agent = $${idx++}`);
      params.push(filter.agent);
    }
    if (filter.provider) {
      conditions.push(`provider = $${idx++}`);
      params.push(filter.provider);
    }
    if (filter.model) {
      conditions.push(`model = $${idx++}`);
      params.push(filter.model);
    }
    if (filter.processId) {
      conditions.push(`process_id = $${idx++}`);
      params.push(filter.processId);
    }
    if (filter.issueNumber !== undefined) {
      conditions.push(`issue_number = $${idx++}`);
      params.push(filter.issueNumber);
    }
    if (filter.since) {
      conditions.push(`timestamp >= $${idx++}`);
      params.push(filter.since);
    }
    if (filter.until) {
      conditions.push(`timestamp <= $${idx++}`);
      params.push(filter.until);
    }
    if ((filter as any).repoId !== undefined) {
      conditions.push(`repo_id = $${idx++}`);
      params.push((filter as any).repoId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
  }

  private getGroupColumn(key: UsageGroupBy): string {
    switch (key) {
      case 'agent': return 'agent';
      case 'provider': return 'provider';
      case 'model': return 'model';
      case 'processId': return 'process_id';
      case 'day': return "to_char(timestamp, 'YYYY-MM-DD')";
      case 'month': return "to_char(timestamp, 'YYYY-MM')";
    }
  }

  private toRecord(row: any): LLMUsageRecord {
    return {
      id: row.id,
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
      provider: row.provider,
      model: row.model,
      agent: row.agent,
      processId: row.process_id ?? undefined,
      issueNumber: row.issue_number ?? undefined,
      prNumber: row.pr_number ?? undefined,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      durationMs: row.duration_ms,
      estimatedCost: parseFloat(row.estimated_cost),
    };
  }
}
