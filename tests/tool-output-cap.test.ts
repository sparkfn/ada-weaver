import { describe, it, expect } from 'vitest';
import { tool } from 'langchain';
import { z } from 'zod';
import { wrapWithOutputCap, DEFAULT_OUTPUT_CAP } from '../src/tool-output-cap.js';

// Helper: create a simple tool that returns its input string
function createEchoTool() {
  return tool(
    async ({ text }: { text: string }) => text,
    {
      name: 'echo',
      description: 'Returns the input text',
      schema: z.object({ text: z.string() }),
    },
  );
}

// Helper: create a tool that returns a number (non-string)
function createNumberTool() {
  return tool(
    async ({ n }: { n: number }) => n as any,
    {
      name: 'number',
      description: 'Returns a number',
      schema: z.object({ n: z.number() }),
    },
  );
}

describe('wrapWithOutputCap', () => {
  it('passes through output under the cap unchanged', async () => {
    const t = wrapWithOutputCap(createEchoTool());
    const result = await t.invoke({ text: 'hello' });
    expect(result).toBe('hello');
  });

  it('truncates output over the cap with a note', async () => {
    const t = wrapWithOutputCap(createEchoTool(), 100);
    const longText = 'x'.repeat(200);
    const result = await t.invoke({ text: longText });

    // Truncated body is 100 chars + note suffix
    expect(result.startsWith('x'.repeat(100))).toBe(true);
    expect(result).toContain('[... output truncated at 100 chars');
    expect(result).toContain('original: 200 chars');
  });

  it('respects custom maxChars', async () => {
    const t = wrapWithOutputCap(createEchoTool(), 50);
    const text = 'a'.repeat(80);
    const result = await t.invoke({ text });

    expect(result).toContain('[... output truncated at 50 chars');
    // First 50 chars should be present
    expect(result.startsWith('a'.repeat(50))).toBe(true);
  });

  it('does not truncate output exactly at the cap', async () => {
    const t = wrapWithOutputCap(createEchoTool(), 100);
    const exactText = 'x'.repeat(100);
    const result = await t.invoke({ text: exactText });

    expect(result).toBe(exactText);
    expect(result).not.toContain('truncated');
  });

  it('preserves the tool name after wrapping', () => {
    const t = wrapWithOutputCap(createEchoTool());
    expect(t.name).toBe('echo');
  });

  it('returns the same tool reference (mutates in place)', () => {
    const original = createEchoTool();
    const wrapped = wrapWithOutputCap(original);
    expect(wrapped).toBe(original);
  });

  it('passes through non-string results unchanged', async () => {
    const t = wrapWithOutputCap(createNumberTool(), 5);
    const result = await t.invoke({ n: 999999 });
    expect(result).toBe(999999);
  });

  it('uses DEFAULT_OUTPUT_CAP when no maxChars parameter given', async () => {
    const t = wrapWithOutputCap(createEchoTool());
    // Output under default cap passes through
    const smallText = 'x'.repeat(DEFAULT_OUTPUT_CAP);
    const result = await t.invoke({ text: smallText });
    expect(result).toBe(smallText);

    // Output over default cap gets truncated
    const bigText = 'y'.repeat(DEFAULT_OUTPUT_CAP + 1);
    const bigResult = await t.invoke({ text: bigText });
    expect(bigResult).toContain('truncated');
  });

  it('composes with another wrapper (output cap outermost)', async () => {
    // Simulate wrapWithLogging-style wrapper that prepends a marker
    const echoTool = createEchoTool();
    const originalInvoke = echoTool.invoke.bind(echoTool);
    echoTool.invoke = async (input: any, options?: any) => {
      const result = await originalInvoke(input, options);
      return `[logged] ${result}`;
    };

    // Apply output cap on top
    wrapWithOutputCap(echoTool, 50);

    const longText = 'z'.repeat(100);
    const result = await echoTool.invoke({ text: longText });

    // The [logged] prefix is added by inner wrapper, then output cap truncates
    expect(result).toContain('[... output truncated at 50 chars');
  });
});
