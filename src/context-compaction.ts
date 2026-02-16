import { createMiddleware, AIMessage, ToolMessage } from 'langchain';
import type { BaseMessage } from 'langchain';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContextCompactionOptions {
  /** Total chars across all messages before compaction triggers (default: 80_000) */
  maxTotalChars?: number;
  /** Max chars to keep from truncated tool results (default: 500) */
  maxToolResultChars?: number;
  /** Number of recent messages to always preserve (default: 10) */
  preserveRecentCount?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculate total character count across all message content.
 */
export function totalMessageChars(messages: BaseMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') total += block.length;
        else if (block && typeof block === 'object' && 'text' in block) total += String(block.text).length;
      }
    }
    // Count tool call args for AIMessages
    if (msg instanceof AIMessage) {
      const toolCalls = (msg as any).tool_calls ?? [];
      for (const tc of toolCalls) {
        const args = tc.args;
        if (typeof args === 'string') total += args.length;
        else if (args && typeof args === 'object') total += JSON.stringify(args).length;
      }
    }
  }
  return total;
}

/**
 * Compact messages in the range [1, endIndex) — preserving index 0 (seed) and
 * everything from endIndex onward (recent messages).
 */
export function compactMessages(
  messages: BaseMessage[],
  endIndex: number,
  maxToolResultChars: number,
): void {
  for (let i = 1; i < endIndex; i++) {
    const msg = messages[i];

    if (msg instanceof ToolMessage) {
      const content = msg.content;
      if (typeof content === 'string' && content.length > maxToolResultChars && !content.includes('[... compacted')) {
        const originalLen = content.length;
        (msg as any).content = content.slice(0, maxToolResultChars) +
          `\n\n[... compacted — original was ${originalLen} chars]`;
      }
    } else if (msg instanceof AIMessage) {
      // Truncate long text content
      if (typeof msg.content === 'string' && msg.content.length > 500 && !msg.content.includes('[... compacted')) {
        const originalLen = msg.content.length;
        (msg as any).content = msg.content.slice(0, 200) +
          `\n\n[... compacted — original was ${originalLen} chars]`;
      }

      // Truncate long string args in tool calls
      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc.args && typeof tc.args === 'object') {
            for (const key of Object.keys(tc.args)) {
              const val = tc.args[key];
              if (typeof val === 'string' && val.length > 500) {
                tc.args[key] = val.slice(0, 200) + '\n\n[... compacted]';
              }
            }
          }
        }
      }
    }
  }
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Creates middleware that compacts old context when total message chars exceed
 * a threshold. Preserves the seed HumanMessage (index 0) and the most recent
 * N messages. Everything in between gets truncated.
 */
export function createContextCompactionMiddleware(opts?: ContextCompactionOptions) {
  const maxTotalChars = opts?.maxTotalChars ?? 80_000;
  const maxToolResultChars = opts?.maxToolResultChars ?? 500;
  const preserveRecentCount = opts?.preserveRecentCount ?? 10;

  return createMiddleware({
    name: 'ContextCompactionMiddleware',
    wrapModelCall: async (request, handler) => {
      const { messages } = request;

      const total = totalMessageChars(messages);

      if (total > maxTotalChars && messages.length > preserveRecentCount + 1) {
        const endIndex = messages.length - preserveRecentCount;
        compactMessages(messages, endIndex, maxToolResultChars);
      }

      return handler(request);
    },
  });
}
