import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCommentOnIssueTool,
  createBranchTool,
  createPullRequestTool,
  createGitHubIssuesTool,
  createListRepoFilesTool,
  createReadRepoFileTool,
  createDryRunCommentTool,
  createDryRunBranchTool,
  createDryRunPullRequestTool,
  createGetPrDiffTool,
  createSubmitPrReviewTool,
  createFetchSubIssuesTool,
  createGetParentIssueTool,
  createCreateSubIssueTool,
  createDryRunCreateSubIssueTool,
  createCheckCiStatusTool,
  createDryRunCheckCiStatusTool,
  BOT_REVIEW_MARKER,
  ToolCallCounter,
  CircuitBreakerError,
  wrapWithCircuitBreaker,
  createGitHubClient,
  getAuthFromConfig,
} from '../src/github-tools.js';

/**
 * Mock Octokit factory.
 * Returns an object matching the shape used by the tool functions.
 */
function createMockOctokit(overrides: Record<string, any> = {}) {
  return {
    request: vi.fn(),
    rest: {
      issues: {
        listForRepo: vi.fn(),
        listComments: vi.fn(),
        createComment: vi.fn(),
        create: vi.fn(),
      },
      git: {
        getRef: vi.fn(),
        getCommit: vi.fn(),
        getTree: vi.fn(),
        createRef: vi.fn(),
      },
      pulls: {
        list: vi.fn(),
        create: vi.fn(),
        get: vi.fn(),
        listReviews: vi.fn(),
        createReview: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
      },
      checks: {
        listForRef: vi.fn(),
      },
      ...overrides,
    },
  } as any;
}

// ── Comment idempotency ───────────────────────────────────────────────────────

describe('createCommentOnIssueTool (idempotency)', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('skips when marker comment already exists', async () => {
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { body: '<!-- deep-agent-analysis -->\nSome analysis here' },
      ],
    });

    const toolFn = createCommentOnIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ issue_number: 1, body: 'New analysis' }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('already exists');
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('posts comment when no marker found', async () => {
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ body: 'Regular comment without marker' }],
    });
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { id: 123, html_url: 'https://github.com/owner/repo/issues/1#issuecomment-123', created_at: '2026-02-08' },
    });

    const toolFn = createCommentOnIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ issue_number: 1, body: 'Analysis' }));

    expect(result.skipped).toBeUndefined();
    expect(result.id).toBe(123);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    // Verify the marker is prepended to the body
    const callArgs = octokit.rest.issues.createComment.mock.calls[0][0];
    expect(callArgs.body).toContain('<!-- deep-agent-analysis -->');
  });

  it('posts comment when comments list is empty', async () => {
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { id: 456, html_url: 'https://github.com/owner/repo/issues/2#issuecomment-456', created_at: '2026-02-08' },
    });

    const toolFn = createCommentOnIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ issue_number: 2, body: 'Analysis' }));

    expect(result.id).toBe(456);
  });
});

// ── Branch idempotency ────────────────────────────────────────────────────────

describe('createBranchTool (idempotency)', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('skips when branch already exists', async () => {
    // First getRef call (existence check) succeeds -- branch exists
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'abc123' } },
    });

    const toolFn = createBranchTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ branch_name: 'issue-1-fix' }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('already exists');
    expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
  });

  it('creates branch when it does not exist (404)', async () => {
    // First getRef call (existence check) throws 404
    octokit.rest.git.getRef.mockRejectedValueOnce({ status: 404 });
    // Second getRef call (get source branch SHA) succeeds
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'main-sha-123' } },
    });
    octokit.rest.git.createRef.mockResolvedValue({});

    const toolFn = createBranchTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ branch_name: 'issue-2-new', from_branch: 'main' }));

    expect(result.skipped).toBeUndefined();
    expect(result.branch).toBe('issue-2-new');
    expect(result.sha).toBe('main-sha-123');
    expect(octokit.rest.git.createRef).toHaveBeenCalledTimes(1);
  });

  it('re-throws non-404 errors from existence check', async () => {
    // Use 403 (non-retryable) so withRetry does not retry and cause timeouts
    octokit.rest.git.getRef.mockRejectedValueOnce({ status: 403 });

    const toolFn = createBranchTool('owner', 'repo', octokit);
    const result = await toolFn.invoke({ branch_name: 'issue-3-err' });

    // Should return an error string (tool catch block)
    expect(result).toContain('Error creating branch');
  });
});

