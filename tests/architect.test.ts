import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildArchitectSystemPrompt,
  createIssuerSubagent,
  createCoderSubagent,
  createReviewerSubagent,
  getMaxIterations,
  extractTaskInput,
  extractTextContent,
  extractSubagentResponse,
  formatUsageSummaryComment,
} from '../src/architect.js';
import { UsageService } from '../src/usage-service.js';
import { ToolCache } from '../src/tool-cache.js';

const TEST_WORKSPACE = '/tmp/test-workspace';

// ── buildArchitectSystemPrompt ──────────────────────────────────────────────

describe('buildArchitectSystemPrompt', () => {
  it('contains owner/repo', () => {
    const prompt = buildArchitectSystemPrompt('test-owner', 'test-repo', 3);
    expect(prompt).toContain('test-owner/test-repo');
  });

  it('mentions issuer, coder, reviewer subagents', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('issuer');
    expect(prompt).toContain('coder');
    expect(prompt).toContain('reviewer');
  });

  it('includes max iterations', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 5);
    expect(prompt).toContain('5');
  });

  it('describes the standard workflow', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('STANDARD WORKFLOW');
    expect(prompt).toContain('Delegate to issuer');
    expect(prompt).toContain('Delegate to coder');
    expect(prompt).toContain('Delegate to reviewer');
  });

  it('mentions local verification tools', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('fetch_github_issues');
    expect(prompt).toContain('list_files');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('grep');
  });

  it('mentions check_ci_status in available tools', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('check_ci_status');
  });

  it('describes CI checking in the workflow', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('check CI');
    expect(prompt).toContain('in_progress');
    expect(prompt).toContain('failure');
  });

  it('contains PARALLEL EXECUTION restrictions', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('PARALLEL EXECUTION');
    expect(prompt).toContain('Do NOT use parallel delegation unless');
  });

  it('contains single-issue guardrails', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('Only ONE coder delegation per issue');
    expect(prompt).toContain('ALWAYS include the exact issue number');
  });

  it('mentions local filesystem access', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('local filesystem access');
  });
});

// ── createIssuerSubagent ────────────────────────────────────────────────────

describe('createIssuerSubagent', () => {
  const mockOctokit = {} as any;

  it('returns SubAgent with name "issuer"', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.name).toBe('issuer');
  });

  it('has 7 tools (list, read, grep, issues, sub-issues, parent, comment)', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.tools).toHaveLength(7);
  });

  it('has 7 tools in dry-run mode', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { dryRun: true, workspacePath: TEST_WORKSPACE });
    expect(subagent.tools).toHaveLength(7);
  });

  it('system prompt contains owner/repo', () => {
    const subagent = createIssuerSubagent('test-owner', 'test-repo', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.systemPrompt).toContain('test-owner/test-repo');
  });

  it('has a description', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.description).toBeTruthy();
    expect(subagent.description).toContain('issue');
  });

  it('does not include model when not provided', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.model).toBeUndefined();
  });

  it('includes model when provided', () => {
    const mockModel = { invoke: vi.fn() } as any;
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { model: mockModel, workspacePath: TEST_WORKSPACE });
    expect(subagent.model).toBe(mockModel);
  });

  it('system prompt mentions comment_on_issue', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.systemPrompt).toContain('comment_on_issue');
  });

  it('system prompt includes issue comment format template', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.systemPrompt).toContain('Issue Analysis');
    expect(subagent.systemPrompt).toContain('Recommended Approach');
    expect(subagent.systemPrompt).toContain('Automated analysis by Deep Agents');
  });

  it('system prompt mentions local tools: list_files, read_file, grep', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.systemPrompt).toContain('list_files');
    expect(subagent.systemPrompt).toContain('read_file');
    expect(subagent.systemPrompt).toContain('grep');
  });

  it('includes tool names: list_files, read_file, grep', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    const toolNames = subagent.tools!.map((t: any) => t.name);
    expect(toolNames).toContain('list_files');
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('grep');
  });
});

// ── createCoderSubagent ─────────────────────────────────────────────────────

