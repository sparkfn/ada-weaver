/**
 * A model pricing override record.
 */
export interface PricingRecord {
  id: number;
  modelPrefix: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  updatedAt: string;
}

/**
 * Repository interface for managing model pricing overrides.
 */
export interface PricingRepository {
  list(): PricingRecord[] | Promise<PricingRecord[]>;
  getById(id: number): PricingRecord | undefined | Promise<PricingRecord | undefined>;
  getByModelPrefix(prefix: string): PricingRecord | undefined | Promise<PricingRecord | undefined>;
  create(modelPrefix: string, inputCost: number, outputCost: number): PricingRecord | Promise<PricingRecord>;
  update(id: number, fields: { modelPrefix?: string; inputCostPerMillion?: number; outputCostPerMillion?: number }): PricingRecord | undefined | Promise<PricingRecord | undefined>;
  delete(id: number): boolean | Promise<boolean>;
}

/**
 * In-memory pricing repository for use without a database.
 */
export class InMemoryPricingRepository implements PricingRepository {
  private records: PricingRecord[] = [];
  private nextId = 1;

  list(): PricingRecord[] {
    return this.records.map(r => ({ ...r }));
  }

  getById(id: number): PricingRecord | undefined {
    const r = this.records.find(rec => rec.id === id);
    return r ? { ...r } : undefined;
  }

  getByModelPrefix(prefix: string): PricingRecord | undefined {
    const lower = prefix.toLowerCase();
    const r = this.records.find(rec => rec.modelPrefix.toLowerCase() === lower);
    return r ? { ...r } : undefined;
  }

  create(modelPrefix: string, inputCost: number, outputCost: number): PricingRecord {
    const lower = modelPrefix.toLowerCase();
    if (this.records.some(r => r.modelPrefix.toLowerCase() === lower)) {
      const err: any = new Error('duplicate model_prefix');
      err.code = '23505';
      throw err;
    }
    const record: PricingRecord = {
      id: this.nextId++,
      modelPrefix,
      inputCostPerMillion: inputCost,
      outputCostPerMillion: outputCost,
      updatedAt: new Date().toISOString(),
    };
    this.records.push(record);
    return { ...record };
  }

  update(id: number, fields: { modelPrefix?: string; inputCostPerMillion?: number; outputCostPerMillion?: number }): PricingRecord | undefined {
    const r = this.records.find(rec => rec.id === id);
    if (!r) return undefined;
    if (fields.modelPrefix !== undefined) r.modelPrefix = fields.modelPrefix;
    if (fields.inputCostPerMillion !== undefined) r.inputCostPerMillion = fields.inputCostPerMillion;
    if (fields.outputCostPerMillion !== undefined) r.outputCostPerMillion = fields.outputCostPerMillion;
    r.updatedAt = new Date().toISOString();
    return { ...r };
  }

  delete(id: number): boolean {
    const idx = this.records.findIndex(rec => rec.id === id);
    if (idx < 0) return false;
    this.records.splice(idx, 1);
    return true;
  }
}