// ── PR idempotency ────────────────────────────────────────────────────────────

describe('createPullRequestTool (idempotency)', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('skips when open PR exists for the same head branch', async () => {
    octokit.rest.pulls.list.mockResolvedValue({
      data: [{ number: 10, html_url: 'https://github.com/owner/repo/pull/10' }],
    });

    const toolFn = createPullRequestTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({
      title: 'Fix #1',
      body: 'Closes #1',
      head: 'issue-1-fix',
    }));

    expect(result.skipped).toBe(true);
    expect(result.number).toBe(10);
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
  });

  it('creates PR when no existing open PR found', async () => {
    octokit.rest.pulls.list.mockResolvedValue({ data: [] });
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 11, html_url: 'https://github.com/owner/repo/pull/11', state: 'open' },
    });

    const toolFn = createPullRequestTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({
      title: 'Fix #2',
      body: 'Closes #2',
      head: 'issue-2-fix',
    }));

    expect(result.number).toBe(11);
    expect(octokit.rest.pulls.create).toHaveBeenCalledTimes(1);
    // Verify draft is not set (open PR by default)
    const callArgs = octokit.rest.pulls.create.mock.calls[0][0];
    expect(callArgs.draft).toBeUndefined();
  });

  it('uses owner:head format for the head parameter in list', async () => {
    octokit.rest.pulls.list.mockResolvedValue({ data: [] });
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 12, html_url: 'url', state: 'open' },
    });

    const toolFn = createPullRequestTool('myorg', 'repo', octokit);
    await toolFn.invoke({ title: 'T', body: 'B', head: 'my-branch' });

    const listArgs = octokit.rest.pulls.list.mock.calls[0][0];
    expect(listArgs.head).toBe('myorg:my-branch');
  });
});

// ── Fetch issues ──────────────────────────────────────────────────────────────

describe('createGitHubIssuesTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns formatted issues', async () => {
    octokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 1,
          title: 'Bug report',
          body: 'Something is broken',
          state: 'open',
          created_at: '2026-01-01',
          updated_at: '2026-02-01',
          html_url: 'https://github.com/owner/repo/issues/1',
          labels: [{ name: 'bug' }],
        },
      ],
    });

    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ state: 'open', limit: 5 }));

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].title).toBe('Bug report');
    expect(result[0].labels).toEqual(['bug']);
  });

  it('passes since parameter when provided', async () => {
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });

    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit);
    await toolFn.invoke({ since: '2026-01-01T00:00:00Z' });

    const callArgs = octokit.rest.issues.listForRepo.mock.calls[0][0];
    expect(callArgs.since).toBe('2026-01-01T00:00:00Z');
  });

  it('returns error string on API failure', async () => {
    octokit.rest.issues.listForRepo.mockRejectedValue(new Error('API rate limited'));

    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit);
    const result = await toolFn.invoke({ state: 'open' });

    expect(result).toContain('Error fetching issues');
    expect(result).toContain('API rate limited');
  });

  it('clamps limit to maxIssues when maxIssues is provided', async () => {
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });

    // maxIssues = 3, but agent requests limit = 10 → clamped to 3
    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit, 3);
    await toolFn.invoke({ state: 'open', limit: 10 });

    const callArgs = octokit.rest.issues.listForRepo.mock.calls[0][0];
    expect(callArgs.per_page).toBe(3);
  });

  it('keeps limit when it is below maxIssues', async () => {
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });

    // maxIssues = 10, agent requests limit = 3 → stays at 3
    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit, 10);
    await toolFn.invoke({ state: 'open', limit: 3 });

    const callArgs = octokit.rest.issues.listForRepo.mock.calls[0][0];
    expect(callArgs.per_page).toBe(3);
  });

  it('does not clamp when maxIssues is not provided', async () => {
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });

    const toolFn = createGitHubIssuesTool('owner', 'repo', octokit);
    await toolFn.invoke({ state: 'open', limit: 20 });

    const callArgs = octokit.rest.issues.listForRepo.mock.calls[0][0];
    expect(callArgs.per_page).toBe(20);
  });
});

// ── List repo files (depth limiting) ─────────────────────────────────────────

