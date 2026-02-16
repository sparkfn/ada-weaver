import { describe, it, expect } from 'vitest';
import { AIMessage, ToolMessage, HumanMessage } from 'langchain';
import {
  findIterationBoundaries,
  compressOldIterations,
  createIterationPruningMiddleware,
} from '../src/context-pruning.js';

// ── Helpers to build realistic message arrays ────────────────────────────────

function humanMsg(content: string) {
  return new HumanMessage(content);
}

function aiTaskCall(subagentType: string, callId: string, prompt = 'Do the thing') {
  return new AIMessage({
    content: `Delegating to ${subagentType}`,
    tool_calls: [{ name: 'task', id: callId, args: { subagent_type: subagentType, prompt, description: `${subagentType} task` } }],
  });
}

function aiVerificationCall(toolName: string, callId: string) {
  return new AIMessage({
    content: `Checking ${toolName}`,
    tool_calls: [{ name: toolName, id: callId, args: {} }],
  });
}

function toolResult(callId: string, content: string, name = 'task') {
  return new ToolMessage({ content, tool_call_id: callId, name });
}

/**
 * Build a realistic 2-iteration message history:
 *
 * [0] HumanMessage: "Process issue #1"
 * [1] AIMessage: delegate to issuer (call_issuer_1)
 * [2] ToolMessage: issuer response (call_issuer_1)
 * [3] AIMessage: delegate to coder (call_coder_1)
 * [4] ToolMessage: coder response (call_coder_1)
 * [5] AIMessage: delegate to reviewer (call_reviewer_1) — iteration 1 boundary
 * [6] ToolMessage: reviewer response (call_reviewer_1)
 * [7] AIMessage: check_ci_status (call_ci_1)
 * [8] ToolMessage: CI result (call_ci_1)
 * [9] AIMessage: delegate to coder for fix (call_coder_2)
 * [10] ToolMessage: coder fix response (call_coder_2)
 * [11] AIMessage: delegate to reviewer (call_reviewer_2) — iteration 2 boundary
 * [12] ToolMessage: reviewer response (call_reviewer_2)
 */
function buildTwoIterationHistory() {
  return [
    humanMsg('Process issue #1'),                                              // 0
    aiTaskCall('issuer', 'call_issuer_1', 'Analyze issue #1'),                // 1
    toolResult('call_issuer_1', 'A'.repeat(2000)),                            // 2
    aiTaskCall('coder', 'call_coder_1', 'C'.repeat(1000)),                    // 3
    toolResult('call_coder_1', 'B'.repeat(3000)),                             // 4
    aiTaskCall('reviewer', 'call_reviewer_1', 'Review PR #1'),                // 5
    toolResult('call_reviewer_1', 'R'.repeat(2500)),                          // 6
    aiVerificationCall('check_ci_status', 'call_ci_1'),                       // 7
    toolResult('call_ci_1', '{"status":"success","checks":[]}', 'check_ci_status'), // 8
    aiTaskCall('coder', 'call_coder_2', 'D'.repeat(800)),                     // 9
    toolResult('call_coder_2', 'E'.repeat(2000)),                             // 10
    aiTaskCall('reviewer', 'call_reviewer_2', 'Review PR #1 again'),          // 11
    toolResult('call_reviewer_2', 'F'.repeat(1500)),                          // 12
  ];
}

// ── findIterationBoundaries ──────────────────────────────────────────────────

describe('findIterationBoundaries', () => {
  it('finds no boundaries with zero iterations', () => {
    const messages = [
      humanMsg('Process issue #1'),
      aiTaskCall('issuer', 'call_1'),
      toolResult('call_1', 'issuer result'),
    ];
    expect(findIterationBoundaries(messages)).toEqual([]);
  });

  it('finds one boundary after 1 completed iteration', () => {
    const messages = [
      humanMsg('Process issue #1'),
      aiTaskCall('issuer', 'call_1'),
      toolResult('call_1', 'result'),
      aiTaskCall('coder', 'call_2'),
      toolResult('call_2', 'result'),
      aiTaskCall('reviewer', 'call_3'),    // index 5
      toolResult('call_3', 'review result'),
    ];
    expect(findIterationBoundaries(messages)).toEqual([5]);
  });

  it('finds two boundaries after 2 completed iterations', () => {
    const messages = buildTwoIterationHistory();
    expect(findIterationBoundaries(messages)).toEqual([5, 11]);
  });

  it('does not count reviewer delegation without response', () => {
    const messages = [
      humanMsg('Process issue #1'),
      aiTaskCall('reviewer', 'call_1'), // no response yet
    ];
    expect(findIterationBoundaries(messages)).toEqual([]);
  });

  it('ignores non-reviewer task calls', () => {
    const messages = [
      humanMsg('hello'),
      aiTaskCall('coder', 'call_1'),
      toolResult('call_1', 'done'),
      aiTaskCall('issuer', 'call_2'),
      toolResult('call_2', 'done'),
    ];
    expect(findIterationBoundaries(messages)).toEqual([]);
  });
});