describe('createCoderSubagent', () => {
  const mockOctokit = {} as any;

  it('returns SubAgent with name "coder"', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.name).toBe('coder');
  });

  it('has 9 tools in normal mode', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.tools).toHaveLength(9);
  });

  it('has 9 tools in dry-run mode', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { dryRun: true, workspacePath: TEST_WORKSPACE });
    expect(subagent.tools).toHaveLength(9);
  });

  it('system prompt contains owner/repo', () => {
    const subagent = createCoderSubagent('test-owner', 'test-repo', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.systemPrompt).toContain('test-owner/test-repo');
  });

  it('does not include model when not provided', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.model).toBeUndefined();
  });

  it('includes model when provided', () => {
    const mockModel = { invoke: vi.fn() } as any;
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { model: mockModel, workspacePath: TEST_WORKSPACE });
    expect(subagent.model).toBe(mockModel);
  });

  it('has a description', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.description).toBeTruthy();
    expect(subagent.description).toContain('code');
  });

  it('system prompt includes TESTING GUIDELINES', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.systemPrompt).toContain('TESTING GUIDELINES');
    expect(subagent.systemPrompt).toContain('happy path');
  });

  it('uses dry-run tools when dryRun is true', () => {
    const normalAgent = createCoderSubagent('o', 'r', mockOctokit, { dryRun: false, workspacePath: TEST_WORKSPACE });
    const dryRunAgent = createCoderSubagent('o', 'r', mockOctokit, { dryRun: true, workspacePath: TEST_WORKSPACE });

    // Both should have the same number of tools
    expect(normalAgent.tools!.length).toBe(dryRunAgent.tools!.length);

    // Tool names should be the same (dry-run tools have same names)
    const normalNames = normalAgent.tools!.map((t: any) => t.name).sort();
    const dryRunNames = dryRunAgent.tools!.map((t: any) => t.name).sort();
    expect(normalNames).toEqual(dryRunNames);
  });

  it('includes local tools: list_files, read_file, grep, edit_file, write_file, bash', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    const toolNames = subagent.tools!.map((t: any) => t.name);
    expect(toolNames).toContain('list_files');
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('edit_file');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('bash');
  });

  it('includes GitHub API tools: create_pull_request, comment_on_issue, create_sub_issue', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    const toolNames = subagent.tools!.map((t: any) => t.name);
    expect(toolNames).toContain('create_pull_request');
    expect(toolNames).toContain('comment_on_issue');
    expect(toolNames).toContain('create_sub_issue');
  });

  it('system prompt mentions git workflow via bash', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.systemPrompt).toContain('git checkout -b');
    expect(subagent.systemPrompt).toContain('git push origin HEAD');
  });
});

// ── createReviewerSubagent ──────────────────────────────────────────────────

describe('createReviewerSubagent', () => {
  const mockOctokit = {} as any;

  it('returns SubAgent with name "reviewer"', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE });
    expect(subagent.name).toBe('reviewer');
  });

  it('has 5 tools (diff, list, read, grep, submit_pr_review)', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE });
    expect(subagent.tools).toHaveLength(5);
  });

  it('system prompt contains owner/repo (from buildReviewerSystemPrompt)', () => {
    const subagent = createReviewerSubagent('test-owner', 'test-repo', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE });
    expect(subagent.systemPrompt).toContain('test-owner/test-repo');
  });

  it('does not include model when not provided', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE });
    expect(subagent.model).toBeUndefined();
  });

  it('includes model when provided', () => {
    const mockModel = { invoke: vi.fn() } as any;
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, mockModel, { workspacePath: TEST_WORKSPACE });
    expect(subagent.model).toBe(mockModel);
  });

  it('has a description mentioning reviews', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE });
    expect(subagent.description).toContain('review');
  });

  it('includes local tools: list_files, read_file, grep', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE });
    const toolNames = subagent.tools!.map((t: any) => t.name);
    expect(toolNames).toContain('list_files');
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('grep');
  });

  it('accepts cache for diff delta computation', () => {
    const cache = new ToolCache();
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE, cache });
    expect(subagent.name).toBe('reviewer');
    expect(subagent.tools).toHaveLength(5);
  });
});

// ── getMaxIterations ────────────────────────────────────────────────────────