describe('createListRepoFilesTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  // Helper: build a mock tree response
  function mockTree(files: string[], truncated = false) {
    octokit.rest.git.getRef.mockResolvedValue({ data: { object: { sha: 'ref-sha' } } });
    octokit.rest.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'tree-sha' } } });
    octokit.rest.git.getTree.mockResolvedValue({
      data: {
        sha: 'tree-sha',
        truncated,
        tree: files.map((f) => ({ path: f, type: 'blob', size: 100 })),
      },
    });
  }

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('defaults to depth 2 when no path is given', async () => {
    mockTree([
      'README.md',
      'package.json',
      'src/index.ts',
      'src/utils.ts',
      'src/lib/helper.ts',
      'src/lib/deep/nested.ts',
      'tests/test.ts',
    ]);

    const toolFn = createListRepoFilesTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({}));

    // Depth 2: README.md (1 segment), src/index.ts (2 segments), src/utils.ts (2), tests/test.ts (2) are within depth
    // src/lib/helper.ts (3 segments) and src/lib/deep/nested.ts (4 segments) are beyond depth
    expect(result.shown_files).toBe(5);
    expect(result.total_files).toBe(7);
    expect(result.directories).toBeDefined();
    expect(result.directories).toHaveLength(1); // src/lib/
    expect(result.directories[0].path).toBe('src/lib/');
    expect(result.directories[0].files_below).toBe(2);
    expect(result.note).toContain('depth 2');
    expect(result.note).toContain('src/lib/');
  });

  it('returns all files under a path when path is specified (no depth limit)', async () => {
    mockTree([
      'README.md',
      'src/index.ts',
      'src/lib/helper.ts',
      'src/lib/deep/nested.ts',
    ]);

    const toolFn = createListRepoFilesTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'src/' }));

    // Path filter: only src/ files, no depth limit
    expect(result.files).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.directories).toBeUndefined();
  });

  it('respects explicit depth parameter', async () => {
    mockTree([
      'README.md',
      'src/index.ts',
      'src/lib/helper.ts',
      'src/lib/deep/nested.ts',
    ]);

    const toolFn = createListRepoFilesTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ depth: 1 }));

    // Depth 1: only README.md (1 segment)
    expect(result.shown_files).toBe(1);
    expect(result.files[0].path).toBe('README.md');
    expect(result.directories).toHaveLength(1); // src/
    expect(result.directories[0].path).toBe('src/');
    expect(result.directories[0].files_below).toBe(3);
  });

  it('combines path and depth', async () => {
    mockTree([
      'src/index.ts',
      'src/lib/helper.ts',
      'src/lib/deep/nested.ts',
      'src/lib/deep/other.ts',
    ]);

    const toolFn = createListRepoFilesTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'src/', depth: 1 }));

    // Under src/ with depth 1: only src/index.ts (1 segment relative to prefix)
    // src/lib/helper.ts (2 relative), src/lib/deep/* (3 relative) go to directories
    expect(result.shown_files).toBe(1);
    expect(result.files[0].path).toBe('src/index.ts');
    expect(result.directories).toHaveLength(1); // src/lib/
    expect(result.directories[0].path).toBe('src/lib/');
    expect(result.directories[0].files_below).toBe(3);
  });

  it('returns all files when everything is within depth', async () => {
    mockTree(['README.md', 'src/index.ts']);

    const toolFn = createListRepoFilesTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({}));

    expect(result.shown_files).toBe(2);
    expect(result.total_files).toBe(2);
    // No directories when nothing is beyond depth
    expect(result.directories).toBeUndefined();
  });

  it('includes truncation warning when GitHub API truncates tree', async () => {
    mockTree(['README.md'], true);

    const toolFn = createListRepoFilesTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({}));

    expect(result.warning).toContain('truncated');
  });

  it('returns error string on API failure', async () => {
    octokit.rest.git.getRef.mockRejectedValue(new Error('Not found'));

    const toolFn = createListRepoFilesTool('owner', 'repo', octokit);
    const result = await toolFn.invoke({});

    expect(result).toContain('Error listing files');
  });
});

// ── Read repo file (truncation) ───────────────────────────────────────────────

