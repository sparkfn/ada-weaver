import type pg from 'pg';
import type { PollRepository } from '../poll-repository.js';
import type { PollState, IssueActions } from '../core.js';

export class PostgresPollRepository implements PollRepository {
  constructor(private pool: pg.Pool) {}

  async load(repoId: number): Promise<PollState | null> {
    const { rows } = await this.pool.query<any>(
      'SELECT last_poll_timestamp, last_poll_issue_numbers FROM poll_state WHERE repo_id = $1',
      [repoId],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    const timestamp = row.last_poll_timestamp instanceof Date
      ? row.last_poll_timestamp.toISOString()
      : row.last_poll_timestamp;

    // Load issue actions
    const { rows: actionRows } = await this.pool.query<any>(
      'SELECT issue_number, comment_id, comment_url, branch_name, branch_sha, commits, pr_number, pr_url FROM issue_actions WHERE repo_id = $1',
      [repoId],
    );

    const issues: Record<string, IssueActions> = {};
    for (const ar of actionRows) {
      issues[String(ar.issue_number)] = {
        comment: ar.comment_id ? { id: ar.comment_id, html_url: ar.comment_url ?? '' } : null,
        branch: ar.branch_name ? { name: ar.branch_name, sha: ar.branch_sha ?? '' } : null,
        commits: ar.commits ?? [],
        pr: ar.pr_number ? { number: ar.pr_number, html_url: ar.pr_url ?? '' } : null,
      };
    }

    return {
      lastPollTimestamp: timestamp,
      lastPollIssueNumbers: row.last_poll_issue_numbers ?? [],
      issues,
    };
  }

  async save(repoId: number, state: PollState): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert poll_state
      await client.query(
        `INSERT INTO poll_state (repo_id, last_poll_timestamp, last_poll_issue_numbers)
         VALUES ($1, $2, $3)
         ON CONFLICT (repo_id) DO UPDATE SET
           last_poll_timestamp = EXCLUDED.last_poll_timestamp,
           last_poll_issue_numbers = EXCLUDED.last_poll_issue_numbers`,
        [repoId, state.lastPollTimestamp, state.lastPollIssueNumbers],
      );

      // Sync issue_actions: delete removed, upsert current
      if (state.issues) {
        const currentNumbers = new Set(Object.keys(state.issues).map(Number));

        // Get existing issue numbers for this repo
        const { rows: existing } = await client.query<{ issue_number: number }>(
          'SELECT issue_number FROM issue_actions WHERE repo_id = $1',
          [repoId],
        );
        const toDelete = existing
          .map(r => r.issue_number)
          .filter(n => !currentNumbers.has(n));

        if (toDelete.length > 0) {
          await client.query(
            'DELETE FROM issue_actions WHERE repo_id = $1 AND issue_number = ANY($2)',
            [repoId, toDelete],
          );
        }

        for (const [numStr, actions] of Object.entries(state.issues)) {
          const issueNumber = parseInt(numStr, 10);
          await client.query(
            `INSERT INTO issue_actions (repo_id, issue_number, comment_id, comment_url, branch_name, branch_sha, commits, pr_number, pr_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (repo_id, issue_number) DO UPDATE SET
               comment_id = EXCLUDED.comment_id,
               comment_url = EXCLUDED.comment_url,
               branch_name = EXCLUDED.branch_name,
               branch_sha = EXCLUDED.branch_sha,
               commits = EXCLUDED.commits,
               pr_number = EXCLUDED.pr_number,
               pr_url = EXCLUDED.pr_url`,
            [
              repoId,
              issueNumber,
              actions.comment?.id ?? null,
              actions.comment?.html_url ?? null,
              actions.branch?.name ?? null,
              actions.branch?.sha ?? null,
              JSON.stringify(actions.commits),
              actions.pr?.number ?? null,
              actions.pr?.html_url ?? null,
            ],
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getIssueActions(repoId: number, issueNumber: number): Promise<IssueActions | undefined> {
    const { rows } = await this.pool.query<any>(
      'SELECT comment_id, comment_url, branch_name, branch_sha, commits, pr_number, pr_url FROM issue_actions WHERE repo_id = $1 AND issue_number = $2',
      [repoId, issueNumber],
    );

    if (rows.length === 0) return undefined;
    const ar = rows[0];
    return {
      comment: ar.comment_id ? { id: ar.comment_id, html_url: ar.comment_url ?? '' } : null,
      branch: ar.branch_name ? { name: ar.branch_name, sha: ar.branch_sha ?? '' } : null,
      commits: ar.commits ?? [],
      pr: ar.pr_number ? { number: ar.pr_number, html_url: ar.pr_url ?? '' } : null,
    };
  }

  async setIssueActions(repoId: number, issueNumber: number, actions: IssueActions): Promise<void> {
    await this.pool.query(
      `INSERT INTO issue_actions (repo_id, issue_number, comment_id, comment_url, branch_name, branch_sha, commits, pr_number, pr_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (repo_id, issue_number) DO UPDATE SET
         comment_id = EXCLUDED.comment_id,
         comment_url = EXCLUDED.comment_url,
         branch_name = EXCLUDED.branch_name,
         branch_sha = EXCLUDED.branch_sha,
         commits = EXCLUDED.commits,
         pr_number = EXCLUDED.pr_number,
         pr_url = EXCLUDED.pr_url`,
      [
        repoId,
        issueNumber,
        actions.comment?.id ?? null,
        actions.comment?.html_url ?? null,
        actions.branch?.name ?? null,
        actions.branch?.sha ?? null,
        JSON.stringify(actions.commits),
        actions.pr?.number ?? null,
        actions.pr?.html_url ?? null,
      ],
    );
  }

  async deleteIssueActions(repoId: number, issueNumber: number): Promise<void> {
    await this.pool.query(
      'DELETE FROM issue_actions WHERE repo_id = $1 AND issue_number = $2',
      [repoId, issueNumber],
    );
  }
}
