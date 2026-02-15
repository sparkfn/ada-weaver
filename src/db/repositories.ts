import type { Config } from '../config.js';
import type { PollRepository } from '../poll-repository.js';
import { FilePollRepository } from '../poll-repository.js';
import type { ProcessRepository } from '../process-repository.js';
import { InMemoryProcessRepository } from '../process-repository.js';
import type { RepoRepository } from '../repo-repository.js';
import { StaticRepoRepository } from '../repo-repository.js';
import type { UsageRepository } from '../usage-repository.js';
import { InMemoryUsageRepository } from '../usage-repository.js';
import { initPool } from './connection.js';
import { runMigrations } from './migrate.js';
import { PostgresRepoRepository } from './pg-repo-repository.js';
import { PostgresPollRepository } from './pg-poll-repository.js';
import { PostgresUsageRepository } from './pg-usage-repository.js';
import { PostgresProcessRepository } from './pg-process-repository.js';

export interface Repositories {
  repoRepository: RepoRepository;
  pollRepository: PollRepository;
  processRepository: ProcessRepository;
  usageRepository: UsageRepository;
  repoId: number;
}

/**
 * Create repositories based on config.
 * If config.database is set, initializes PG pool, runs migrations, and
 * returns PG-backed repositories. Otherwise returns file/in-memory fallbacks.
 */
export async function createRepositories(config: Config): Promise<Repositories> {
  if (config.database) {
    const pool = initPool(config.database);

    // Auto-migrate on startup
    console.log('[db] Running migrations...');
    const count = await runMigrations(pool);
    if (count > 0) {
      console.log(`[db] Applied ${count} migration(s)`);
    } else {
      console.log('[db] Database is up to date');
    }

    const repoRepository = new PostgresRepoRepository(pool);

    // Ensure the configured repo exists in the repos table
    const { owner, repo } = config.github;
    const repoRecord = await repoRepository.ensureRepo(owner, repo);
    const repoId = repoRecord.id;
    console.log(`[db] Using repo ${owner}/${repo} (id=${repoId})`);

    return {
      repoRepository,
      pollRepository: new PostgresPollRepository(pool),
      processRepository: new PostgresProcessRepository(pool, repoId),
      usageRepository: new PostgresUsageRepository(pool, repoId),
      repoId,
    };
  }

  // Fallback: file-based + in-memory
  const { owner, repo } = config.github;
  return {
    repoRepository: new StaticRepoRepository(owner, repo),
    pollRepository: new FilePollRepository(),
    processRepository: new InMemoryProcessRepository(),
    usageRepository: new InMemoryUsageRepository(),
    repoId: 0,
  };
}
