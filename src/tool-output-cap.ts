import { tool } from 'langchain';

export const DEFAULT_OUTPUT_CAP = 10_000;

/**
 * Wrap a LangChain tool with an output size cap.
 * If the tool's invoke() returns a string exceeding maxChars, truncates it
 * and appends a note about the truncation.
 *
 * Non-string results pass through unchanged.
 * Mutates the tool in place (same pattern as wrapWithLogging / wrapWithCircuitBreaker).
 */
export function wrapWithOutputCap<T extends ReturnType<typeof tool>>(
  wrappedTool: T,
  maxChars: number = DEFAULT_OUTPUT_CAP,
): T {
  const originalInvoke = wrappedTool.invoke.bind(wrappedTool);
  wrappedTool.invoke = async (input: any, options?: any) => {
    const result = await originalInvoke(input, options);
    if (typeof result === 'string' && result.length > maxChars) {
      return result.slice(0, maxChars) +
        `\n[... output truncated at ${maxChars} chars (original: ${result.length} chars). Use more targeted queries to get specific data.]`;
    }
    return result;
  };
  return wrappedTool;
}
