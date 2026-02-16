import { describe, it, expect } from 'vitest';
import { AIMessage, ToolMessage, HumanMessage } from 'langchain';
import {
  totalMessageChars,
  compactMessages,
  createContextCompactionMiddleware,
} from '../src/context-compaction.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function humanMsg(content: string) {
  return new HumanMessage(content);
}

function aiMsg(content: string) {
  return new AIMessage(content);
}

function aiWithToolCalls(content: string, toolCalls: Array<{ name: string; id: string; args: Record<string, any> }>) {
  return new AIMessage({ content, tool_calls: toolCalls });
}

function toolResult(callId: string, content: string, name = 'task') {
  return new ToolMessage({ content, tool_call_id: callId, name });
}

/**
 * Build a message history that exceeds default threshold (80K chars).
 * Each tool result is ~10K chars, and we have enough to push well over 80K.
 */
function buildLargeHistory() {
  return [
    humanMsg('Process issue #1'),                                                    // 0 - seed
    aiWithToolCalls('Analyzing', [{ name: 'fetch_github_issues', id: 'c1', args: { issue_number: 1 } }]),  // 1
    toolResult('c1', 'X'.repeat(10000)),                                            // 2
    aiWithToolCalls('Reading file', [{ name: 'read_file', id: 'c2', args: { path: 'src/app.ts' } }]),      // 3
    toolResult('c2', 'Y'.repeat(15000)),                                            // 4
    aiMsg('I will now plan the changes. ' + 'P'.repeat(2000)),                      // 5
    aiWithToolCalls('Editing', [{ name: 'edit_file', id: 'c3', args: { path: 'src/app.ts', old_text: 'A'.repeat(600), new_text: 'new code' } }]),  // 6
    toolResult('c3', 'Successfully edited src/app.ts'),                              // 7
    aiWithToolCalls('Committing', [{ name: 'bash', id: 'c4', args: { command: 'git add -A && git commit -m "fix"' } }]),  // 8
    toolResult('c4', 'Z'.repeat(12000)),                                            // 9
    aiWithToolCalls('Creating PR', [{ name: 'create_pull_request', id: 'c5', args: { title: 'Fix #1' } }]),               // 10
    toolResult('c5', 'W'.repeat(8000)),                                             // 11
    aiWithToolCalls('Reviewing', [{ name: 'get_pr_diff', id: 'c6', args: { pull_number: 42 } }]),                         // 12
    toolResult('c6', 'D'.repeat(20000)),                                            // 13
    aiMsg('The review looks good. ' + 'R'.repeat(1000)),                            // 14
    aiWithToolCalls('Submitting review', [{ name: 'submit_pr_review', id: 'c7', args: { pull_number: 42 } }]),            // 15
    toolResult('c7', 'Review submitted'),                                            // 16
  ];
}

// ── totalMessageChars ────────────────────────────────────────────────────────

describe('totalMessageChars', () => {
  it('counts string content', () => {
    const messages = [humanMsg('hello'), aiMsg('world')];
    expect(totalMessageChars(messages)).toBe(10);
  });

  it('counts tool call args', () => {
    const messages = [
      aiWithToolCalls('hi', [{ name: 'test', id: 'c1', args: { prompt: 'abc' } }]),
    ];
    // 'hi' (2) + JSON.stringify({prompt:'abc'}) (15)
    const total = totalMessageChars(messages);
    expect(total).toBeGreaterThan(2);
  });

  it('returns 0 for empty array', () => {
    expect(totalMessageChars([])).toBe(0);
  });
});

// ── compactMessages ──────────────────────────────────────────────────────────

describe('compactMessages', () => {
  it('truncates ToolMessage content exceeding maxToolResultChars', () => {
    const messages = [
      humanMsg('seed'),
      toolResult('c1', 'A'.repeat(2000)),
      aiMsg('done'),
    ];
    compactMessages(messages, 2, 500);
    const content = messages[1].content as string;
    expect(content.length).toBeLessThan(600);
    expect(content).toContain('[... compacted — original was 2000 chars]');
  });

  it('preserves seed HumanMessage (index 0)', () => {
    const messages = [
      humanMsg('important seed message'),
      toolResult('c1', 'A'.repeat(2000)),
    ];
    compactMessages(messages, 2, 500);
    expect(messages[0].content).toBe('important seed message');
  });

  it('does not touch messages at or after endIndex', () => {
    const messages = [
      humanMsg('seed'),
      toolResult('c1', 'A'.repeat(2000)),
      toolResult('c2', 'B'.repeat(3000)),  // This is at endIndex, should be preserved
    ];
    compactMessages(messages, 2, 500);
    // Index 1 should be compacted
    expect((messages[1].content as string)).toContain('[... compacted');
    // Index 2 should be untouched
    expect(messages[2].content).toBe('B'.repeat(3000));
  });

  it('truncates long AIMessage text content', () => {
    const messages = [
      humanMsg('seed'),
      aiMsg('L'.repeat(1000)),
      aiMsg('short'),
    ];
    compactMessages(messages, 2, 500);
    const content = messages[1].content as string;
    expect(content.length).toBeLessThan(300);
    expect(content).toContain('[... compacted — original was 1000 chars]');
  });

  it('truncates long string args in tool calls', () => {
    const messages = [
      humanMsg('seed'),
      aiWithToolCalls('edit', [{ name: 'edit_file', id: 'c1', args: { path: 'f.ts', old_text: 'O'.repeat(800) } }]),
      aiMsg('done'),
    ];
    compactMessages(messages, 2, 500);
    const tc = (messages[1] as AIMessage).tool_calls[0];
    expect((tc.args as any).old_text.length).toBeLessThan(300);
    expect((tc.args as any).old_text).toContain('[... compacted]');
  });

  it('does not truncate short content', () => {
    const messages = [
      humanMsg('seed'),
      toolResult('c1', 'short result'),
      aiMsg('ok'),
    ];
    compactMessages(messages, 2, 500);
    expect(messages[1].content).toBe('short result');
  });

  it('is idempotent — compacting already-compacted messages does not crash', () => {
    const messages = [
      humanMsg('seed'),
      toolResult('c1', 'A'.repeat(2000)),
    ];
    compactMessages(messages, 2, 500);
    const afterFirst = messages[1].content as string;
    // Compact again
    compactMessages(messages, 2, 500);
    const afterSecond = messages[1].content as string;
    expect(afterSecond).toBe(afterFirst);
  });
});

