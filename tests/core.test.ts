import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import {
  loadPollState,
  savePollState,
  getMaxIssues,
  getMaxToolCalls,
  migratePollState,
  retractIssue,
  requestShutdown,
  isShuttingDown,
  resetShutdown,
  deduplicateIssueHierarchy,
} from '../src/core.js';
import type { IssueActions, PollState, IssueData } from '../src/core.js';
import { createGitHubClient } from '../src/github-tools.js';

vi.mock('../src/github-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/github-tools.js')>();
  return {
    ...actual,
    createGitHubClient: vi.fn(),
  };
});

vi.mock('../src/architect.js', () => ({
  runArchitect: vi.fn().mockResolvedValue({
    issueNumber: 0, prNumber: null, outcome: 'done',
  }),
}));

// ── getMaxIssues ──────────────────────────────────────────────────────────────

describe('getMaxIssues', () => {
  it('returns config value when it is a valid positive number', () => {
    expect(getMaxIssues({ maxIssuesPerRun: 10 } as any)).toBe(10);
  });

  it('returns config value of 1 (minimum valid)', () => {
    expect(getMaxIssues({ maxIssuesPerRun: 1 } as any)).toBe(1);
  });

  it('returns default (5) when config value is missing', () => {
    expect(getMaxIssues({} as any)).toBe(5);
  });

  it('returns default when config value is zero', () => {
    expect(getMaxIssues({ maxIssuesPerRun: 0 } as any)).toBe(5);
  });

  it('returns default when config value is negative', () => {
    expect(getMaxIssues({ maxIssuesPerRun: -1 } as any)).toBe(5);
  });

  it('returns default when config value is a string', () => {
    expect(getMaxIssues({ maxIssuesPerRun: 'banana' } as any)).toBe(5);
  });

  it('returns default when config value is null', () => {
    expect(getMaxIssues({ maxIssuesPerRun: null } as any)).toBe(5);
  });

  it('returns default when config value is undefined', () => {
    expect(getMaxIssues({ maxIssuesPerRun: undefined } as any)).toBe(5);
  });
});

// ── getMaxToolCalls ──────────────────────────────────────────────────────────

describe('getMaxToolCalls', () => {
  it('returns config value when it is a valid positive number', () => {
    expect(getMaxToolCalls({ maxToolCallsPerRun: 50 } as any)).toBe(50);
  });

  it('returns default (30) when config value is missing', () => {
    expect(getMaxToolCalls({} as any)).toBe(30);
  });

  it('returns default when config value is zero', () => {
    expect(getMaxToolCalls({ maxToolCallsPerRun: 0 } as any)).toBe(30);
  });

  it('returns default when config value is negative', () => {
    expect(getMaxToolCalls({ maxToolCallsPerRun: -5 } as any)).toBe(30);
  });

  it('returns default when config value is a string', () => {
    expect(getMaxToolCalls({ maxToolCallsPerRun: 'lots' } as any)).toBe(30);
  });
});

// ── loadPollState / savePollState ─────────────────────────────────────────────

describe('loadPollState', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync');
    vi.spyOn(fs, 'readFileSync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadPollState()).toBeNull();
  });

  it('returns parsed state when file exists', () => {
    const state = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1, 2, 3],
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
    // migratePollState adds issues field to old-format state (enriched format)
    expect(loadPollState()).toEqual({
      ...state,
      issues: {
        '1': { comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null },
        '2': { comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null },
        '3': { comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null },
      },
    });
  });
});

describe('savePollState', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes JSON state to file', () => {
    const state = {
      lastPollTimestamp: '2026-02-08T12:00:00Z',
      lastPollIssueNumbers: [10, 20],
    };
    savePollState(state);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(JSON.parse(content as string)).toEqual(state);
  });
});

// ── migratePollState ────────────────────────────────────────────────────────

