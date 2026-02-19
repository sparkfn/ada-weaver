import type pg from 'pg';
import type { SettingsRepository } from '../settings-repository.js';

export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private pool: pg.Pool) {}

  async get<T = any>(key: string): Promise<T | undefined> {
    const { rows } = await this.pool.query<{ value: T }>(
      'SELECT value FROM settings WHERE key = $1',
      [key],
    );
    return rows[0]?.value;
  }

  async set<T = any>(key: string, value: T): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  }

  async getAll(): Promise<Record<string, any>> {
    const { rows } = await this.pool.query<{ key: string; value: any }>(
      'SELECT key, value FROM settings ORDER BY key',
    );
    const result: Record<string, any> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async delete(key: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM settings WHERE key = $1',
      [key],
    );
    return (rowCount ?? 0) > 0;
  }
}
