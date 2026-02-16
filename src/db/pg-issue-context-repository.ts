import type pg from 'pg';
import type {
  IssueContextRepository,
  IssueContextEntry,
  IssueContextEntryType,
  PastIssueSummary,
  AddEntryInput,
  SearchByFilesOptions,
  SearchRecentOptions,
} from '../issue-context-repository.js';

export class PostgresIssueContextRepository implements IssueContextRepository {
  constructor(private pool: pg.Pool, private defaultRepoId: number) {}

  async addEntry(input: AddEntryInput): Promise<IssueContextEntry> {
    const { rows } = await this.pool.query<any>(
      `INSERT INTO issue_context
         (repo_id, issue_number, process_id, entry_type, agent, content, files_touched, iteration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.repoId,
        input.issueNumber,
        input.processId ?? null,
        input.entryType,
        input.agent,
        input.content,
        input.filesTouched ?? [],
        input.iteration ?? 0,
      ],
    );
    return this.toEntry(rows[0]);
  }

  async getEntriesForProcess(processId: string): Promise<IssueContextEntry[]> {
    const { rows } = await this.pool.query<any>(
      `SELECT * FROM issue_context WHERE process_id = $1 ORDER BY created_at ASC`,
      [processId],
    );
    return rows.map(r => this.toEntry(r));
  }

  async getEntriesForIssue(repoId: number, issueNumber: number): Promise<IssueContextEntry[]> {
    const { rows } = await this.pool.query<any>(
      `SELECT * FROM issue_context WHERE repo_id = $1 AND issue_number = $2 ORDER BY created_at ASC`,
      [repoId, issueNumber],
    );
    return rows.map(r => this.toEntry(r));
  }

  async getEntriesByType(
    repoId: number,
    issueNumber: number,
    entryType: IssueContextEntryType,
  ): Promise<IssueContextEntry[]> {
    const { rows } = await this.pool.query<any>(
      `SELECT * FROM issue_context
       WHERE repo_id = $1 AND issue_number = $2 AND entry_type = $3
       ORDER BY created_at ASC`,
      [repoId, issueNumber, entryType],
    );
    return rows.map(r => this.toEntry(r));
  }

  async searchByFiles(
    repoId: number,
    files: string[],
    opts?: SearchByFilesOptions,
  ): Promise<PastIssueSummary[]> {
    const limit = opts?.limit ?? 20;
    const conditions: string[] = ['repo_id = $1', 'files_touched && $2'];
    const params: any[] = [repoId, files];
    let idx = 3;

    if (opts?.excludeIssueNumber !== undefined) {
      conditions.push(`issue_number != $${idx++}`);
      params.push(opts.excludeIssueNumber);
    }

    params.push(limit);
    const limitParam = `$${idx}`;

    const { rows } = await this.pool.query<any>(
      `SELECT * FROM issue_context
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${limitParam}`,
      params,
    );
    return rows.map(r => this.toSummary(r));
  }

  async searchRecent(
    repoId: number,
    opts?: SearchRecentOptions,
  ): Promise<PastIssueSummary[]> {
    const limit = opts?.limit ?? 10;
    const conditions: string[] = ['repo_id = $1', "entry_type = 'outcome'"];
    const params: any[] = [repoId];
    let idx = 2;

    if (opts?.excludeIssueNumber !== undefined) {
      conditions.push(`issue_number != $${idx++}`);
      params.push(opts.excludeIssueNumber);
    }

    params.push(limit);
    const limitParam = `$${idx}`;

    const { rows } = await this.pool.query<any>(
      `SELECT * FROM issue_context
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${limitParam}`,
      params,
    );
    return rows.map(r => this.toSummary(r));
  }

  private toEntry(row: any): IssueContextEntry {
    return {
      id: row.id,
      repoId: row.repo_id,
      issueNumber: row.issue_number,
      processId: row.process_id ?? null,
      entryType: row.entry_type,
      agent: row.agent,
      content: row.content,
      filesTouched: row.files_touched ?? [],
      iteration: row.iteration,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  private toSummary(row: any): PastIssueSummary {
    return {
      issueNumber: row.issue_number,
      entryType: row.entry_type,
      agent: row.agent,
      content: row.content,
      filesTouched: row.files_touched ?? [],
      iteration: row.iteration,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}