// ── createContextCompactionMiddleware ─────────────────────────────────────────

describe('createContextCompactionMiddleware', () => {
  it('returns middleware with correct name', () => {
    const mw = createContextCompactionMiddleware();
    expect(mw.name).toBe('ContextCompactionMiddleware');
  });

  it('does NOT compact when under threshold', async () => {
    const mw = createContextCompactionMiddleware({ maxTotalChars: 100_000 });
    const messages = [
      humanMsg('Process issue #1'),
      toolResult('c1', 'Short result'),
      aiMsg('OK, done'),
    ];
    const originalContents = messages.map(m => m.content);

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    messages.forEach((m, i) => {
      expect(m.content).toBe(originalContents[i]);
    });
  });

  it('compacts tool results when over threshold', async () => {
    const mw = createContextCompactionMiddleware({ maxTotalChars: 1000, preserveRecentCount: 2 });
    const messages = buildLargeHistory();

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    // Early tool result (index 2) should be compacted — was 10K chars
    const earlyResult = messages[2].content as string;
    expect(earlyResult.length).toBeLessThan(600);
    expect(earlyResult).toContain('[... compacted');
  });

  it('preserves seed HumanMessage (index 0)', async () => {
    const mw = createContextCompactionMiddleware({ maxTotalChars: 1000, preserveRecentCount: 2 });
    const messages = buildLargeHistory();

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    expect(messages[0].content).toBe('Process issue #1');
  });

  it('preserves recent N messages intact', async () => {
    const preserveCount = 3;
    const mw = createContextCompactionMiddleware({ maxTotalChars: 1000, preserveRecentCount: preserveCount });
    const messages = buildLargeHistory();

    // Capture original content of last N messages
    const recentOriginals = messages.slice(-preserveCount).map(m => m.content);

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    const recentAfter = messages.slice(-preserveCount).map(m => m.content);
    expect(recentAfter).toEqual(recentOriginals);
  });

  it('handles already-compacted messages (idempotent)', async () => {
    const mw = createContextCompactionMiddleware({ maxTotalChars: 1000, preserveRecentCount: 2 });
    const messages = buildLargeHistory();

    const mockHandler = async (req: any) => new AIMessage('response');
    // First pass
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );
    const afterFirst = (messages[2].content as string);

    // Second pass
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );
    const afterSecond = (messages[2].content as string);

    expect(afterSecond).toBe(afterFirst);
  });

  it('calls through to handler and returns its result', async () => {
    const mw = createContextCompactionMiddleware();
    const expectedResponse = new AIMessage('the final answer');
    const mockHandler = async (req: any) => expectedResponse;

    const result = await mw.wrapModelCall!(
      { messages: [humanMsg('hi')], model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    expect(result).toBe(expectedResponse);
  });

  it('respects custom maxToolResultChars', async () => {
    const mw = createContextCompactionMiddleware({ maxTotalChars: 100, maxToolResultChars: 50, preserveRecentCount: 1 });
    const messages = [
      humanMsg('seed'),
      toolResult('c1', 'A'.repeat(2000)),
      aiMsg('done'),
    ];

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    const content = messages[1].content as string;
    // First 50 chars + suffix
    expect(content.startsWith('A'.repeat(50))).toBe(true);
    expect(content).toContain('[... compacted — original was 2000 chars]');
    expect(content.length).toBeLessThan(150);
  });

  it('handles empty message array', async () => {
    const mw = createContextCompactionMiddleware();
    const messages: any[] = [];

    const mockHandler = async (req: any) => new AIMessage('response');
    const result = await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    expect(result.content).toBe('response');
  });
});