describe('migratePollState', () => {
  it('passes through enriched-format state unchanged', () => {
    const state = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1, 2],
      issues: {
        '1': { comment: { id: 100, html_url: 'https://x' }, branch: { name: 'issue-1-fix', sha: 'abc' }, commits: [], pr: { number: 5, html_url: 'https://y' } },
        '2': { comment: null, branch: null, commits: [], pr: null },
      },
    };
    expect(migratePollState(state)).toEqual(state);
  });

  it('migrates pre-v0.2.10 state (no issues field) to enriched format', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [3, 7],
    };
    const result = migratePollState(old);
    expect(result.issues).toBeDefined();
    expect(result.issues!['3']).toEqual({ comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null });
    expect(result.issues!['7']).toEqual({ comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null });
    expect(result.lastPollIssueNumbers).toEqual([3, 7]);
  });

  it('migrates v0.2.10 boolean format to enriched format', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1, 2],
      issues: {
        '1': { commented: true, branch: 'issue-1-fix', pr: 5 },
        '2': { commented: false, branch: null, pr: null },
      },
    };
    const result = migratePollState(old);
    expect(result.issues!['1']).toEqual({
      comment: { id: 0, html_url: '' },
      branch: { name: 'issue-1-fix', sha: '' },
      commits: [],
      pr: { number: 5, html_url: '' },
    });
    expect(result.issues!['2']).toEqual({
      comment: null, branch: null, commits: [], pr: null,
    });
  });

  it('handles pre-v0.2.10 state with empty issue list', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [],
    };
    const result = migratePollState(old);
    expect(result.issues).toEqual({});
  });

  it('migrates v0.2.10 pr=-1 (attempted) as null in enriched format', () => {
    const old = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [4],
      issues: {
        '4': { commented: true, branch: null, pr: -1 },
      },
    };
    const result = migratePollState(old);
    expect(result.issues!['4'].pr).toBeNull();
  });

  it('strips legacy triageResults field from enriched format', () => {
    const stateWithTriage = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1],
      issues: {
        '1': { comment: null, branch: null, commits: [], pr: null },
      },
      triageResults: {
        '1': { issueType: 'bug', complexity: 'simple', relevantFiles: [], shouldAnalyze: true, summary: 'test' },
      },
    };
    const result = migratePollState(stateWithTriage);
    expect((result as any).triageResults).toBeUndefined();
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

describe('graceful shutdown', () => {
  afterEach(() => {
    resetShutdown();
  });

  it('isShuttingDown returns false by default', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('requestShutdown sets the flag to true', () => {
    requestShutdown();
    expect(isShuttingDown()).toBe(true);
  });

  it('resetShutdown clears the flag', () => {
    requestShutdown();
    expect(isShuttingDown()).toBe(true);
    resetShutdown();
    expect(isShuttingDown()).toBe(false);
  });

  it('multiple requestShutdown calls are idempotent', () => {
    requestShutdown();
    requestShutdown();
    requestShutdown();
    expect(isShuttingDown()).toBe(true);
    resetShutdown();
    expect(isShuttingDown()).toBe(false);
  });
});

// ── retractIssue ──────────────────────────────────────────────────────────────

describe('retractIssue', () => {
  let mockOctokit: any;

  function makePollState(issueNum: number, actions: IssueActions) {
    return {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [issueNum],
      issues: { [String(issueNum)]: actions },
    };
  }

  beforeEach(() => {
    mockOctokit = {
      rest: {
        pulls: { update: vi.fn().mockResolvedValue({ data: {} }) },
        git: { deleteRef: vi.fn().mockResolvedValue({ data: {} }) },
        issues: { deleteComment: vi.fn().mockResolvedValue({ data: {} }) },
      },
    };
    vi.mocked(createGitHubClient).mockReturnValue(mockOctokit as any);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes PR, deletes branch, and deletes comment for a fully-tracked issue', async () => {
    const actions: IssueActions = {
      comment: { id: 100, html_url: 'https://c' },
      branch: { name: 'issue-42-fix', sha: 'abc' },
      commits: [{ path: 'f.ts', sha: 'fs', commit_sha: 'cs' }],
      pr: { number: 10, html_url: 'https://pr' },
    };
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(makePollState(42, actions)));

    const config = { github: { owner: 'o', repo: 'r', token: 't' } } as any;
    const result = await retractIssue(config, 42);

    expect(result.prClosed).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.commentDeleted).toBe(true);
    expect(result.errors).toHaveLength(0);

    expect(mockOctokit.rest.pulls.update).toHaveBeenCalledWith({
      owner: 'o', repo: 'r', pull_number: 10, state: 'closed',
    });
    expect(mockOctokit.rest.git.deleteRef).toHaveBeenCalledWith({
      owner: 'o', repo: 'r', ref: 'heads/issue-42-fix',
    });
    expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledWith({
      owner: 'o', repo: 'r', comment_id: 100,
    });

    // Verify poll state was saved with the issue removed
    const savedState = JSON.parse((vi.mocked(fs.writeFileSync).mock.calls[0][1] as string));
    expect(savedState.issues['42']).toBeUndefined();
    expect(savedState.lastPollIssueNumbers).not.toContain(42);
  });

  it('throws when no poll state exists', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const config = { github: { owner: 'o', repo: 'r', token: 't' } } as any;
    await expect(retractIssue(config, 42)).rejects.toThrow('No poll state found');
  });

  it('throws when issue has no recorded actions', async () => {
    const state = {
      lastPollTimestamp: '2026-01-01T00:00:00Z',
      lastPollIssueNumbers: [1],
      issues: { '1': { comment: null, branch: null, commits: [], pr: null } },
    };
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(state));

    const config = { github: { owner: 'o', repo: 'r', token: 't' } } as any;
    await expect(retractIssue(config, 99)).rejects.toThrow('No actions recorded for issue #99');
  });

  it('handles partial retraction when only a PR exists (no branch, no comment)', async () => {
    const actions: IssueActions = {
      comment: null,
      branch: null,
      commits: [],
      pr: { number: 5, html_url: 'https://pr' },
    };
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(makePollState(7, actions)));

    const config = { github: { owner: 'o', repo: 'r', token: 't' } } as any;
    const result = await retractIssue(config, 7);

    expect(result.prClosed).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(result.commentDeleted).toBe(false);
    expect(result.errors).toHaveLength(0);

    expect(mockOctokit.rest.git.deleteRef).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });

  it('handles partial retraction when only a comment exists', async () => {
    const actions: IssueActions = {
      comment: { id: 200, html_url: 'https://c' },
      branch: null,
      commits: [],
      pr: null,
    };
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(makePollState(3, actions)));

    const config = { github: { owner: 'o', repo: 'r', token: 't' } } as any;
    const result = await retractIssue(config, 3);

    expect(result.prClosed).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.commentDeleted).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports errors but continues retraction when PR close fails', async () => {
    const actions: IssueActions = {
      comment: { id: 100, html_url: 'https://c' },
      branch: { name: 'issue-5-fix', sha: 'abc' },
      commits: [],
      pr: { number: 10, html_url: 'https://pr' },
    };
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(makePollState(5, actions)));
    mockOctokit.rest.pulls.update.mockRejectedValue(new Error('PR not found'));

    const config = { github: { owner: 'o', repo: 'r', token: 't' } } as any;
    const result = await retractIssue(config, 5);

    expect(result.prClosed).toBe(false);
    expect(result.branchDeleted).toBe(true);
    expect(result.commentDeleted).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to close PR');
  });

  it('skips actions with zero/empty IDs (migrated from old format)', async () => {
    const actions: IssueActions = {
      comment: { id: 0, html_url: '' },
      branch: { name: 'issue-1-fix', sha: '' },
      commits: [],
      pr: { number: 0, html_url: '' },
    };
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(makePollState(1, actions)));

    const config = { github: { owner: 'o', repo: 'r', token: 't' } } as any;
    const result = await retractIssue(config, 1);

    // PR with number 0 should be skipped
    expect(result.prClosed).toBe(false);
    expect(mockOctokit.rest.pulls.update).not.toHaveBeenCalled();
    // Branch with name should still be deleted (name is meaningful even without SHA)
    expect(result.branchDeleted).toBe(true);
    // Comment with id 0 should be skipped
    expect(result.commentDeleted).toBe(false);
    expect(mockOctokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });
});

