/**
 * Repository interface for application settings (key-value with JSON values).
 */
export interface SettingsRepository {
  get<T = any>(key: string): T | undefined | Promise<T | undefined>;
  set<T = any>(key: string, value: T): void | Promise<void>;
  getAll(): Record<string, any> | Promise<Record<string, any>>;
  delete(key: string): boolean | Promise<boolean>;
}

/**
 * In-memory settings repository for use without a database.
 */
export class InMemorySettingsRepository implements SettingsRepository {
  private store = new Map<string, any>();

  get<T = any>(key: string): T | undefined {
    const val = this.store.get(key);
    return val !== undefined ? (JSON.parse(JSON.stringify(val)) as T) : undefined;
  }

  set<T = any>(key: string, value: T): void {
    this.store.set(key, JSON.parse(JSON.stringify(value)));
  }

  getAll(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [k, v] of this.store) {
      result[k] = JSON.parse(JSON.stringify(v));
    }
    return result;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }
}
