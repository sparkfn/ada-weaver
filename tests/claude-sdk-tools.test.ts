import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK's createSdkMcpServer before importing the module under test
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: any) => ({
    type: 'sdk',
    name: opts.name,
    instance: { /* mock McpServer */ },
    _tools: opts.tools, // expose for test assertions
  })),
}));

import { createGitHubMcpServer, createContextMcpServer } from '../src/claude-sdk-tools.js';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// ── Mock octokit ─────────────────────────────────────────────────────────────

function createMockOctokit() {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            { number: 1, title: 'Test issue', body: 'Body text', state: 'open', created_at: '2024-01-01', updated_at: '2024-01-01', html_url: 'https://github.com/o/r/issues/1', labels: [{ name: 'bug' }] },
          ],
        }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({
          data: { id: 100, html_url: 'https://github.com/o/r/issues/1#comment-100', created_at: '2024-01-01' },
        }),
        create: vi.fn().mockResolvedValue({
          data: { id: 500, number: 5, title: 'Sub-issue', html_url: 'https://github.com/o/r/issues/5' },
        }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({
          data: { number: 10, html_url: 'https://github.com/o/r/pull/10', state: 'open' },
        }),
        get: vi.fn().mockResolvedValue({
          data: 'diff --git a/file.ts b/file.ts\n+added line' as unknown,
        }),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        createReview: vi.fn().mockResolvedValue({
          data: { id: 200, html_url: 'https://github.com/o/r/pull/10#review-200', state: 'COMMENTED' },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: { check_runs: [] },
        }),
      },
    },
    request: vi.fn().mockResolvedValue({ data: [] }),
  } as any;
}

// ── Mock context repo ────────────────────────────────────────────────────────

function createMockContextRepo() {
  return {
    addEntry: vi.fn().mockResolvedValue({ id: 1 }),
    getEntriesForProcess: vi.fn().mockResolvedValue([]),
    searchByFiles: vi.fn().mockResolvedValue([]),
    searchRecent: vi.fn().mockResolvedValue([]),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createGitHubMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an MCP server with name "github"', () => {
    const octokit = createMockOctokit();
    const server = createGitHubMcpServer('owner', 'repo', octokit);

    expect(createSdkMcpServer).toHaveBeenCalledTimes(1);
    expect(server.name).toBe('github');
    expect(server.type).toBe('sdk');
  });

  it('registers all expected GitHub tools', () => {
    const octokit = createMockOctokit();
    createGitHubMcpServer('owner', 'repo', octokit);

    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const toolNames = call.tools!.map((t: any) => t.name);

    expect(toolNames).toContain('fetch_github_issues');
    expect(toolNames).toContain('comment_on_issue');
    expect(toolNames).toContain('create_pull_request');
    expect(toolNames).toContain('get_pr_diff');
    expect(toolNames).toContain('submit_pr_review');
    expect(toolNames).toContain('check_ci_status');
    expect(toolNames).toContain('fetch_sub_issues');
    expect(toolNames).toContain('get_parent_issue');
    expect(toolNames).toContain('create_sub_issue');
  });

  it('fetch_github_issues handler returns formatted issues', async () => {
    const octokit = createMockOctokit();
    createGitHubMcpServer('owner', 'repo', octokit);

    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const fetchTool = call.tools!.find((t: any) => t.name === 'fetch_github_issues')!;

    const result = await fetchTool.handler({ state: 'open', limit: 5 }, null);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].number).toBe(1);
    expect(data[0].title).toBe('Test issue');
  });

  it('comment_on_issue skips when comment already exists', async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ body: '<!-- deep-agent-analysis -->\nSome analysis' }],
    });

    createGitHubMcpServer('owner', 'repo', octokit);
    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const commentTool = call.tools!.find((t: any) => t.name === 'comment_on_issue')!;

    const result = await commentTool.handler({ issue_number: 1, body: 'test' }, null);
    const data = JSON.parse(result.content[0].text);
    expect(data.skipped).toBe(true);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('dry-run mode returns dry_run result for write tools', async () => {
    const octokit = createMockOctokit();
    createGitHubMcpServer('owner', 'repo', octokit, { dryRun: true });

    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const commentTool = call.tools!.find((t: any) => t.name === 'comment_on_issue')!;
    const prTool = call.tools!.find((t: any) => t.name === 'create_pull_request')!;

    const commentResult = await commentTool.handler({ issue_number: 1, body: 'test' }, null);
    const commentData = JSON.parse(commentResult.content[0].text);
    expect(commentData.dry_run).toBe(true);

    const prResult = await prTool.handler({ title: 'Fix', body: 'Fix', head: 'br' }, null);
    const prData = JSON.parse(prResult.content[0].text);
    expect(prData.dry_run).toBe(true);

    // Read-only tools should still work in dry-run
    const fetchTool = call.tools!.find((t: any) => t.name === 'fetch_github_issues')!;
    const fetchResult = await fetchTool.handler({}, null);
    const fetchData = JSON.parse(fetchResult.content[0].text);
    expect(fetchData).toHaveLength(1);
  });

  it('create_pull_request skips when open PR exists', async () => {
    const octokit = createMockOctokit();
    octokit.rest.pulls.list.mockResolvedValue({
      data: [{ number: 42, html_url: 'https://github.com/o/r/pull/42' }],
    });

    createGitHubMcpServer('owner', 'repo', octokit);
    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const prTool = call.tools!.find((t: any) => t.name === 'create_pull_request')!;

    const result = await prTool.handler({ title: 'Fix', body: 'Body', head: 'branch-1' }, null);
    const data = JSON.parse(result.content[0].text);
    expect(data.skipped).toBe(true);
    expect(data.number).toBe(42);
  });

  it('get_parent_issue returns null when no parent', async () => {
    const octokit = createMockOctokit();
    octokit.request.mockRejectedValue({ status: 404 });

    createGitHubMcpServer('owner', 'repo', octokit);
    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const parentTool = call.tools!.find((t: any) => t.name === 'get_parent_issue')!;

    const result = await parentTool.handler({ issue_number: 1 }, null);
    const data = JSON.parse(result.content[0].text);
    expect(data.parent).toBeNull();
  });
});