describe('createReadRepoFileTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns file content decoded from base64', async () => {
    const content = 'Hello, world!';
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'README.md',
        size: content.length,
        sha: 'abc',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'README.md' }));

    expect(result.content).toBe('Hello, world!');
    expect(result.path).toBe('README.md');
  });

  it('truncates files over 500 lines', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'big.ts',
        size: content.length,
        sha: 'def',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'big.ts' }));

    expect(result.truncated).toBe(true);
    expect(result.total_lines).toBe(600);
    expect(result.shown_lines).toBe(500);
    expect(result.content.split('\n')).toHaveLength(500);
  });

  it('returns error for directories', async () => {
    octokit.rest.repos.getContent.mockResolvedValue({
      data: [{ name: 'file1.ts' }, { name: 'file2.ts' }],
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = await toolFn.invoke({ path: 'src' });

    expect(result).toContain('directory');
  });

  it('returns targeted range with startLine and endLine', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'big.ts',
        size: content.length,
        sha: 'abc',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'big.ts', startLine: 10, endLine: 15 }));

    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(15);
    expect(result.total_lines).toBe(200);
    const returnedLines = result.content.split('\n');
    expect(returnedLines).toHaveLength(6); // lines 10-15 inclusive
    expect(returnedLines[0]).toBe('line 10');
    expect(returnedLines[5]).toBe('line 15');
  });

  it('returns from startLine to end when only startLine given', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'small.ts',
        size: content.length,
        sha: 'abc',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'small.ts', startLine: 18 }));

    expect(result.startLine).toBe(18);
    expect(result.endLine).toBe(20);
    expect(result.total_lines).toBe(20);
    const returnedLines = result.content.split('\n');
    expect(returnedLines).toHaveLength(3); // lines 18-20
    expect(returnedLines[0]).toBe('line 18');
  });

  it('returns from beginning to endLine when only endLine given', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'small.ts',
        size: content.length,
        sha: 'abc',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'small.ts', endLine: 3 }));

    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
    expect(result.total_lines).toBe(20);
    const returnedLines = result.content.split('\n');
    expect(returnedLines).toHaveLength(3); // lines 1-3
    expect(returnedLines[0]).toBe('line 1');
    expect(returnedLines[2]).toBe('line 3');
  });

  it('includes metadata in line-range response', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'src/app.ts',
        size: content.length,
        sha: 'xyz',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'src/app.ts', startLine: 50, endLine: 60 }));

    expect(result.path).toBe('src/app.ts');
    expect(result.sha).toBe('xyz');
    expect(result.startLine).toBe(50);
    expect(result.endLine).toBe(60);
    expect(result.total_lines).toBe(100);
    // Should NOT have truncated flag (line range is explicit)
    expect(result.truncated).toBeUndefined();
  });

  it('truncation note mentions startLine/endLine', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'huge.ts',
        size: content.length,
        sha: 'def',
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      },
    });

    const toolFn = createReadRepoFileTool('owner', 'repo', octokit);
    const result = JSON.parse(await toolFn.invoke({ path: 'huge.ts' }));

    expect(result.truncated).toBe(true);
    expect(result.note).toContain('startLine/endLine');
  });
});

// ── Dry-run tool wrappers ───────────────────────────────────────────────────

describe('createDryRunCommentTool', () => {
  it('returns dry_run result without making API calls', async () => {
    const toolFn = createDryRunCommentTool();
    const result = JSON.parse(await toolFn.invoke({ issue_number: 1, body: 'Test analysis' }));

    expect(result.dry_run).toBe(true);
    expect(result.id).toBe(0);
    expect(result.html_url).toContain('issue #1');
  });

  it('has the same tool name as the real tool', () => {
    const toolFn = createDryRunCommentTool();
    expect(toolFn.name).toBe('comment_on_issue');
  });
});

describe('createDryRunBranchTool', () => {
  it('returns dry_run result without making API calls', async () => {
    const toolFn = createDryRunBranchTool();
    const result = JSON.parse(await toolFn.invoke({ branch_name: 'issue-5-test' }));

    expect(result.dry_run).toBe(true);
    expect(result.branch).toBe('issue-5-test');
    expect(result.sha).toBe('0000000000000000000000000000000000000000');
  });

  it('has the same tool name as the real tool', () => {
    const toolFn = createDryRunBranchTool();
    expect(toolFn.name).toBe('create_branch');
  });
});

describe('createDryRunPullRequestTool', () => {
  it('returns dry_run result without making API calls', async () => {
    const toolFn = createDryRunPullRequestTool();
    const result = JSON.parse(await toolFn.invoke({
      title: 'Fix #5: Test',
      body: 'Closes #5',
      head: 'issue-5-test',
    }));

    expect(result.dry_run).toBe(true);
    expect(result.number).toBe(0);
    expect(result.draft).toBeUndefined();
  });

  it('has the same tool name as the real tool', () => {
    const toolFn = createDryRunPullRequestTool();
    expect(toolFn.name).toBe('create_pull_request');
  });
});