describe('getMaxIterations', () => {
  it('returns config value when it is a valid positive number', () => {
    expect(getMaxIterations({ maxIterations: 5 } as any)).toBe(5);
  });

  it('returns config value of 1 (minimum valid)', () => {
    expect(getMaxIterations({ maxIterations: 1 } as any)).toBe(1);
  });

  it('returns default (3) when config value is missing', () => {
    expect(getMaxIterations({} as any)).toBe(3);
  });

  it('returns default when config value is zero', () => {
    expect(getMaxIterations({ maxIterations: 0 } as any)).toBe(3);
  });

  it('returns default when config value is negative', () => {
    expect(getMaxIterations({ maxIterations: -1 } as any)).toBe(3);
  });

  it('returns default when config value is a string', () => {
    expect(getMaxIterations({ maxIterations: 'lots' } as any)).toBe(3);
  });

  it('returns default when config value is null', () => {
    expect(getMaxIterations({ maxIterations: null } as any)).toBe(3);
  });

  it('returns default when config value is undefined', () => {
    expect(getMaxIterations({ maxIterations: undefined } as any)).toBe(3);
  });
});

// ── extractTaskInput ──────────────────────────────────────────────────────

describe('extractTaskInput', () => {
  it('extracts from direct object at data.input', () => {
    const result = extractTaskInput({ input: { subagent_type: 'coder', description: 'fix it' } });
    expect(result).toEqual({ subagentType: 'coder', description: 'fix it', prompt: '' });
  });

  it('extracts from direct object with prompt', () => {
    const result = extractTaskInput({ input: { subagent_type: 'coder', description: 'fix it', prompt: 'Modify src/app.ts to add validation' } });
    expect(result).toEqual({ subagentType: 'coder', description: 'fix it', prompt: 'Modify src/app.ts to add validation' });
  });

  it('extracts from JSON string at data.input', () => {
    const result = extractTaskInput({ input: '{"subagent_type":"issuer","description":"analyze"}' });
    expect(result).toEqual({ subagentType: 'issuer', description: 'analyze', prompt: '' });
  });

  it('extracts from nested args: data.input.args', () => {
    const result = extractTaskInput({ input: { args: { subagent_type: 'reviewer', description: 'review PR' } } });
    expect(result).toEqual({ subagentType: 'reviewer', description: 'review PR', prompt: '' });
  });

  it('extracts from double-nested: data.input.input (object)', () => {
    const result = extractTaskInput({ input: { input: { subagent_type: 'coder', description: 'impl' } } });
    expect(result).toEqual({ subagentType: 'coder', description: 'impl', prompt: '' });
  });

  it('extracts from double-nested: data.input.input (JSON string) — LangGraph actual format', () => {
    // This is the actual format from LangGraph's streamEvents v2:
    // handleToolStart stringifies args, BaseTracer wraps as { input: str }
    const result = extractTaskInput({
      input: { input: '{"subagent_type":"coder","description":"implement the fix"}' },
    });
    expect(result).toEqual({ subagentType: 'coder', description: 'implement the fix', prompt: '' });
  });

  it('extracts prompt from JSON string format', () => {
    const result = extractTaskInput({
      input: { input: '{"subagent_type":"coder","description":"fix","prompt":"Update the handler"}' },
    });
    expect(result).toEqual({ subagentType: 'coder', description: 'fix', prompt: 'Update the handler' });
  });

  it('extracts from nested args as JSON string: data.input.args', () => {
    const result = extractTaskInput({
      input: { args: '{"subagent_type":"reviewer","description":"check PR"}' },
    });
    expect(result).toEqual({ subagentType: 'reviewer', description: 'check PR', prompt: '' });
  });

  it('extracts from tool_input wrapper: data.input.tool_input (object)', () => {
    const result = extractTaskInput({ input: { tool_input: { subagent_type: 'issuer', description: 'brief' } } });
    expect(result).toEqual({ subagentType: 'issuer', description: 'brief', prompt: '' });
  });

  it('extracts from tool_input wrapper: data.input.tool_input (JSON string)', () => {
    const result = extractTaskInput({
      input: { tool_input: '{"subagent_type":"issuer","description":"analyze issue"}' },
    });
    expect(result).toEqual({ subagentType: 'issuer', description: 'analyze issue', prompt: '' });
  });

  it('falls back to JSON.stringify search when nested deeply', () => {
    const result = extractTaskInput({ input: { wrapper: { deep: { subagent_type: 'coder', description: 'deep' } } } });
    expect(result.subagentType).toBe('coder');
  });

  it('returns unknown when data is undefined', () => {
    const result = extractTaskInput(undefined);
    expect(result).toEqual({ subagentType: 'unknown', description: '', prompt: '' });
  });

  it('returns unknown when data.input is empty object', () => {
    const result = extractTaskInput({ input: {} });
    expect(result).toEqual({ subagentType: 'unknown', description: '', prompt: '' });
  });

  it('returns unknown when data.input is invalid JSON string', () => {
    const result = extractTaskInput({ input: 'not-json' });
    expect(result).toEqual({ subagentType: 'unknown', description: '', prompt: '' });
  });

  it('defaults description and prompt to empty string when missing', () => {
    const result = extractTaskInput({ input: { subagent_type: 'coder' } });
    expect(result).toEqual({ subagentType: 'coder', description: '', prompt: '' });
  });
});