// ── deduplicateIssueHierarchy ────────────────────────────────────────────────

describe('deduplicateIssueHierarchy', () => {
  function makeIssue(number: number, overrides: Partial<IssueData> = {}): IssueData {
    return { number, title: `Issue #${number}`, body: 'body', labels: [], ...overrides };
  }

  it('returns independent issues untouched', () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    const result = deduplicateIssueHierarchy(issues);
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it('removes child when parent is present (via subIssues)', () => {
    const parent = makeIssue(1, {
      subIssues: [makeIssue(2), makeIssue(3)],
    });
    const issues = [parent, makeIssue(2), makeIssue(3)];
    const result = deduplicateIssueHierarchy(issues);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it('removes child with parentIssue reference when parent is in batch', () => {
    const child = makeIssue(5, {
      parentIssue: { number: 3, title: 'Parent', body: 'body' },
    });
    const issues = [makeIssue(3), child];
    const result = deduplicateIssueHierarchy(issues);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(3);
  });

  it('keeps child when parent is NOT in the batch', () => {
    const child = makeIssue(5, {
      parentIssue: { number: 99, title: 'External Parent', body: 'body' },
    });
    const issues = [makeIssue(1), child];
    const result = deduplicateIssueHierarchy(issues);
    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    const result = deduplicateIssueHierarchy([]);
    expect(result).toEqual([]);
  });

  it('handles single parent with no children in batch', () => {
    const parent = makeIssue(1, {
      subIssues: [makeIssue(10), makeIssue(11)],
    });
    const result = deduplicateIssueHierarchy([parent]);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });
});
