import type pg from 'pg';
import type { AgentProcess } from '../process-manager.js';
import type { ProcessRepository } from '../process-repository.js';

export class PostgresProcessRepository implements ProcessRepository {
  constructor(private pool: pg.Pool, private defaultRepoId: number = 0) {}

  async save(process: AgentProcess): Promise<void> {
    const repoId = (process as any).repoId ?? this.defaultRepoId;
    await this.pool.query(
      `INSERT INTO agent_processes (id, repo_id, type, status, issue_number, pr_number, pr_numbers,
         started_at, completed_at, current_phase, active_phases, iteration, max_iterations,
         outcome, error, logs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO NOTHING`,
      [
        process.id,
        repoId,
        process.type,
        process.status,
        process.issueNumber ?? null,
        process.prNumber ?? null,
        process.prNumbers ?? null,
        process.startedAt,
        process.completedAt ?? null,
        process.currentPhase ?? null,
        process.activePhases ?? null,
        process.iteration ?? null,
        process.maxIterations ?? null,
        process.outcome ?? null,
        process.error ?? null,
        JSON.stringify(process.logs),
      ],
    );
  }

  async update(process: AgentProcess): Promise<void> {
    await this.pool.query(
      `UPDATE agent_processes SET
         status = $2,
         issue_number = $3,
         pr_number = $4,
         pr_numbers = $5,
         completed_at = $6,
         current_phase = $7,
         active_phases = $8,
         iteration = $9,
         max_iterations = $10,
         outcome = $11,
         error = $12,
         logs = $13
       WHERE id = $1`,
      [
        process.id,
        process.status,
        process.issueNumber ?? null,
        process.prNumber ?? null,
        process.prNumbers ?? null,
        process.completedAt ?? null,
        process.currentPhase ?? null,
        process.activePhases ?? null,
        process.iteration ?? null,
        process.maxIterations ?? null,
        process.outcome ?? null,
        process.error ?? null,
        JSON.stringify(process.logs),
      ],
    );
  }

  async getById(id: string): Promise<AgentProcess | undefined> {
    const { rows } = await this.pool.query<any>(
      `SELECT id, repo_id, type, status, issue_number, pr_number, pr_numbers,
         started_at, completed_at, current_phase, active_phases, iteration, max_iterations,
         outcome, error, logs
       FROM agent_processes WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.toProcess(rows[0]) : undefined;
  }

  async list(filter?: { status?: string; repoId?: number }): Promise<AgentProcess[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filter?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filter.status);
    }
    if (filter?.repoId !== undefined) {
      conditions.push(`repo_id = $${idx++}`);
      params.push(filter.repoId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await this.pool.query<any>(
      `SELECT id, repo_id, type, status, issue_number, pr_number, pr_numbers,
         started_at, completed_at, current_phase, active_phases, iteration, max_iterations,
         outcome, error, logs
       FROM agent_processes ${where} ORDER BY started_at DESC`,
      params,
    );
    return rows.map(r => this.toProcess(r));
  }

  private toProcess(row: any): AgentProcess {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      issueNumber: row.issue_number ?? undefined,
      prNumber: row.pr_number ?? undefined,
      prNumbers: row.pr_numbers ?? undefined,
      owner: '', // Not stored in DB — filled by ProcessManager from config
      repo: '',
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
      completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : (row.completed_at ?? undefined),
      currentPhase: row.current_phase ?? undefined,
      activePhases: row.active_phases ?? undefined,
      iteration: row.iteration ?? undefined,
      maxIterations: row.max_iterations ?? undefined,
      outcome: row.outcome ?? undefined,
      error: row.error ?? undefined,
      logs: row.logs ?? [],
    };
  }
}
