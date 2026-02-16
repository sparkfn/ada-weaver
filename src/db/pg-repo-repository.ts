import type pg from 'pg';
import type { RepoRecord, RepoRepository } from '../repo-repository.js';

export class PostgresRepoRepository implements RepoRepository {
  constructor(private pool: pg.Pool) {}

  async getById(id: number): Promise<RepoRecord | undefined> {
    const { rows } = await this.pool.query<any>(
      'SELECT id, owner, repo, is_active, added_at, config_json FROM repos WHERE id = $1',
      [id],
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async getByOwnerRepo(owner: string, repo: string): Promise<RepoRecord | undefined> {
    const { rows } = await this.pool.query<any>(
      'SELECT id, owner, repo, is_active, added_at, config_json FROM repos WHERE owner = $1 AND repo = $2',
      [owner, repo],
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async ensureRepo(owner: string, repo: string): Promise<RepoRecord> {
    const { rows } = await this.pool.query<any>(
      `INSERT INTO repos (owner, repo)
       VALUES ($1, $2)
       ON CONFLICT (owner, repo) DO UPDATE SET owner = EXCLUDED.owner
       RETURNING id, owner, repo, is_active, added_at, config_json`,
      [owner, repo],
    );
    return this.toRecord(rows[0]);
  }

  async list(activeOnly = true): Promise<RepoRecord[]> {
    const sql = activeOnly
      ? 'SELECT id, owner, repo, is_active, added_at, config_json FROM repos WHERE is_active = TRUE ORDER BY id'
      : 'SELECT id, owner, repo, is_active, added_at, config_json FROM repos ORDER BY id';
    const { rows } = await this.pool.query<any>(sql);
    return rows.map(r => this.toRecord(r));
  }

  async create(owner: string, repo: string, configJson?: Record<string, unknown>): Promise<RepoRecord> {
    const { rows } = await this.pool.query<any>(
      `INSERT INTO repos (owner, repo, config_json)
       VALUES ($1, $2, $3)
       RETURNING id, owner, repo, is_active, added_at, config_json`,
      [owner, repo, configJson ? JSON.stringify(configJson) : null],
    );
    return this.toRecord(rows[0]);
  }

  async update(id: number, fields: { configJson?: Record<string, unknown> }): Promise<RepoRecord | undefined> {
    const { rows } = await this.pool.query<any>(
      `UPDATE repos SET config_json = COALESCE($2, config_json)
       WHERE id = $1
       RETURNING id, owner, repo, is_active, added_at, config_json`,
      [id, fields.configJson ? JSON.stringify(fields.configJson) : null],
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async deactivate(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE repos SET is_active = FALSE WHERE id = $1 AND is_active = TRUE',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  private toRecord(row: any): RepoRecord {
    return {
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      isActive: row.is_active,
      addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : row.added_at,
      configJson: row.config_json ?? undefined,
    };
  }
}