// ── Circuit breaker ─────────────────────────────────────────────────────────

describe('ToolCallCounter', () => {
  it('increments count on each call', () => {
    const counter = new ToolCallCounter(5);
    counter.increment('tool_a');
    counter.increment('tool_b');
    expect(counter.getCount()).toBe(2);
  });

  it('allows calls up to the limit', () => {
    const counter = new ToolCallCounter(3);
    expect(() => counter.increment('a')).not.toThrow();
    expect(() => counter.increment('b')).not.toThrow();
    expect(() => counter.increment('c')).not.toThrow();
  });

  it('throws CircuitBreakerError when limit is exceeded', () => {
    const counter = new ToolCallCounter(2);
    counter.increment('a');
    counter.increment('b');
    expect(() => counter.increment('c')).toThrow(CircuitBreakerError);
  });

  it('includes tool name and counts in error', () => {
    const counter = new ToolCallCounter(1);
    counter.increment('first');
    try {
      counter.increment('second');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitBreakerError);
      const err = e as CircuitBreakerError;
      expect(err.callCount).toBe(2);
      expect(err.callLimit).toBe(1);
      expect(err.message).toContain('second');
    }
  });
});

describe('wrapWithCircuitBreaker', () => {
  it('wraps a dry-run tool and counts calls', async () => {
    const counter = new ToolCallCounter(10);
    const tool = wrapWithCircuitBreaker(createDryRunBranchTool(), counter);

    await tool.invoke({ branch_name: 'test-1' });
    await tool.invoke({ branch_name: 'test-2' });

    expect(counter.getCount()).toBe(2);
  });

  it('throws when limit exceeded via wrapped tool', async () => {
    const counter = new ToolCallCounter(1);
    const tool = wrapWithCircuitBreaker(createDryRunBranchTool(), counter);

    await tool.invoke({ branch_name: 'ok' });
    await expect(tool.invoke({ branch_name: 'too-many' })).rejects.toThrow(CircuitBreakerError);
  });

  it('shares counter across multiple wrapped tools', async () => {
    const counter = new ToolCallCounter(2);
    const branchTool = wrapWithCircuitBreaker(createDryRunBranchTool(), counter);
    const commentTool = wrapWithCircuitBreaker(createDryRunCommentTool(), counter);

    await branchTool.invoke({ branch_name: 'b1' });
    await commentTool.invoke({ issue_number: 1, body: 'hello' });
    // Third call should trip the breaker
    await expect(branchTool.invoke({ branch_name: 'b2' })).rejects.toThrow(CircuitBreakerError);
  });
});

// ── Auth helpers ────────────────────────────────────────────────────────────

describe('getAuthFromConfig', () => {
  it('returns PAT string when token is present', () => {
    const result = getAuthFromConfig({ token: 'ghp_test123' });
    expect(result).toBe('ghp_test123');
  });

  it('returns GitHubAppAuth when app fields are present', () => {
    const result = getAuthFromConfig({
      appId: 12345,
      privateKeyPath: '/tmp/key.pem',
      installationId: 67890,
    });
    expect(result).toEqual({
      appId: 12345,
      privateKeyPath: '/tmp/key.pem',
      installationId: 67890,
    });
  });

  it('prefers app fields over token when both present', () => {
    const result = getAuthFromConfig({
      token: 'ghp_test123',
      appId: 12345,
      privateKeyPath: '/tmp/key.pem',
      installationId: 67890,
    });
    // App auth takes precedence when all fields are present
    expect(typeof result).toBe('object');
    expect((result as any).appId).toBe(12345);
  });
});

describe('createGitHubClient', () => {
  it('creates Octokit with PAT auth', () => {
    const client = createGitHubClient('ghp_test123');
    expect(client).toBeDefined();
    expect(client.rest).toBeDefined();
  });

  it('creates Octokit with App auth when given GitHubAppAuth', () => {
    // We need a real .pem file for this test -- mock fs.readFileSync
    const fs = require('fs');
    const originalReadFileSync = fs.readFileSync;
    const fakePem = '-----BEGIN RSA PRIVATE KEY-----\nfake-key-content\n-----END RSA PRIVATE KEY-----';
    vi.spyOn(fs, 'readFileSync').mockReturnValue(fakePem);

    const client = createGitHubClient({
      appId: 12345,
      privateKeyPath: '/tmp/fake-key.pem',
      installationId: 67890,
    });

    expect(client).toBeDefined();
    expect(client.rest).toBeDefined();
    expect(fs.readFileSync).toHaveBeenCalledWith('/tmp/fake-key.pem', 'utf-8');

    vi.mocked(fs.readFileSync).mockRestore();
  });
});