// ── compressOldIterations ────────────────────────────────────────────────────

describe('compressOldIterations', () => {
  it('truncates task ToolMessage content to maxCompressedLength', () => {
    const messages = buildTwoIterationHistory();
    // Boundary at index 11. Everything before index 11 is old.
    compressOldIterations(messages, 11, 500);

    // issuer response at index 2 — originally 2000 chars
    const issuerResponse = messages[2] as ToolMessage;
    expect(issuerResponse.content).toContain('[... compressed from previous iteration');
    expect((issuerResponse.content as string).length).toBeLessThan(600);

    // coder response at index 4 — originally 3000 chars
    const coderResponse = messages[4] as ToolMessage;
    expect(coderResponse.content).toContain('[... compressed from previous iteration');

    // reviewer response at index 6 — originally 2500 chars
    const reviewerResponse = messages[6] as ToolMessage;
    expect(reviewerResponse.content).toContain('[... compressed from previous iteration');
  });

  it('replaces non-task ToolMessage content with summary', () => {
    const messages = buildTwoIterationHistory();
    compressOldIterations(messages, 11, 500);

    // CI result at index 8 — not a task tool
    const ciResult = messages[8] as ToolMessage;
    expect(ciResult.content).toBe('[Previous iteration tool result cleared]');
  });

  it('truncates prompt arg in old-iteration AIMessage task calls', () => {
    const messages = buildTwoIterationHistory();
    compressOldIterations(messages, 11, 500);

    // Coder AIMessage at index 3 had prompt of 1000 chars
    const coderAi = messages[3] as AIMessage;
    const args = coderAi.tool_calls[0].args as Record<string, unknown>;
    expect((args.prompt as string).length).toBeLessThan(300);
    expect(args.prompt).toContain('[... prompt truncated from previous iteration]');
  });

  it('preserves the first HumanMessage', () => {
    const messages = buildTwoIterationHistory();
    const originalContent = (messages[0] as HumanMessage).content;
    compressOldIterations(messages, 11, 500);
    expect(messages[0].content).toBe(originalContent);
  });

  it('does not touch messages at or after the boundary index', () => {
    const messages = buildTwoIterationHistory();
    const reviewerContent = (messages[11] as AIMessage).content;
    const reviewerResponseContent = (messages[12] as ToolMessage).content;
    compressOldIterations(messages, 11, 500);
    expect(messages[11].content).toBe(reviewerContent);
    expect(messages[12].content).toBe(reviewerResponseContent);
  });

  it('does not truncate short content', () => {
    const messages = [
      humanMsg('Process issue #1'),
      aiTaskCall('coder', 'call_1', 'short'),
      toolResult('call_1', 'short result'),
      aiTaskCall('reviewer', 'call_2'),
      toolResult('call_2', 'review'),
    ];
    compressOldIterations(messages, 3, 500);
    // 'short result' is under 500 chars — should stay intact
    expect(messages[2].content).toBe('short result');
  });
});

// ── createIterationPruningMiddleware ─────────────────────────────────────────

