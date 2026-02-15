import fs from 'fs';
import path from 'path';
import type { PollState, IssueActions } from './core.js';
import { migratePollState } from './core.js';

/**
 * Repository interface for poll state persistence.
 */
export interface PollRepository {
  load(repoId: number): PollState | null | Promise<PollState | null>;
  save(repoId: number, state: PollState): void | Promise<void>;
  getIssueActions(repoId: number, issueNumber: number): IssueActions | undefined | Promise<IssueActions | undefined>;
  setIssueActions(repoId: number, issueNumber: number, actions: IssueActions): void | Promise<void>;
  deleteIssueActions(repoId: number, issueNumber: number): void | Promise<void>;
}

/**
 * File-based poll repository -- wraps the existing last_poll.json logic.
 * Ignores repoId (file is shared for the single configured repo).
 */
export class FilePollRepository implements PollRepository {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.resolve('./last_poll.json');
  }

  load(_repoId: number): PollState | null {
    if (!fs.existsSync(this.filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    return migratePollState(raw);
  }

  save(_repoId: number, state: PollState): void {
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  getIssueActions(_repoId: number, issueNumber: number): IssueActions | undefined {
    const state = this.load(0);
    return state?.issues?.[String(issueNumber)];
  }

  setIssueActions(_repoId: number, issueNumber: number, actions: IssueActions): void {
    const state = this.load(0);
    if (!state) return;
    if (!state.issues) state.issues = {};
    state.issues[String(issueNumber)] = actions;
    this.save(0, state);
  }

  deleteIssueActions(_repoId: number, issueNumber: number): void {
    const state = this.load(0);
    if (!state?.issues) return;
    delete state.issues[String(issueNumber)];
    this.save(0, state);
  }
}