// ── PR diff tool ────────────────────────────────────────────────────────────

describe('createGetPrDiffTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns PR diff as text', async () => {
    const diffText = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';
    octokit.rest.pulls.get.mockResolvedValue({ data: diffText });

    const tool = createGetPrDiffTool(octokit, 'owner', 'repo');
    const result = await tool.invoke({ pull_number: 10 });

    expect(result).toBe(diffText);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner', repo: 'repo', pull_number: 10,
      mediaType: { format: 'diff' },
    });
  });

  it('truncates diffs over 50000 characters', async () => {
    const longDiff = 'x'.repeat(60000);
    octokit.rest.pulls.get.mockResolvedValue({ data: longDiff });

    const tool = createGetPrDiffTool(octokit, 'owner', 'repo');
    const result = await tool.invoke({ pull_number: 5 });

    expect(result.length).toBeLessThan(60000);
    expect(result).toContain('truncated');
    expect(result).toContain('60000');
  });

  it('returns error message on API failure', async () => {
    octokit.rest.pulls.get.mockRejectedValue(new Error('Not found'));

    const tool = createGetPrDiffTool(octokit, 'owner', 'repo');
    const result = await tool.invoke({ pull_number: 999 });

    expect(result).toContain('Error');
    expect(result).toContain('999');
  });
});

// ── PR review tool ──────────────────────────────────────────────────────────

describe('createSubmitPrReviewTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('submits a review and returns result', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 42, html_url: 'https://github.com/r/42', state: 'COMMENTED' },
    });

    const tool = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    const result = await tool.invoke({ pull_number: 10, body: 'Looks good!' });
    const parsed = JSON.parse(result);

    expect(parsed.id).toBe(42);
    expect(parsed.state).toBe('COMMENTED');
    expect(parsed.pull_number).toBe(10);

    // Verify event is hardcoded to COMMENT
    const createCall = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(createCall.event).toBe('COMMENT');
    expect(createCall.body).toContain(BOT_REVIEW_MARKER);
  });

  it('skips review when bot review already exists (idempotent)', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [{ id: 1, body: `Some review ${BOT_REVIEW_MARKER}` }],
    });

    const tool = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    const result = await tool.invoke({ pull_number: 10, body: 'New review' });
    const parsed = JSON.parse(result);

    expect(parsed.skipped).toBe(true);
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('includes inline comments when provided', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 50, html_url: 'https://github.com/r/50', state: 'COMMENTED' },
    });

    const tool = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    await tool.invoke({
      pull_number: 10,
      body: 'Review with inline comments',
      comments: [
        { path: 'src/main.ts', line: 5, body: 'Consider renaming this' },
        { path: 'src/utils.ts', line: 12, body: 'Possible null pointer' },
      ],
    });

    const createCall = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(createCall.comments).toHaveLength(2);
    expect(createCall.comments[0].path).toBe('src/main.ts');
    expect(createCall.comments[1].line).toBe(12);
  });

  it('returns error message on API failure', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    octokit.rest.pulls.createReview.mockRejectedValue(new Error('Forbidden'));

    const tool = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    const result = await tool.invoke({ pull_number: 10, body: 'Review' });

    expect(result).toContain('Error');
    expect(result).toContain('10');
  });

  it('posts review when no existing reviews match marker', async () => {
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        { id: 1, body: 'Human review — no marker' },
        { id: 2, body: 'Another human review' },
      ],
    });
    octokit.rest.pulls.createReview.mockResolvedValue({
      data: { id: 60, html_url: 'https://github.com/r/60', state: 'COMMENTED' },
    });

    const tool = createSubmitPrReviewTool(octokit, 'owner', 'repo');
    const result = await tool.invoke({ pull_number: 10, body: 'Bot review' });
    const parsed = JSON.parse(result);

    expect(parsed.id).toBe(60);
    expect(octokit.rest.pulls.createReview).toHaveBeenCalled();
  });
});

// ── Fetch sub-issues tool ─────────────────────────────────────────────────────

