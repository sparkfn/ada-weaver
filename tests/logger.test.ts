import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wrapWithLogging, formatDuration, logAgentEvent, logAgentDetail, logDiff } from '../src/logger.js';
import {
  createDryRunBranchTool,
  createDryRunCommentTool,
  ToolCallCounter,
} from '../src/github-tools.js';

// ── wrapWithLogging ──────────────────────────────────────────────────────────

describe('wrapWithLogging', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('logs tool name, arguments, and duration on success', async () => {
    const tool = wrapWithLogging(createDryRunBranchTool());

    await tool.invoke({ branch_name: 'issue-1-fix' });

    expect(consoleSpy).toHaveBeenCalledTimes(2); // dry-run tool logs + our log
    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    expect(ourLog).toBeDefined();
    expect(ourLog).toContain('create_branch');
    expect(ourLog).toContain('issue-1-fix');
    expect(ourLog).toMatch(/\d+ms/);
  });

  it('includes count label when ToolCallCounter is provided', async () => {
    const counter = new ToolCallCounter(10);
    const tool = wrapWithLogging(createDryRunBranchTool(), counter);

    await tool.invoke({ branch_name: 'test-branch' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    expect(ourLog).toContain('#1/10');
  });

  it('omits count label when no counter is provided', async () => {
    const tool = wrapWithLogging(createDryRunBranchTool());

    await tool.invoke({ branch_name: 'test-branch' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    // Should have "TOOL |" without a count
    expect(ourLog).toMatch(/TOOL \|/);
    expect(ourLog).not.toMatch(/#\d+\/\d+/);
  });

  it('increments count label on successive calls', async () => {
    const counter = new ToolCallCounter(10);
    const tool = wrapWithLogging(createDryRunBranchTool(), counter);

    // Note: counter is not wrapped with circuit breaker, so it won't increment on its own.
    // wrapWithLogging reads the counter but does NOT increment it.
    // In production, the circuit breaker wrapper increments the counter.
    // For this test, we manually increment to simulate.
    counter.increment('create_branch');
    await tool.invoke({ branch_name: 'first' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    // After 1 manual increment, getCount() = 1, so next label = #2/10
    expect(ourLog).toContain('#2/10');
  });

  it('logs errors to console.error and re-throws', async () => {
    const tool = createDryRunBranchTool();
    const originalInvoke = tool.invoke.bind(tool);

    // Make the tool throw
    tool.invoke = async () => {
      throw new Error('API exploded');
    };

    const logged = wrapWithLogging(tool);

    await expect(logged.invoke({ branch_name: 'err' })).rejects.toThrow('API exploded');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const errLog = consoleErrorSpy.mock.calls[0][0];
    expect(errLog).toContain('ERROR');
    expect(errLog).toContain('API exploded');
    expect(errLog).toContain('create_branch');

    // Restore for other tests
    tool.invoke = originalInvoke;
  });

  it('includes timestamp in HH:MM:SS format', async () => {
    const tool = wrapWithLogging(createDryRunCommentTool());

    await tool.invoke({ issue_number: 5, body: 'test' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const ourLog = logCalls.find((msg: string) => msg.includes('TOOL'));
    // Match [HH:MM:SS] pattern
    expect(ourLog).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  it('preserves the tool name after wrapping', () => {
    const tool = wrapWithLogging(createDryRunBranchTool());
    expect(tool.name).toBe('create_branch');
  });

  it('returns the original tool result', async () => {
    const tool = wrapWithLogging(createDryRunBranchTool());
    const result = JSON.parse(await tool.invoke({ branch_name: 'test' }));

    expect(result.dry_run).toBe(true);
    expect(result.branch).toBe('test');
  });

  it('works with multiple tools sharing a counter', async () => {
    const counter = new ToolCallCounter(20);
    const branchTool = wrapWithLogging(createDryRunBranchTool(), counter);
    const commentTool = wrapWithLogging(createDryRunCommentTool(), counter);

    await branchTool.invoke({ branch_name: 'b1' });
    await commentTool.invoke({ issue_number: 1, body: 'hi' });

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const toolLogs = logCalls.filter((msg: string) => msg.includes('TOOL'));
    // Both should show count out of 20
    expect(toolLogs[0]).toContain('/20');
    expect(toolLogs[1]).toContain('/20');
  });
});

// ── formatDuration ───────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats sub-second durations as milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats durations under 60s as seconds', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(13000)).toBe('13s');
    expect(formatDuration(59499)).toBe('59s');
  });

  it('formats durations of 60s+ as minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(125000)).toBe('2m 5s');
    expect(formatDuration(180000)).toBe('3m');
  });

  it('rounds sub-second values to nearest millisecond', () => {
    expect(formatDuration(123.7)).toBe('124ms');
  });

  it('rounds to nearest second for values >= 1000ms', () => {
    expect(formatDuration(1499)).toBe('1s');
    expect(formatDuration(1500)).toBe('2s');
  });
});

// ── logAgentEvent ────────────────────────────────────────────────────────────

describe('logAgentEvent', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('logs with timestamp, uppercased agent name, and action', () => {
    logAgentEvent('coder', 'started');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const msg = consoleSpy.mock.calls[0][0];
    expect(msg).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(msg).toContain('CODER');
    expect(msg).toContain('started');
    expect(msg).toContain('\u2500\u2500\u2500');
  });

  it('includes truncated detail when provided', () => {
    logAgentEvent('issuer', 'started', 'Analyze issue #42');

    const msg = consoleSpy.mock.calls[0][0];
    expect(msg).toContain('ISSUER');
    expect(msg).toContain('"Analyze issue #42"');
  });

  it('truncates long details to 50 characters with ellipsis', () => {
    const longDetail = 'A'.repeat(60);
    logAgentEvent('reviewer', 'started', longDetail);

    const msg = consoleSpy.mock.calls[0][0];
    expect(msg).toContain('"' + 'A'.repeat(50) + '..."');
  });

  it('does not add detail section when detail is omitted', () => {
    logAgentEvent('coder', 'completed (13s)');

    const msg = consoleSpy.mock.calls[0][0];
    // Should end with the trailing dashes, no quotes
    expect(msg).not.toContain('"');
    expect(msg).toContain('completed (13s)');
  });
});

// ── logDiff ─────────────────────────────────────────────────────────────────

describe('logDiff', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  const SAMPLE_DIFF = [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,4 @@',
    ' const x = 1;',
    '-const y = 2;',
    '+const y = 3;',
    '+const z = 4;',
  ].join('\n');

  it('outputs the header banner', () => {
    logDiff(SAMPLE_DIFF);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const banner = lines.find((l: string) => l.includes('Code Changes'));
    expect(banner).toBeDefined();
  });

  it('colours additions in green (ANSI 32)', () => {
    logDiff(SAMPLE_DIFF);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const addLine = lines.find((l: string) => l.includes('+const y = 3'));
    expect(addLine).toContain('\x1b[32m');
  });

  it('colours deletions in red (ANSI 31)', () => {
    logDiff(SAMPLE_DIFF);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const delLine = lines.find((l: string) => l.includes('-const y = 2'));
    expect(delLine).toContain('\x1b[31m');
  });

  it('colours hunk headers in yellow (ANSI 33)', () => {
    logDiff(SAMPLE_DIFF);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const hunk = lines.find((l: string) => l.includes('@@'));
    expect(hunk).toContain('\x1b[33m');
  });

  it('colours file headers in cyan (ANSI 36)', () => {
    logDiff(SAMPLE_DIFF);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const fileHeader = lines.find((l: string) => l.includes('diff --git'));
    expect(fileHeader).toContain('\x1b[36m');
  });

  it('dims context lines (ANSI 2)', () => {
    logDiff(SAMPLE_DIFF);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const ctx = lines.find((l: string) => l.includes('const x = 1'));
    expect(ctx).toContain('\x1b[2m');
  });

  it('truncates output when exceeding maxLines', () => {
    const bigDiff = Array.from({ length: 300 }, (_, i) => `+line ${i}`).join('\n');
    logDiff(bigDiff, 50);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const truncMsg = lines.find((l: string) => l.includes('truncated'));
    expect(truncMsg).toBeDefined();
    expect(truncMsg).toContain('50');
    expect(truncMsg).toContain('300');
  });

  it('does not truncate when under maxLines', () => {
    logDiff(SAMPLE_DIFF, 200);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const truncMsg = lines.find((l: string) => l.includes('truncated'));
    expect(truncMsg).toBeUndefined();
  });

  it('handles empty diff string', () => {
    logDiff('');

    // Should still produce the banner without crashing
    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const banner = lines.find((l: string) => l.includes('Code Changes'));
    expect(banner).toBeDefined();
  });
});

// ── logAgentDetail ──────────────────────────────────────────────────────────

describe('logAgentDetail', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints the label in the header', () => {
    logAgentDetail('issuer output', 'Issue #24 is a UI change');

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const header = lines.find((l: string) => l.includes('issuer output'));
    expect(header).toBeDefined();
  });

  it('prints content lines with border', () => {
    logAgentDetail('test', 'line one\nline two\nline three');

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    expect(lines.some((l: string) => l.includes('line one'))).toBe(true);
    expect(lines.some((l: string) => l.includes('line two'))).toBe(true);
    expect(lines.some((l: string) => l.includes('line three'))).toBe(true);
  });

  it('truncates at maxLines and shows remainder count', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    logAgentDetail('test', content, 5);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const truncMsg = lines.find((l: string) => l.includes('more lines'));
    expect(truncMsg).toBeDefined();
    expect(truncMsg).toContain('25');
  });

  it('truncates long lines at 120 chars', () => {
    const longLine = 'X'.repeat(200);
    logAgentDetail('test', longLine);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const contentLine = lines.find((l: string) => l.includes('XXX'));
    expect(contentLine).toBeDefined();
    expect(contentLine!.includes('X'.repeat(200))).toBe(false);
    expect(contentLine).toContain('...');
  });

  it('does not show truncation message when under maxLines', () => {
    logAgentDetail('test', 'short\ncontent', 10);

    const lines = consoleSpy.mock.calls.map((c) => c[0]);
    const truncMsg = lines.find((l: string) => l.includes('more lines'));
    expect(truncMsg).toBeUndefined();
  });
});
