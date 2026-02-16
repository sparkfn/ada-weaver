import { createMiddleware, AIMessage, ToolMessage } from 'langchain';
import type { BaseMessage } from 'langchain';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IterationPruningOptions {
  /** Max chars to keep from truncated task ToolMessage content (default: 500) */
  maxCompressedLength?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract `subagent_type` from an AIMessage's task tool call args.
 * The args may be a parsed object or a JSON string.
 */
function getSubagentType(toolCallArgs: unknown): string | undefined {
  if (toolCallArgs && typeof toolCallArgs === 'object' && 'subagent_type' in toolCallArgs) {
    return (toolCallArgs as Record<string, unknown>).subagent_type as string;
  }
  if (typeof toolCallArgs === 'string') {
    try {
      const parsed = JSON.parse(toolCallArgs);
      if (parsed && typeof parsed.subagent_type === 'string') return parsed.subagent_type;
    } catch { /* not JSON */ }
  }
  return undefined;
}

/**
 * Find task tool calls on an AIMessage.
 * Returns array of { index, name, id, args, subagentType }.
 */
function findTaskToolCalls(msg: AIMessage): Array<{
  index: number;
  name: string;
  id: string;
  args: unknown;
  subagentType: string | undefined;
}> {
  const toolCalls = (msg as any).tool_calls ?? (msg as any).additional_kwargs?.tool_calls ?? [];
  const results: Array<{ index: number; name: string; id: string; args: unknown; subagentType: string | undefined }> = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (tc.name === 'task') {
      results.push({
        index: i,
        name: tc.name,
        id: tc.id,
        args: tc.args,
        subagentType: getSubagentType(tc.args),
      });
    }
  }

  return results;
}

/**
 * Identify completed iteration boundaries in the message array.
 *
 * A "completed iteration" = an AIMessage that delegates to a reviewer via task tool,
 * followed by the corresponding ToolMessage response.
 *
 * Returns indices of the AIMessage that triggered each reviewer delegation.
 */
export function findIterationBoundaries(messages: BaseMessage[]): number[] {
  const boundaries: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!(msg instanceof AIMessage)) continue;

    const taskCalls = findTaskToolCalls(msg);
    const reviewerCall = taskCalls.find(tc => tc.subagentType === 'reviewer');
    if (!reviewerCall) continue;

    // Check that there's a corresponding ToolMessage response after this AIMessage
    for (let j = i + 1; j < messages.length; j++) {
      const candidate = messages[j];
      if (candidate instanceof ToolMessage && (candidate as any).tool_call_id === reviewerCall.id) {
        boundaries.push(i);
        break;
      }
    }
  }

  return boundaries;
}

/**
 * Truncate a string to maxLen chars, appending a compression note.
 */
function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  const originalLen = content.length;
  return content.slice(0, maxLen) + `\n\n[... compressed from previous iteration — original was ${originalLen} chars]`;
}

/**
 * Compress old-iteration messages in-place.
 *
 * - Task ToolMessages from old iterations: truncate content
 * - AIMessages that called task in old iterations: truncate args.prompt
 * - Non-task ToolMessages from old iterations: replace with one-line summary
 * - Messages from the latest iteration boundary onward: untouched
 * - The first HumanMessage is always kept intact
 */
export function compressOldIterations(
  messages: BaseMessage[],
  latestBoundaryIndex: number,
  maxCompressedLength: number,
): void {
  // Collect all task tool_call_ids from old-iteration AIMessages (before the boundary)
  const taskToolCallIds = new Set<string>();
  for (let i = 0; i < latestBoundaryIndex; i++) {
    const msg = messages[i];
    if (msg instanceof AIMessage) {
      const taskCalls = findTaskToolCalls(msg);
      for (const tc of taskCalls) {
        taskToolCallIds.add(tc.id);
      }
    }
  }

  for (let i = 0; i < latestBoundaryIndex; i++) {
    const msg = messages[i];

    // Skip the very first HumanMessage (seed message)
    if (i === 0 && !(msg instanceof AIMessage) && !(msg instanceof ToolMessage)) {
      continue;
    }

    if (msg instanceof AIMessage) {
      // Truncate the prompt arg in task tool calls
      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc.name === 'task' && tc.args) {
            const args = typeof tc.args === 'string' ? (() => { try { return JSON.parse(tc.args); } catch { return null; } })() : tc.args;
            if (args && typeof args === 'object' && typeof args.prompt === 'string' && args.prompt.length > 200) {
              args.prompt = args.prompt.slice(0, 200) + '\n\n[... prompt truncated from previous iteration]';
              // If args was a parsed object, it's mutated in-place. If it was originally a string, reassign.
              if (typeof tc.args === 'string') {
                tc.args = JSON.stringify(args);
              }
            }
          }
        }
      }
    } else if (msg instanceof ToolMessage) {
      const toolCallId = (msg as any).tool_call_id;
      if (taskToolCallIds.has(toolCallId)) {
        // Task ToolMessage: truncate content
        if (typeof msg.content === 'string') {
          (msg as any).content = truncateContent(msg.content, maxCompressedLength);
        }
      } else {
        // Non-task ToolMessage (check_ci_status, list_repo_files, etc.): replace entirely
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          (msg as any).content = '[Previous iteration tool result cleared]';
        }
      }
    }
  }
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Creates middleware that compresses old iteration messages before each model call.
 *
 * After each completed review-fix cycle, previous cycles' task tool responses are
 * truncated so the Architect retains critical facts but sheds verbosity.
 */
export function createIterationPruningMiddleware(opts?: IterationPruningOptions) {
  const maxCompressedLength = opts?.maxCompressedLength ?? 500;

  return createMiddleware({
    name: 'IterationPruningMiddleware',
    wrapModelCall: async (request, handler) => {
      const { messages } = request;

      const boundaries = findIterationBoundaries(messages);

      // Only compress when there are >= 2 completed iterations
      if (boundaries.length >= 2) {
        // The latest boundary is the last one — everything before it is "old"
        const latestBoundaryIndex = boundaries[boundaries.length - 1];
        compressOldIterations(messages, latestBoundaryIndex, maxCompressedLength);
      }

      return handler(request);
    },
  });
}