describe('createFetchSubIssuesTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns formatted sub-issues', async () => {
    octokit.request.mockResolvedValue({
      data: [
        { id: 1001, number: 10, title: 'Child 1', body: 'desc1', state: 'open', labels: [{ name: 'bug' }] },
        { id: 1002, number: 11, title: 'Child 2', body: null, state: 'open', labels: [] },
      ],
    });

    const tool = createFetchSubIssuesTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ issue_number: 5 }));

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1001);
    expect(result[0].number).toBe(10);
    expect(result[0].title).toBe('Child 1');
    expect(result[0].labels).toEqual(['bug']);
    expect(result[1].body).toBe('(no description)');
  });

  it('returns empty array when no sub-issues', async () => {
    octokit.request.mockResolvedValue({ data: [] });

    const tool = createFetchSubIssuesTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ issue_number: 5 }));

    expect(result).toEqual([]);
  });

  it('returns error string on API failure', async () => {
    octokit.request.mockRejectedValue(new Error('API error'));

    const tool = createFetchSubIssuesTool('owner', 'repo', octokit);
    const result = await tool.invoke({ issue_number: 5 });

    expect(result).toContain('Error fetching sub-issues');
    expect(result).toContain('#5');
  });
});

// ── Get parent issue tool ───────────────────────────────────────────────────

describe('createGetParentIssueTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns parent when issue has one', async () => {
    octokit.request.mockResolvedValue({
      data: { id: 2001, number: 3, title: 'Parent Issue', body: 'parent body', state: 'open', labels: [{ name: 'feature' }] },
    });

    const tool = createGetParentIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ issue_number: 10 }));

    expect(result.parent).not.toBeNull();
    expect(result.parent.id).toBe(2001);
    expect(result.parent.number).toBe(3);
    expect(result.parent.title).toBe('Parent Issue');
    expect(result.parent.labels).toEqual(['feature']);
  });

  it('returns { parent: null } on 404 (no parent)', async () => {
    octokit.request.mockRejectedValue({ status: 404 });

    const tool = createGetParentIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ issue_number: 10 }));

    expect(result.parent).toBeNull();
  });

  it('returns error string on non-404 error', async () => {
    octokit.request.mockRejectedValue(new Error('Server error'));

    const tool = createGetParentIssueTool('owner', 'repo', octokit);
    const result = await tool.invoke({ issue_number: 10 });

    expect(result).toContain('Error fetching parent');
    expect(result).toContain('#10');
  });
});

// ── Create sub-issue tool ───────────────────────────────────────────────────

describe('createCreateSubIssueTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('creates issue and links it as sub-issue', async () => {
    octokit.rest.issues.create.mockResolvedValue({
      data: { id: 3001, number: 20, title: 'New child', html_url: 'https://github.com/owner/repo/issues/20' },
    });
    octokit.request.mockResolvedValue({ data: {} });

    const tool = createCreateSubIssueTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({
      parent_issue_number: 5,
      title: 'New child',
      body: 'Child body',
    }));

    expect(result.id).toBe(3001);
    expect(result.number).toBe(20);
    expect(result.parent_issue_number).toBe(5);

    // Verify issue was created
    expect(octokit.rest.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner', repo: 'repo', title: 'New child', body: 'Child body' }),
    );

    // Verify linking used internal ID (3001), not issue number (20)
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
      expect.objectContaining({ sub_issue_id: 3001, issue_number: 5 }),
    );
  });

  it('handles creation failure', async () => {
    octokit.rest.issues.create.mockRejectedValue(new Error('Forbidden'));

    const tool = createCreateSubIssueTool('owner', 'repo', octokit);
    const result = await tool.invoke({
      parent_issue_number: 5,
      title: 'New child',
      body: 'Body',
    });

    expect(result).toContain('Error creating sub-issue');
    expect(result).toContain('#5');
  });

  it('handles linking failure', async () => {
    octokit.rest.issues.create.mockResolvedValue({
      data: { id: 3002, number: 21, title: 'Child', html_url: 'https://github.com/owner/repo/issues/21' },
    });
    octokit.request.mockRejectedValue(new Error('Link failed'));

    const tool = createCreateSubIssueTool('owner', 'repo', octokit);
    const result = await tool.invoke({
      parent_issue_number: 5,
      title: 'Child',
      body: 'Body',
    });

    expect(result).toContain('Error creating sub-issue');
  });
});

// ── Dry-run create sub-issue tool ───────────────────────────────────────────

