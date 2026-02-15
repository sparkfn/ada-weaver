import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface DatabaseConfig {
  databaseUrl?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

/**
 * Build a Pool from either DATABASE_URL or individual PG_* fields.
 * DATABASE_URL takes precedence if both are set.
 */
function createPool(config: DatabaseConfig): pg.Pool {
  if (config.databaseUrl) {
    return new Pool({ connectionString: config.databaseUrl });
  }

  return new Pool({
    host: config.host ?? 'localhost',
    port: config.port ?? 5432,
    database: config.database ?? 'deepagents',
    user: config.user ?? 'deepagents',
    password: config.password,
  });
}

/**
 * Get or create the singleton connection pool.
 * Call initPool() first in your startup path; getPool() returns
 * the already-initialized pool (throws if not yet initialized).
 */
export function initPool(config: DatabaseConfig): pg.Pool {
  if (pool) return pool;
  pool = createPool(config);
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Database pool not initialized — call initPool() first');
  return pool;
}

export function hasPool(): boolean {
  return pool !== null;
}

/**
 * Gracefully close the pool (call on shutdown).
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
