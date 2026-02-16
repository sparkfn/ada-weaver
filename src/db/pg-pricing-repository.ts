import type pg from 'pg';
import type { PricingRecord, PricingRepository } from '../pricing-repository.js';

export class PostgresPricingRepository implements PricingRepository {
  constructor(private pool: pg.Pool) {}

  async list(): Promise<PricingRecord[]> {
    const { rows } = await this.pool.query<any>(
      'SELECT id, model_prefix, input_cost_per_million, output_cost_per_million, updated_at FROM model_pricing ORDER BY id',
    );
    return rows.map(r => this.toRecord(r));
  }

  async getById(id: number): Promise<PricingRecord | undefined> {
    const { rows } = await this.pool.query<any>(
      'SELECT id, model_prefix, input_cost_per_million, output_cost_per_million, updated_at FROM model_pricing WHERE id = $1',
      [id],
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async getByModelPrefix(prefix: string): Promise<PricingRecord | undefined> {
    const { rows } = await this.pool.query<any>(
      'SELECT id, model_prefix, input_cost_per_million, output_cost_per_million, updated_at FROM model_pricing WHERE LOWER(model_prefix) = LOWER($1)',
      [prefix],
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async create(modelPrefix: string, inputCost: number, outputCost: number): Promise<PricingRecord> {
    const { rows } = await this.pool.query<any>(
      `INSERT INTO model_pricing (model_prefix, input_cost_per_million, output_cost_per_million)
       VALUES ($1, $2, $3)
       RETURNING id, model_prefix, input_cost_per_million, output_cost_per_million, updated_at`,
      [modelPrefix, inputCost, outputCost],
    );
    return this.toRecord(rows[0]);
  }

  async update(id: number, fields: { modelPrefix?: string; inputCostPerMillion?: number; outputCostPerMillion?: number }): Promise<PricingRecord | undefined> {
    const { rows } = await this.pool.query<any>(
      `UPDATE model_pricing
       SET model_prefix = COALESCE($2, model_prefix),
           input_cost_per_million = COALESCE($3, input_cost_per_million),
           output_cost_per_million = COALESCE($4, output_cost_per_million),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, model_prefix, input_cost_per_million, output_cost_per_million, updated_at`,
      [
        id,
        fields.modelPrefix ?? null,
        fields.inputCostPerMillion ?? null,
        fields.outputCostPerMillion ?? null,
      ],
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async delete(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM model_pricing WHERE id = $1',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  private toRecord(row: any): PricingRecord {
    return {
      id: row.id,
      modelPrefix: row.model_prefix,
      inputCostPerMillion: parseFloat(row.input_cost_per_million),
      outputCostPerMillion: parseFloat(row.output_cost_per_million),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }
}
