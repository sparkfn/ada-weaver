/**
 * A configured repository (GitHub owner/repo pair).
 */
export interface RepoRecord {
  id: number;
  owner: string;
  repo: string;
  isActive: boolean;
  addedAt: string;
  configJson?: Record<string, unknown>;
}

/**
 * Repository interface for managing tracked GitHub repositories.
 */
export interface RepoRepository {
  getById(id: number): RepoRecord | undefined | Promise<RepoRecord | undefined>;
  getByOwnerRepo(owner: string, repo: string): RepoRecord | undefined | Promise<RepoRecord | undefined>;
  ensureRepo(owner: string, repo: string): RepoRecord | Promise<RepoRecord>;
  list(activeOnly?: boolean): RepoRecord[] | Promise<RepoRecord[]>;
}

/**
 * Static repo repository -- returns a single repo from env var config.
 * Uses id=0 as a sentinel (no database row exists).
 */
export class StaticRepoRepository implements RepoRepository {
  private repo: RepoRecord;

  constructor(owner: string, repo: string) {
    this.repo = {
      id: 0,
      owner,
      repo,
      isActive: true,
      addedAt: new Date().toISOString(),
    };
  }

  getById(id: number): RepoRecord | undefined {
    return id === 0 ? { ...this.repo } : undefined;
  }

  getByOwnerRepo(owner: string, repo: string): RepoRecord | undefined {
    if (owner === this.repo.owner && repo === this.repo.repo) {
      return { ...this.repo };
    }
    return undefined;
  }

  ensureRepo(owner: string, repo: string): RepoRecord {
    if (owner === this.repo.owner && repo === this.repo.repo) {
      return { ...this.repo };
    }
    throw new Error(`StaticRepoRepository only supports ${this.repo.owner}/${this.repo.repo}`);
  }

  list(_activeOnly?: boolean): RepoRecord[] {
    return [{ ...this.repo }];
  }
}