describe('createIterationPruningMiddleware', () => {
  it('returns middleware with correct name', () => {
    const mw = createIterationPruningMiddleware();
    expect(mw.name).toBe('IterationPruningMiddleware');
  });

  it('is a no-op with < 2 iterations', async () => {
    const mw = createIterationPruningMiddleware();
    const messages = [
      humanMsg('Process issue #1'),
      aiTaskCall('issuer', 'call_1'),
      toolResult('call_1', 'X'.repeat(5000)),
      aiTaskCall('reviewer', 'call_2'),
      toolResult('call_2', 'Y'.repeat(3000)),
    ];

    // Capture original contents
    const originalContents = messages.map(m => m.content);

    // Call wrapModelCall
    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    // All messages should be unchanged
    messages.forEach((m, i) => {
      expect(m.content).toBe(originalContents[i]);
    });
  });

  it('compresses after 2 iterations', async () => {
    const mw = createIterationPruningMiddleware();
    const messages = buildTwoIterationHistory();

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    // Old issuer response (index 2) should be compressed
    expect(messages[2].content).toContain('[... compressed from previous iteration');

    // Latest reviewer response (index 12) should be intact
    expect((messages[12].content as string).length).toBe(1500);
  });

  it('preserves latest iteration messages', async () => {
    const mw = createIterationPruningMiddleware();
    const messages = buildTwoIterationHistory();

    // Capture the latest iteration messages (from boundary index 11 onward)
    const latestAiContent = messages[11].content;
    const latestToolContent = messages[12].content;

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    expect(messages[11].content).toBe(latestAiContent);
    expect(messages[12].content).toBe(latestToolContent);
  });

  it('handles interleaved verification tools', async () => {
    const mw = createIterationPruningMiddleware();
    const messages = buildTwoIterationHistory();

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    // CI result at index 8 should be cleared (non-task tool in old iteration)
    expect(messages[8].content).toBe('[Previous iteration tool result cleared]');
  });

  it('respects maxCompressedLength config', async () => {
    const mw = createIterationPruningMiddleware({ maxCompressedLength: 100 });
    const messages = buildTwoIterationHistory();

    const mockHandler = async (req: any) => new AIMessage('response');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    // Issuer response was 2000 chars, should be truncated to ~100 + suffix
    const issuerContent = messages[2].content as string;
    // The first 100 chars of 'A'.repeat(2000) = 100 A's
    expect(issuerContent.startsWith('A'.repeat(100))).toBe(true);
    expect(issuerContent).toContain('[... compressed from previous iteration — original was 2000 chars]');
    // Total should be well under 250
    expect(issuerContent.length).toBeLessThan(250);
  });

  it('calls through to handler and returns its result', async () => {
    const mw = createIterationPruningMiddleware();
    const messages = buildTwoIterationHistory();

    const expectedResponse = new AIMessage('the final answer');
    const mockHandler = async (req: any) => expectedResponse;

    const result = await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    expect(result).toBe(expectedResponse);
  });

  it('handles empty message array', async () => {
    const mw = createIterationPruningMiddleware();
    const messages: any[] = [];

    const mockHandler = async (req: any) => new AIMessage('response');
    const result = await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    expect(result.content).toBe('response');
  });

  it('handles messages without task tool calls', async () => {
    const mw = createIterationPruningMiddleware();
    const messages = [
      humanMsg('Hello'),
      new AIMessage('Hi there'),
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

  it('handles task args as JSON string', async () => {
    const mw = createIterationPruningMiddleware();

    // Build messages with JSON string args
    const messages = [
      humanMsg('Process issue #1'),
      new AIMessage({
        content: 'Delegating',
        tool_calls: [{ name: 'task', id: 'c1', args: JSON.stringify({ subagent_type: 'coder', prompt: 'X'.repeat(500) }) as any }],
      }),
      toolResult('c1', 'Z'.repeat(2000)),
      new AIMessage({
        content: 'Reviewing',
        tool_calls: [{ name: 'task', id: 'c2', args: JSON.stringify({ subagent_type: 'reviewer', prompt: 'review' }) as any }],
      }),
      toolResult('c2', 'R'.repeat(1000)),
      // Second iteration
      new AIMessage({
        content: 'Fix',
        tool_calls: [{ name: 'task', id: 'c3', args: JSON.stringify({ subagent_type: 'coder', prompt: 'fix stuff' }) as any }],
      }),
      toolResult('c3', 'F'.repeat(1000)),
      new AIMessage({
        content: 'Review again',
        tool_calls: [{ name: 'task', id: 'c4', args: JSON.stringify({ subagent_type: 'reviewer', prompt: 'review again' }) as any }],
      }),
      toolResult('c4', 'G'.repeat(500)),
    ];

    const mockHandler = async (req: any) => new AIMessage('done');
    await mw.wrapModelCall!(
      { messages, model: {} as any, tools: [], systemPrompt: '', systemMessage: {} as any, state: {} as any, runtime: {} as any } as any,
      mockHandler,
    );

    // Old coder response (index 2) should be compressed
    expect(messages[2].content).toContain('[... compressed from previous iteration');
  });
});