describe('createContextMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an MCP server with name "context"', () => {
    const repo = createMockContextRepo();
    const server = createContextMcpServer(repo, 1, 42, 'proc-1', 'test-agent');

    expect(createSdkMcpServer).toHaveBeenCalledTimes(1);
    expect(server.name).toBe('context');
  });

  it('registers all expected context tools', () => {
    const repo = createMockContextRepo();
    createContextMcpServer(repo, 1, 42, 'proc-1', 'test-agent');

    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const toolNames = call.tools!.map((t: any) => t.name);

    expect(toolNames).toContain('save_issue_context');
    expect(toolNames).toContain('get_issue_context');
    expect(toolNames).toContain('search_past_issues');
  });

  it('save_issue_context handler calls contextRepo.addEntry', async () => {
    const repo = createMockContextRepo();
    createContextMcpServer(repo, 1, 42, 'proc-1', 'test-agent');

    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const saveTool = call.tools!.find((t: any) => t.name === 'save_issue_context')!;

    const result = await saveTool.handler({
      entry_type: 'issuer_brief',
      content: 'Test brief',
      files_touched: ['src/index.ts'],
    }, null);
    const data = JSON.parse(result.content[0].text);
    expect(data.saved).toBe(true);
    expect(repo.addEntry).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 1,
      issueNumber: 42,
      processId: 'proc-1',
      entryType: 'issuer_brief',
      agent: 'test-agent',
      content: 'Test brief',
    }));
  });

  it('get_issue_context returns empty when no process ID', async () => {
    const repo = createMockContextRepo();
    createContextMcpServer(repo, 1, 42, null, 'test-agent');

    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const getTool = call.tools!.find((t: any) => t.name === 'get_issue_context')!;

    const result = await getTool.handler({}, null);
    const data = JSON.parse(result.content[0].text);
    expect(data.entries).toEqual([]);
  });

  it('search_past_issues returns empty message when no results', async () => {
    const repo = createMockContextRepo();
    createContextMcpServer(repo, 1, 42, 'proc-1', 'test-agent');

    const call = vi.mocked(createSdkMcpServer).mock.calls[0][0];
    const searchTool = call.tools!.find((t: any) => t.name === 'search_past_issues')!;

    const result = await searchTool.handler({}, null);
    const data = JSON.parse(result.content[0].text);
    expect(data.past_issues).toEqual([]);
    expect(data.message).toBe('No past issues found.');
  });
});