describe('createDryRunCreateSubIssueTool', () => {
  it('returns dry_run result without making API calls', async () => {
    const tool = createDryRunCreateSubIssueTool();
    const result = JSON.parse(await tool.invoke({
      parent_issue_number: 5,
      title: 'Test sub-issue',
      body: 'Test body',
    }));

    expect(result.dry_run).toBe(true);
    expect(result.parent_issue_number).toBe(5);
    expect(result.title).toBe('Test sub-issue');
  });

  it('has the same tool name as the real tool', () => {
    const tool = createDryRunCreateSubIssueTool();
    expect(tool.name).toBe('create_sub_issue');
  });
});

// ── Check CI status tool ────────────────────────────────────────────────────

describe('createCheckCiStatusTool', () => {
  let octokit: ReturnType<typeof createMockOctokit>;

  beforeEach(() => {
    octokit = createMockOctokit();
  });

  it('returns success when all checks pass', async () => {
    octokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'abc123' } },
    });
    octokit.rest.checks.listForRef.mockResolvedValue({
      data: {
        check_runs: [
          { name: 'test', status: 'completed', conclusion: 'success', output: { summary: 'All passed' } },
          { name: 'lint', status: 'completed', conclusion: 'success', output: {} },
        ],
      },
    });

    const tool = createCheckCiStatusTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ pull_number: 10 }));

    expect(result.overall).toBe('success');
    expect(result.total).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.checks).toHaveLength(2);
  });

  it('returns failure when one check fails', async () => {
    octokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'abc123' } },
    });
    octokit.rest.checks.listForRef.mockResolvedValue({
      data: {
        check_runs: [
          { name: 'test', status: 'completed', conclusion: 'failure', output: { summary: 'Tests failed' } },
          { name: 'lint', status: 'completed', conclusion: 'success', output: {} },
        ],
      },
    });

    const tool = createCheckCiStatusTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ pull_number: 10 }));

    expect(result.overall).toBe('failure');
    expect(result.failed).toBe(1);
  });

  it('returns in_progress when a check is still running', async () => {
    octokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'abc123' } },
    });
    octokit.rest.checks.listForRef.mockResolvedValue({
      data: {
        check_runs: [
          { name: 'test', status: 'in_progress', conclusion: null, output: {} },
          { name: 'lint', status: 'completed', conclusion: 'success', output: {} },
        ],
      },
    });

    const tool = createCheckCiStatusTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ pull_number: 10 }));

    expect(result.overall).toBe('in_progress');
    expect(result.completed).toBe(1);
    expect(result.total).toBe(2);
  });

  it('returns no_checks when there are no check runs', async () => {
    octokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'abc123' } },
    });
    octokit.rest.checks.listForRef.mockResolvedValue({
      data: { check_runs: [] },
    });

    const tool = createCheckCiStatusTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ pull_number: 10 }));

    expect(result.overall).toBe('no_checks');
    expect(result.total).toBe(0);
  });

  it('returns error string on API failure', async () => {
    octokit.rest.pulls.get.mockRejectedValue(new Error('Not found'));

    const tool = createCheckCiStatusTool('owner', 'repo', octokit);
    const result = await tool.invoke({ pull_number: 999 });

    expect(result).toContain('Error checking CI status');
    expect(result).toContain('999');
  });

  it('treats timed_out conclusion as failure', async () => {
    octokit.rest.pulls.get.mockResolvedValue({
      data: { head: { sha: 'abc123' } },
    });
    octokit.rest.checks.listForRef.mockResolvedValue({
      data: {
        check_runs: [
          { name: 'test', status: 'completed', conclusion: 'timed_out', output: { summary: 'Timed out' } },
        ],
      },
    });

    const tool = createCheckCiStatusTool('owner', 'repo', octokit);
    const result = JSON.parse(await tool.invoke({ pull_number: 10 }));

    expect(result.overall).toBe('failure');
    expect(result.failed).toBe(1);
  });
});

// ── Dry-run check CI status tool ────────────────────────────────────────────

describe('createDryRunCheckCiStatusTool', () => {
  it('returns dry_run result', async () => {
    const tool = createDryRunCheckCiStatusTool();
    const result = JSON.parse(await tool.invoke({ pull_number: 10 }));

    expect(result.dry_run).toBe(true);
    expect(result.overall).toBe('success');
    expect(result.checks).toEqual([]);
  });

  it('has the same tool name as the real tool', () => {
    const tool = createDryRunCheckCiStatusTool();
    expect(tool.name).toBe('check_ci_status');
  });
});
