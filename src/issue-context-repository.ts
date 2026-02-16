// ── Types ────────────────────────────────────────────────────────────────────

export type IssueContextEntryType =
  | 'issuer_brief'
  | 'architect_plan'
  | 'coder_plan'
  | 'review_feedback'
  | 'ci_result'
  | 'outcome';

export interface IssueContextEntry {
  id: number;
  repoId: number;
  issueNumber: number;
  processId: string | null;
  entryType: IssueContextEntryType;
  agent: string;
  content: string;
  filesTouched: string[];
  iteration: number;
  createdAt: string;
}

export interface PastIssueSummary {
  issueNumber: number;
  entryType: IssueContextEntryType;
  agent: string;
  content: string;
  filesTouched: string[];
  iteration: number;
  createdAt: string;
}

export interface AddEntryInput {
  repoId: number;
  issueNumber: number;
  processId?: string | null;
  entryType: IssueContextEntryType;
  agent: string;
  content: string;
  filesTouched?: string[];
  iteration?: number;
}

export interface SearchByFilesOptions {
  limit?: number;
  excludeIssueNumber?: number;
}

export interface SearchRecentOptions {
  limit?: number;
  excludeIssueNumber?: number;
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface IssueContextRepository {
  addEntry(entry: AddEntryInput): Promise<IssueContextEntry>;
  getEntriesForProcess(processId: string): Promise<IssueContextEntry[]>;
  getEntriesForIssue(repoId: number, issueNumber: number): Promise<IssueContextEntry[]>;
  getEntriesByType(repoId: number, issueNumber: number, entryType: IssueContextEntryType): Promise<IssueContextEntry[]>;
  searchByFiles(repoId: number, files: string[], opts?: SearchByFilesOptions): Promise<PastIssueSummary[]>;
  searchRecent(repoId: number, opts?: SearchRecentOptions): Promise<PastIssueSummary[]>;
}

// ── In-memory implementation ─────────────────────────────────────────────────

export class InMemoryIssueContextRepository implements IssueContextRepository {
  private entries: IssueContextEntry[] = [];
  private nextId = 1;

  async addEntry(input: AddEntryInput): Promise<IssueContextEntry> {
    const entry: IssueContextEntry = {
      id: this.nextId++,
      repoId: input.repoId,
      issueNumber: input.issueNumber,
      processId: input.processId ?? null,
      entryType: input.entryType,
      agent: input.agent,
      content: input.content,
      filesTouched: input.filesTouched ?? [],
      iteration: input.iteration ?? 0,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  async getEntriesForProcess(processId: string): Promise<IssueContextEntry[]> {
    return this.entries.filter(e => e.processId === processId);
  }

  async getEntriesForIssue(repoId: number, issueNumber: number): Promise<IssueContextEntry[]> {
    return this.entries.filter(e => e.repoId === repoId && e.issueNumber === issueNumber);
  }

  async getEntriesByType(
    repoId: number,
    issueNumber: number,
    entryType: IssueContextEntryType,
  ): Promise<IssueContextEntry[]> {
    return this.entries.filter(
      e => e.repoId === repoId && e.issueNumber === issueNumber && e.entryType === entryType,
    );
  }

  async searchByFiles(
    repoId: number,
    files: string[],
    opts?: SearchByFilesOptions,
  ): Promise<PastIssueSummary[]> {
    const limit = opts?.limit ?? 20;
    const excludeIssue = opts?.excludeIssueNumber;

    const matching = this.entries.filter(e => {
      if (e.repoId !== repoId) return false;
      if (excludeIssue !== undefined && e.issueNumber === excludeIssue) return false;
      // Array overlap: at least one file in common
      return e.filesTouched.some(f => files.includes(f));
    });

    return matching
      .slice(0, limit)
      .map(e => this.toSummary(e));
  }

  async searchRecent(
    repoId: number,
    opts?: SearchRecentOptions,
  ): Promise<PastIssueSummary[]> {
    const limit = opts?.limit ?? 10;
    const excludeIssue = opts?.excludeIssueNumber;

    const outcomes = this.entries.filter(e => {
      if (e.repoId !== repoId) return false;
      if (e.entryType !== 'outcome') return false;
      if (excludeIssue !== undefined && e.issueNumber === excludeIssue) return false;
      return true;
    });

    // Return most recent first
    return outcomes
      .slice(-limit)
      .reverse()
      .map(e => this.toSummary(e));
  }

  private toSummary(e: IssueContextEntry): PastIssueSummary {
    return {
      issueNumber: e.issueNumber,
      entryType: e.entryType,
      agent: e.agent,
      content: e.content,
      filesTouched: e.filesTouched,
      iteration: e.iteration,
      createdAt: e.createdAt,
    };
  }
}