// ── extractTextContent ──────────────────────────────────────────────────────

describe('extractTextContent', () => {
  it('returns string content as-is', () => {
    expect(extractTextContent('Hello world')).toBe('Hello world');
  });

  it('returns empty string for empty string input', () => {
    expect(extractTextContent('')).toBe('');
  });

  it('extracts text from array of content blocks', () => {
    const content = [
      { type: 'text', text: 'Based on the brief, ' },
      { type: 'tool_use', id: 'abc', name: 'task', input: {} },
      { type: 'text', text: 'I will delegate to the coder.' },
    ];
    expect(extractTextContent(content)).toBe('Based on the brief, \nI will delegate to the coder.');
  });

  it('returns empty string when array has no text blocks', () => {
    const content = [
      { type: 'tool_use', id: 'abc', name: 'task', input: {} },
    ];
    expect(extractTextContent(content)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(extractTextContent(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(extractTextContent(null)).toBe('');
  });

  it('returns empty string for number', () => {
    expect(extractTextContent(42)).toBe('');
  });

  it('returns empty string for object (non-array)', () => {
    expect(extractTextContent({ text: 'hello' })).toBe('');
  });

  it('skips blocks with non-string text', () => {
    const content = [
      { type: 'text', text: 123 },
      { type: 'text', text: 'valid' },
    ];
    expect(extractTextContent(content)).toBe('valid');
  });
});

// ── extractSubagentResponse ─────────────────────────────────────────────────

describe('extractSubagentResponse', () => {
  it('extracts kwargs.content from LangGraph Command output', () => {
    const output = {
      lg_name: 'Command',
      update: {
        files: {},
        messages: [
          {
            lc: 1,
            type: 'constructor',
            id: ['langchain_core', 'messages', 'ToolMessage'],
            kwargs: {
              content: '## PLANNING PHASE\n\nI will modify CaseCard.tsx...',
              tool_call_id: 'call_abc123',
              name: 'task',
            },
          },
        ],
      },
    };
    expect(extractSubagentResponse(output)).toBe('## PLANNING PHASE\n\nI will modify CaseCard.tsx...');
  });

  it('joins multiple messages with double newline', () => {
    const output = {
      update: {
        messages: [
          { kwargs: { content: 'First message' } },
          { kwargs: { content: 'Second message' } },
        ],
      },
    };
    expect(extractSubagentResponse(output)).toBe('First message\n\nSecond message');
  });

  it('returns plain string output as-is', () => {
    expect(extractSubagentResponse('Agent response text')).toBe('Agent response text');
  });

  it('returns empty string for undefined', () => {
    expect(extractSubagentResponse(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(extractSubagentResponse(null)).toBe('');
  });

  it('returns empty string for empty object', () => {
    expect(extractSubagentResponse({})).toBe('');
  });

  it('handles direct messages array (no update wrapper)', () => {
    const output = {
      messages: [
        { kwargs: { content: 'Direct message content' } },
      ],
    };
    expect(extractSubagentResponse(output)).toBe('Direct message content');
  });

  it('handles messages with content field directly (no kwargs)', () => {
    const output = {
      messages: [
        { content: 'Simple content' },
      ],
    };
    expect(extractSubagentResponse(output)).toBe('Simple content');
  });

  it('falls back to direct content field', () => {
    const output = { content: 'Fallback content' };
    expect(extractSubagentResponse(output)).toBe('Fallback content');
  });

  it('skips messages with empty content', () => {
    const output = {
      update: {
        messages: [
          { kwargs: { content: '' } },
          { kwargs: { content: 'Real content' } },
        ],
      },
    };
    expect(extractSubagentResponse(output)).toBe('Real content');
  });
});

// ── formatUsageSummaryComment ───────────────────────────────────────────────

describe('formatUsageSummaryComment', () => {
  it('returns null when there are no usage records', async () => {
    const service = new UsageService();
    expect(await formatUsageSummaryComment(service, 'proc-1')).toBeNull();
  });

  it('returns Markdown with total tokens and duration', async () => {
    const service = new UsageService();
    service.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      agent: 'architect',
      processId: 'proc-1',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 3000,
    });

    const comment = (await formatUsageSummaryComment(service, 'proc-1'))!;
    expect(comment).toContain('Model Usage Summary');
    expect(comment).toContain('1,500');  // total tokens
    expect(comment).toContain('1,000');  // input tokens
    expect(comment).toContain('500');    // output tokens
    expect(comment).toContain('3s');     // duration
    expect(comment).toContain('$');      // cost
  });

  it('includes per-agent breakdown table', async () => {
    const service = new UsageService();
    service.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      agent: 'architect',
      processId: 'proc-2',
      inputTokens: 500,
      outputTokens: 200,
      durationMs: 1000,
    });
    service.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      agent: 'coder',
      processId: 'proc-2',
      inputTokens: 2000,
      outputTokens: 1000,
      durationMs: 5000,
    });

    const comment = (await formatUsageSummaryComment(service, 'proc-2'))!;
    expect(comment).toContain('Per-Agent Breakdown');
    expect(comment).toContain('architect');
    expect(comment).toContain('coder');
  });

  it('only includes records for the given processId', async () => {
    const service = new UsageService();
    service.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      agent: 'architect',
      processId: 'proc-a',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 500,
    });
    service.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      agent: 'coder',
      processId: 'proc-b',
      inputTokens: 9000,
      outputTokens: 9000,
      durationMs: 10000,
    });

    const comment = (await formatUsageSummaryComment(service, 'proc-a'))!;
    expect(comment).toContain('150');     // 100 + 50 total tokens for proc-a
    expect(comment).not.toContain('18,000'); // proc-b tokens excluded
  });

  it('includes footer text', async () => {
    const service = new UsageService();
    service.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      agent: 'reviewer',
      processId: 'proc-3',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 200,
    });

    const comment = (await formatUsageSummaryComment(service, 'proc-3'))!;
    expect(comment).toContain('Automated usage report by Deep Agents');
  });
});

// ── Workspace-based subagent factories ────────────────────────────────────────

describe('subagent factories — workspace path flows through', () => {
  const mockOctokit = {} as any;

  it('createIssuerSubagent requires workspacePath and has 7 tools', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.name).toBe('issuer');
    expect(subagent.tools).toHaveLength(7);
  });

  it('createCoderSubagent requires workspacePath and has 9 tools', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { workspacePath: TEST_WORKSPACE });
    expect(subagent.name).toBe('coder');
    expect(subagent.tools).toHaveLength(9);
  });

  it('createReviewerSubagent uses opts.workspacePath and has 5 tools', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE });
    expect(subagent.name).toBe('reviewer');
    expect(subagent.tools).toHaveLength(5);
  });

  it('createReviewerSubagent accepts cache for diff delta and still has 5 tools', () => {
    const cache = new ToolCache();
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, undefined, { workspacePath: TEST_WORKSPACE, cache });
    expect(subagent.name).toBe('reviewer');
    expect(subagent.tools).toHaveLength(5);
  });
});
