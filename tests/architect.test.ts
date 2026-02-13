import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildArchitectSystemPrompt,
  createIssuerSubagent,
  createCoderSubagent,
  createReviewerSubagent,
  getMaxIterations,
} from '../src/architect.js';

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

  it('mentions read-only verification tools', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('fetch_github_issues');
    expect(prompt).toContain('list_repo_files');
    expect(prompt).toContain('read_repo_file');
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

  it('contains PARALLEL EXECUTION section', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('PARALLEL EXECUTION');
    expect(prompt).toContain('multiple independent tasks');
  });

  it('contains RULES FOR PARALLEL DELEGATION', () => {
    const prompt = buildArchitectSystemPrompt('o', 'r', 3);
    expect(prompt).toContain('RULES FOR PARALLEL DELEGATION');
    expect(prompt).toContain('different branch');
    expect(prompt).toContain('issuer step should remain sequential');
  });
});

// ── createIssuerSubagent ────────────────────────────────────────────────────

describe('createIssuerSubagent', () => {
  const mockOctokit = {} as any;

  it('returns SubAgent with name "issuer"', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit);
    expect(subagent.name).toBe('issuer');
  });

  it('has 5 read-only tools', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit);
    expect(subagent.tools).toHaveLength(5);
  });

  it('system prompt contains owner/repo', () => {
    const subagent = createIssuerSubagent('test-owner', 'test-repo', mockOctokit);
    expect(subagent.systemPrompt).toContain('test-owner/test-repo');
  });

  it('has a description', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit);
    expect(subagent.description).toBeTruthy();
    expect(subagent.description).toContain('issue');
  });

  it('does not include model when not provided', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit);
    expect(subagent.model).toBeUndefined();
  });

  it('includes model when provided', () => {
    const mockModel = { invoke: vi.fn() } as any;
    const subagent = createIssuerSubagent('o', 'r', mockOctokit, mockModel);
    expect(subagent.model).toBe(mockModel);
  });

  it('system prompt mentions READ-ONLY constraints', () => {
    const subagent = createIssuerSubagent('o', 'r', mockOctokit);
    expect(subagent.systemPrompt).toContain('READ-ONLY');
  });
});

// ── createCoderSubagent ─────────────────────────────────────────────────────

describe('createCoderSubagent', () => {
  const mockOctokit = {} as any;

  it('returns SubAgent with name "coder"', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, {});
    expect(subagent.name).toBe('coder');
  });

  it('has 7 tools in normal mode', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, {});
    expect(subagent.tools).toHaveLength(7);
  });

  it('has 7 tools in dry-run mode', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { dryRun: true });
    expect(subagent.tools).toHaveLength(7);
  });

  it('system prompt contains owner/repo', () => {
    const subagent = createCoderSubagent('test-owner', 'test-repo', mockOctokit, {});
    expect(subagent.systemPrompt).toContain('test-owner/test-repo');
  });

  it('does not include model when not provided', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, {});
    expect(subagent.model).toBeUndefined();
  });

  it('includes model when provided', () => {
    const mockModel = { invoke: vi.fn() } as any;
    const subagent = createCoderSubagent('o', 'r', mockOctokit, { model: mockModel });
    expect(subagent.model).toBe(mockModel);
  });

  it('has a description', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, {});
    expect(subagent.description).toBeTruthy();
    expect(subagent.description).toContain('code');
  });

  it('system prompt includes TESTING GUIDELINES', () => {
    const subagent = createCoderSubagent('o', 'r', mockOctokit, {});
    expect(subagent.systemPrompt).toContain('TESTING GUIDELINES');
    expect(subagent.systemPrompt).toContain('happy path');
  });

  it('uses dry-run tools when dryRun is true', () => {
    const normalAgent = createCoderSubagent('o', 'r', mockOctokit, { dryRun: false });
    const dryRunAgent = createCoderSubagent('o', 'r', mockOctokit, { dryRun: true });

    // Both should have the same number of tools
    expect(normalAgent.tools!.length).toBe(dryRunAgent.tools!.length);

    // Tool names should be the same (dry-run tools have same names)
    const normalNames = normalAgent.tools!.map((t: any) => t.name).sort();
    const dryRunNames = dryRunAgent.tools!.map((t: any) => t.name).sort();
    expect(normalNames).toEqual(dryRunNames);
  });
});

// ── createReviewerSubagent ──────────────────────────────────────────────────

describe('createReviewerSubagent', () => {
  const mockOctokit = {} as any;

  it('returns SubAgent with name "reviewer"', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit);
    expect(subagent.name).toBe('reviewer');
  });

  it('has 4 tools', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit);
    expect(subagent.tools).toHaveLength(4);
  });

  it('system prompt contains owner/repo (from buildReviewerSystemPrompt)', () => {
    const subagent = createReviewerSubagent('test-owner', 'test-repo', mockOctokit);
    expect(subagent.systemPrompt).toContain('test-owner/test-repo');
  });

  it('does not include model when not provided', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit);
    expect(subagent.model).toBeUndefined();
  });

  it('includes model when provided', () => {
    const mockModel = { invoke: vi.fn() } as any;
    const subagent = createReviewerSubagent('o', 'r', mockOctokit, mockModel);
    expect(subagent.model).toBe(mockModel);
  });

  it('has a description mentioning reviews', () => {
    const subagent = createReviewerSubagent('o', 'r', mockOctokit);
    expect(subagent.description).toContain('review');
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
