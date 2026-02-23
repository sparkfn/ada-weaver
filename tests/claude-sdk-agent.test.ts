import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────────

// Mock the SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn((opts: any) => ({
    type: 'sdk',
    name: opts.name,
    instance: {},
    _tools: opts.tools,
  })),
}));

// Mock workspace
vi.mock('../src/workspace.js', () => ({
  resolveGitToken: vi.fn().mockResolvedValue('ghp_mock_token'),
  createWorkspace: vi.fn().mockResolvedValue({
    path: '/tmp/mock-workspace',
    cleanup: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock github-tools
vi.mock('../src/github-tools.js', () => ({
  getAuthFromConfig: vi.fn().mockReturnValue('ghp_test'),
  createGitHubClient: vi.fn().mockReturnValue({
    rest: {
      issues: { createComment: vi.fn().mockResolvedValue({ data: {} }) },
    },
  }),
}));

// Mock core
vi.mock('../src/core.js', () => ({
  findAllPrsForIssue: vi.fn().mockResolvedValue([]),
}));

// Mock architect exports
vi.mock('../src/architect.js', async () => {
  const actual = await vi.importActual('../src/architect.js') as any;
  return {
    ...actual,
    formatUsageSummaryComment: vi.fn().mockResolvedValue(null),
  };
});

// Mock single-agent (for buildSingleAgentSystemPrompt import)
vi.mock('../src/single-agent.js', () => ({
  buildSingleAgentSystemPrompt: vi.fn().mockReturnValue('You are a single agent for test-owner/test-repo.'),
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  formatDuration: vi.fn((ms: number) => `${(ms / 1000).toFixed(1)}s`),
  logAgentEvent: vi.fn(),
  logAgentDetail: vi.fn(),
  logDiff: vi.fn(),
}));

import {
  adaptPromptForSdk,
  mapToSdkModel,
  detectPhaseFromToolCalls,
  runClaudeSdkAgent,
} from '../src/claude-sdk-agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

// ── Utility: create a mock SDK conversation ──────────────────────────────────

function createMockConversation(messages: any[]) {
  const iter = messages[Symbol.iterator]();
  const generator = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      const { value, done } = iter.next();
      return done ? { value: undefined, done: true } : { value, done: false };
    },
    async return() { return { value: undefined, done: true as const }; },
    async throw(e: any) { throw e; },
    close: vi.fn(),
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
    initializationResult: vi.fn(),
    supportedCommands: vi.fn(),
    supportedModels: vi.fn(),
    mcpServerStatus: vi.fn(),
    accountInfo: vi.fn(),
    rewindFiles: vi.fn(),
    reconnectMcpServer: vi.fn(),
    toggleMcpServer: vi.fn(),
    setMcpServers: vi.fn(),
    streamInput: vi.fn(),
    stopTask: vi.fn(),
  };
  return generator;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('adaptPromptForSdk', () => {
  it('replaces local tool names with SDK equivalents', () => {
    const prompt = 'Use read_file to read files, list_files to explore, and grep to search.';
    const result = adaptPromptForSdk(prompt);

    expect(result).toContain('Read');
    expect(result).toContain('Glob');
    expect(result).toContain('Grep');
    expect(result).not.toContain('read_file');
    expect(result).not.toContain('list_files');
  });

  it('replaces GitHub tool names with MCP-prefixed equivalents', () => {
    const prompt = 'Use fetch_github_issues to read issues and comment_on_issue to post.';
    const result = adaptPromptForSdk(prompt);

    expect(result).toContain('mcp__github__fetch_github_issues');
    expect(result).toContain('mcp__github__comment_on_issue');
  });

  it('replaces context tool names with MCP-prefixed equivalents', () => {
    const prompt = 'Save with save_issue_context, read with get_issue_context.';
    const result = adaptPromptForSdk(prompt);

    expect(result).toContain('mcp__context__save_issue_context');
    expect(result).toContain('mcp__context__get_issue_context');
  });

  it('replaces write tools correctly', () => {
    const prompt = 'Use edit_file for edits, write_file for new files, bash for commands.';
    const result = adaptPromptForSdk(prompt);

    expect(result).toContain('Edit');
    expect(result).toContain('Write');
    expect(result).toContain('Bash');
  });
});

describe('mapToSdkModel', () => {
  const baseConfig = {
    github: { owner: 'o', repo: 'r', token: 't' },
    llm: { provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-20250514' },
    agentMode: 'claude-sdk' as const,
    claudeSdk: { maxTurns: 200, multi: true, permissionMode: 'bypassPermissions' as const },
  } as any;

  it('returns "inherit" when no override is set', () => {
    expect(mapToSdkModel(baseConfig, 'issuer')).toBe('inherit');
    expect(mapToSdkModel(baseConfig, 'coder')).toBe('inherit');
    expect(mapToSdkModel(baseConfig, 'reviewer')).toBe('inherit');
  });

  it('returns "haiku" when model contains haiku', () => {
    const config = { ...baseConfig, issuerLlm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } };
    expect(mapToSdkModel(config, 'issuer')).toBe('haiku');
  });

  it('returns "opus" when model contains opus', () => {
    const config = { ...baseConfig, coderLlm: { provider: 'anthropic', model: 'claude-opus-4-20250514' } };
    expect(mapToSdkModel(config, 'coder')).toBe('opus');
  });

  it('returns "sonnet" when model contains sonnet', () => {
    const config = { ...baseConfig, reviewerLlm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' } };
    expect(mapToSdkModel(config, 'reviewer')).toBe('sonnet');
  });

  it('returns "inherit" for unrecognized model names', () => {
    const config = { ...baseConfig, issuerLlm: { provider: 'anthropic', model: 'custom-model-v1' } };
    expect(mapToSdkModel(config, 'issuer')).toBe('inherit');
  });
});

describe('detectPhaseFromToolCalls', () => {
  it('detects analysis phase from GitHub issue tools', () => {
    expect(detectPhaseFromToolCalls(['mcp__github__fetch_github_issues'])).toBe('analysis');
    expect(detectPhaseFromToolCalls(['mcp__github__fetch_sub_issues'])).toBe('analysis');
    expect(detectPhaseFromToolCalls(['mcp__github__get_parent_issue'])).toBe('analysis');
  });

  it('detects coding phase from edit/write/bash tools', () => {
    expect(detectPhaseFromToolCalls(['Edit'])).toBe('coding');
    expect(detectPhaseFromToolCalls(['Write'])).toBe('coding');
    expect(detectPhaseFromToolCalls(['Bash'])).toBe('coding');
  });

  it('detects review phase from PR review tools', () => {
    expect(detectPhaseFromToolCalls(['mcp__github__get_pr_diff'])).toBe('review');
    expect(detectPhaseFromToolCalls(['mcp__github__submit_pr_review'])).toBe('review');
  });

  it('detects pr-creation phase', () => {
    expect(detectPhaseFromToolCalls(['mcp__github__create_pull_request'])).toBe('pr-creation');
  });

  it('detects ci-check phase', () => {
    expect(detectPhaseFromToolCalls(['mcp__github__check_ci_status'])).toBe('ci-check');
  });

  it('returns null for read-only tools', () => {
    expect(detectPhaseFromToolCalls(['Read', 'Glob', 'Grep'])).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(detectPhaseFromToolCalls([])).toBeNull();
  });

  it('prioritizes first matching phase', () => {
    // analysis comes before coding in the check order
    expect(detectPhaseFromToolCalls(['mcp__github__fetch_github_issues', 'Edit'])).toBe('analysis');
  });
});

describe('runClaudeSdkAgent', () => {
  const validConfig = {
    github: { owner: 'test-owner', repo: 'test-repo', token: 'ghp_test' },
    llm: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' },
    agentMode: 'claude-sdk' as const,
    claudeSdk: {
      maxTurns: 200,
      maxBudgetUsd: undefined,
      permissionMode: 'bypassPermissions' as const,
      model: undefined,
      multi: false,  // single agent mode
    },
    maxIterations: 3,
  } as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-setup workspace mock return values after clearAllMocks
    const { createWorkspace } = await import('../src/workspace.js');
    vi.mocked(createWorkspace).mockResolvedValue({
      path: '/tmp/mock-workspace',
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns ArchitectResult with outcome from SDK result', async () => {
    const mockConversation = createMockConversation([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session',
        model: 'claude-sonnet-4-20250514',
        tools: ['Read', 'Edit'],
        mcp_servers: [],
        uuid: '00000000-0000-0000-0000-000000000001',
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Successfully processed issue #1.',
        duration_ms: 5000,
        duration_api_ms: 4000,
        is_error: false,
        num_turns: 5,
        total_cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-0000-0000-000000000002',
        session_id: 'test-session',
      },
    ]);

    vi.mocked(query).mockReturnValue(mockConversation as any);

    const result = await runClaudeSdkAgent(validConfig, 1);

    expect(result.issueNumber).toBe(1);
    expect(result.outcome).toBe('Successfully processed issue #1.');
  });

  it('captures last assistant response when result has no text', async () => {
    const mockConversation = createMockConversation([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        mcp_servers: [],
        uuid: '00000000-0000-0000-0000-000000000001',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Analyzing issue...' }],
        },
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-000000000003',
        session_id: 'test-session',
      },
      {
        type: 'result',
        subtype: 'success',
        result: '',
        duration_ms: 3000,
        duration_api_ms: 2000,
        is_error: false,
        num_turns: 3,
        total_cost_usd: 0.02,
        usage: { input_tokens: 500, output_tokens: 200 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-0000-0000-000000000002',
        session_id: 'test-session',
      },
    ]);

    vi.mocked(query).mockReturnValue(mockConversation as any);

    const result = await runClaudeSdkAgent(validConfig, 1);

    // Should capture the assistant message when result is empty
    expect(result.outcome).toBe('Analyzing issue...');
  });

  it('routes to multi-agent when config.claudeSdk.multi is true', async () => {
    const multiConfig = {
      ...validConfig,
      claudeSdk: { ...validConfig.claudeSdk, multi: true },
    };

    const mockConversation = createMockConversation([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        mcp_servers: [],
        uuid: '00000000-0000-0000-0000-000000000001',
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Multi-agent completed.',
        duration_ms: 10000,
        duration_api_ms: 8000,
        is_error: false,
        num_turns: 10,
        total_cost_usd: 0.10,
        usage: { input_tokens: 2000, output_tokens: 1000 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-0000-0000-000000000002',
        session_id: 'test-session',
      },
    ]);

    vi.mocked(query).mockReturnValue(mockConversation as any);

    const result = await runClaudeSdkAgent(multiConfig, 1);

    expect(result.outcome).toBe('Multi-agent completed.');
    // Verify query was called with agents option
    const queryCall = vi.mocked(query).mock.calls[0][0];
    expect(queryCall.options?.agents).toBeDefined();
    expect(queryCall.options?.agents).toHaveProperty('issuer');
    expect(queryCall.options?.agents).toHaveProperty('coder');
    expect(queryCall.options?.agents).toHaveProperty('reviewer');
  });

  it('handles error results gracefully', async () => {
    const mockConversation = createMockConversation([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        mcp_servers: [],
        uuid: '00000000-0000-0000-0000-000000000001',
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        duration_ms: 60000,
        duration_api_ms: 55000,
        is_error: true,
        num_turns: 200,
        total_cost_usd: 1.00,
        usage: { input_tokens: 50000, output_tokens: 20000 },
        modelUsage: {},
        permission_denials: [],
        errors: ['Max turns exceeded'],
        uuid: '00000000-0000-0000-0000-000000000002',
        session_id: 'test-session',
      },
    ]);

    vi.mocked(query).mockReturnValue(mockConversation as any);

    const result = await runClaudeSdkAgent(validConfig, 1);

    // Should still return a result, just with default outcome
    expect(result.issueNumber).toBe(1);
    expect(result.outcome).toContain('No response');
  });

  it('passes correct SDK options for single-agent mode', async () => {
    const mockConversation = createMockConversation([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        mcp_servers: [],
        uuid: '00000000-0000-0000-0000-000000000001',
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done.',
        duration_ms: 1000,
        duration_api_ms: 800,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-0000-0000-000000000002',
        session_id: 'test-session',
      },
    ]);

    vi.mocked(query).mockReturnValue(mockConversation as any);

    await runClaudeSdkAgent(validConfig, 1);

    const queryCall = vi.mocked(query).mock.calls[0][0];
    expect(queryCall.options?.cwd).toBe('/tmp/mock-workspace');
    expect(queryCall.options?.permissionMode).toBe('bypassPermissions');
    expect(queryCall.options?.allowDangerouslySkipPermissions).toBe(true);
    expect(queryCall.options?.maxTurns).toBe(200);
    expect(queryCall.options?.tools).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']));
    expect(queryCall.options?.mcpServers).toBeDefined();
    expect(queryCall.options?.persistSession).toBe(false);
  });
});
