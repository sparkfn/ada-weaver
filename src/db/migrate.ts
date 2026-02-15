import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface MigrationFile {
  version: number;
  name: string;
  filePath: string;
}

/**
 * Discover migration files in the migrations directory.
 * Files must be named NNN_name.sql (e.g. 001_initial_schema.sql).
 */
function discoverMigrations(): MigrationFile[] {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  return files.map(f => {
    const match = f.match(/^(\d+)_(.+)\.sql$/);
    if (!match) throw new Error(`Invalid migration filename: ${f}`);
    return {
      version: parseInt(match[1], 10),
      name: f,
      filePath: path.join(MIGRATIONS_DIR, f),
    };
  });
}

/**
 * Ensure the schema_migrations table exists.
 */
async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Get the set of already-applied migration versions.
 */
async function getAppliedVersions(pool: pg.Pool): Promise<Set<number>> {
  const { rows } = await pool.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return new Set(rows.map(r => r.version));
}

/**
 * Run all unapplied migrations in order.
 * Each migration runs inside its own transaction.
 * Returns the number of migrations applied.
 */
export async function runMigrations(pool: pg.Pool): Promise<number> {
  await ensureMigrationsTable(pool);
  const applied = await getAppliedVersions(pool);
  const migrations = discoverMigrations();

  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    const sql = fs.readFileSync(migration.filePath, 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Remove the CREATE TABLE schema_migrations from the SQL if present,
      // since we already created it above (avoids "already exists" error).
      const filtered = sql.replace(
        /CREATE TABLE schema_migrations\s*\([\s\S]*?\);/gi,
        '-- (schema_migrations table created by migrator)',
      );
      await client.query(filtered);

      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name],
      );
      await client.query('COMMIT');

      console.log(`  Applied migration ${migration.name}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${migration.name} failed: ${err}`);
    } finally {
      client.release();
    }
  }

  return count;
}
