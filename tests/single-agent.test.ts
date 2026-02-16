import { describe, it, expect } from 'vitest';
import { buildSingleAgentSystemPrompt, buildSingleAgentTools } from '../src/single-agent.js';
import { ToolCache } from '../src/tool-cache.js';
import { tool } from 'langchain';
import { z } from 'zod';

const TEST_WORKSPACE = { path: '/tmp/test-workspace', cleanup: async () => {} };

// ── buildSingleAgentSystemPrompt ─────────────────────────────────────────────

describe('buildSingleAgentSystemPrompt', () => {
  it('contains owner/repo', () => {
    const prompt = buildSingleAgentSystemPrompt('test-owner', 'test-repo', 'claude-sonnet-4-20250514', 3);
    expect(prompt).toContain('test-owner/test-repo');
  });

  it('contains the model name', () => {
    const prompt = buildSingleAgentSystemPrompt('o', 'r', 'claude-sonnet-4-20250514', 3);
    expect(prompt).toContain('claude-sonnet-4-20250514');
  });

  it('includes all 5 phases', () => {
    const prompt = buildSingleAgentSystemPrompt('o', 'r', 'model', 3);
    expect(prompt).toContain('PHASE 1: ISSUE ANALYSIS');
    expect(prompt).toContain('PHASE 2: PLANNING');
    expect(prompt).toContain('PHASE 3: IMPLEMENTATION');
    expect(prompt).toContain('PHASE 4: SELF-REVIEW');
    expect(prompt).toContain('PHASE 5: FIX ITERATION');
  });

  it('includes max iterations', () => {
    const prompt = buildSingleAgentSystemPrompt('o', 'r', 'model', 5);
    expect(prompt).toContain('5');
  });

  it('mentions key tool names', () => {
    const prompt = buildSingleAgentSystemPrompt('o', 'r', 'model', 3);
    expect(prompt).toContain('fetch_github_issues');
    expect(prompt).toContain('edit_file');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('get_pr_diff');
    expect(prompt).toContain('submit_pr_review');
    expect(prompt).toContain('comment_on_issue');
    expect(prompt).toContain('create_pull_request');
  });

  it('mentions CONTINUE MODE', () => {
    const prompt = buildSingleAgentSystemPrompt('o', 'r', 'model', 3);
    expect(prompt).toContain('CONTINUE MODE');
  });

  it('mentions CONSTRAINTS', () => {
    const prompt = buildSingleAgentSystemPrompt('o', 'r', 'model', 3);
    expect(prompt).toContain('CONSTRAINTS');
    expect(prompt).toContain('Never merge PRs');
    expect(prompt).toContain('COMMENT reviews only');
  });

  it('mentions shared context tools', () => {
    const prompt = buildSingleAgentSystemPrompt('o', 'r', 'model', 3);
    expect(prompt).toContain('save_issue_context');
    expect(prompt).toContain('get_issue_context');
    expect(prompt).toContain('search_past_issues');
  });
});

// ── buildSingleAgentTools ────────────────────────────────────────────────────

describe('buildSingleAgentTools', () => {
  const mockOctokit = {} as any;

  it('returns 15 tools (no context tools)', () => {
    const tools = buildSingleAgentTools('o', 'r', mockOctokit, TEST_WORKSPACE, {});
    expect(tools).toHaveLength(15);
  });

  it('has no duplicate tool names', () => {
    const tools = buildSingleAgentTools('o', 'r', mockOctokit, TEST_WORKSPACE, {});
    const names = tools.map((t: any) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('returns 15 tools in dry-run mode', () => {
    const tools = buildSingleAgentTools('o', 'r', mockOctokit, TEST_WORKSPACE, { dryRun: true });
    expect(tools).toHaveLength(15);
  });

  it('dry-run tools have the same names as normal tools', () => {
    const normalTools = buildSingleAgentTools('o', 'r', mockOctokit, TEST_WORKSPACE, { dryRun: false });
    const dryRunTools = buildSingleAgentTools('o', 'r', mockOctokit, TEST_WORKSPACE, { dryRun: true });
    const normalNames = normalTools.map((t: any) => t.name).sort();
    const dryRunNames = dryRunTools.map((t: any) => t.name).sort();
    expect(normalNames).toEqual(dryRunNames);
  });

  it('includes all expected tool names', () => {
    const tools = buildSingleAgentTools('o', 'r', mockOctokit, TEST_WORKSPACE, {});
    const names = tools.map((t: any) => t.name);
    // Read-only
    expect(names).toContain('fetch_github_issues');
    expect(names).toContain('list_files');
    expect(names).toContain('read_file');
    expect(names).toContain('grep');
    // Issue graph
    expect(names).toContain('fetch_sub_issues');
    expect(names).toContain('get_parent_issue');
    // Write
    expect(names).toContain('comment_on_issue');
    expect(names).toContain('edit_file');
    expect(names).toContain('write_file');
    expect(names).toContain('bash');
    expect(names).toContain('create_pull_request');
    expect(names).toContain('create_sub_issue');
    // Review
    expect(names).toContain('get_pr_diff');
    expect(names).toContain('submit_pr_review');
    // CI
    expect(names).toContain('check_ci_status');
  });

  it('includes context tools when provided', () => {
    const fakeContextTool = tool(
      async () => 'ok',
      { name: 'fake_context', description: 'test', schema: z.object({}) },
    );
    const tools = buildSingleAgentTools('o', 'r', mockOctokit, TEST_WORKSPACE, {
      contextTools: [fakeContextTool],
    });
    expect(tools).toHaveLength(16); // 15 + 1 context tool
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('fake_context');
  });

  it('accepts a cache for diff delta computation', () => {
    const cache = new ToolCache();
    const tools = buildSingleAgentTools('o', 'r', mockOctokit, TEST_WORKSPACE, { cache });
    expect(tools).toHaveLength(15);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('get_pr_diff');
  });
});
