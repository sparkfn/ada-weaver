import { tool } from 'langchain';
import type { ToolCallCounter } from './github-tools.js';

/**
 * Format a timestamp as HH:MM:SS for log output.
 */
function formatTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

/**
 * Format milliseconds as a human-readable duration string.
 *
 * Examples: "450ms", "13s", "2m 5s", "3m"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

/**
 * Log an agent lifecycle event with timestamp and formatted details.
 *
 * Output: [HH:MM:SS] ─── AGENT action ─── "truncated detail..."
 */
export function logAgentEvent(agent: string, action: string, detail?: string): void {
  const timestamp = formatTime(new Date());
  const detailStr = detail
    ? ` "${detail.slice(0, 50)}${detail.length > 50 ? '...' : ''}"`
    : '';
  console.log(`[${timestamp}] \u2500\u2500\u2500 ${agent.toUpperCase()} ${action} \u2500\u2500\u2500${detailStr}`);
}

/**
 * Log a multi-line block of agent input or output with a labelled border.
 *
 * Used to show:
 * - Architect's instructions (prompt) when delegating to a subagent
 * - Subagent's response when it completes
 *
 * Output is truncated at `maxLines` and long lines are capped at 120 chars.
 */
export function logAgentDetail(label: string, content: string, maxLines = 20): void {
  const lines = content.split('\n');
  const display = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;

  console.log(`  \x1b[2m┌─ ${label}\x1b[0m`);
  for (const line of display) {
    const trimmed = line.length > 120 ? line.slice(0, 117) + '...' : line;
    console.log(`  \x1b[2m│\x1b[0m ${trimmed}`);
  }
  if (truncated) {
    console.log(`  \x1b[2m│\x1b[0m \x1b[33m... (${lines.length - maxLines} more lines)\x1b[0m`);
  }
  console.log(`  \x1b[2m└${'─'.repeat(40)}\x1b[0m`);
}

// ── ANSI colours for terminal diff output ────────────────────────────────────

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

/**
 * Log a unified diff to the console with GitHub-style ANSI colouring.
 *
 * - File headers (`diff --git`, `---`, `+++`) → cyan
 * - Hunk headers (`@@`)                       → yellow
 * - Additions (`+`)                           → green
 * - Deletions (`-`)                           → red
 * - Context lines                             → dim
 *
 * Large diffs are capped at `maxLines` (default 200) to avoid flooding the
 * terminal.
 */
export function logDiff(diff: string, maxLines = 200): void {
  const lines = diff.split('\n');
  const capped = lines.length > maxLines;
  const display = capped ? lines.slice(0, maxLines) : lines;

  console.log('');
  console.log(`${CYAN}┌${'─'.repeat(58)}┐${RESET}`);
  console.log(`${CYAN}│${RESET}  📝 Code Changes (diff)${' '.repeat(33)}${CYAN}│${RESET}`);
  console.log(`${CYAN}└${'─'.repeat(58)}┘${RESET}`);

  for (const line of display) {
    if (line.startsWith('diff --git')) {
      // File boundary — blank line then header
      console.log('');
      console.log(`${CYAN}${line}${RESET}`);
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      console.log(`${CYAN}${line}${RESET}`);
    } else if (line.startsWith('@@')) {
      console.log(`${YELLOW}${line}${RESET}`);
    } else if (line.startsWith('+')) {
      console.log(`${GREEN}${line}${RESET}`);
    } else if (line.startsWith('-')) {
      console.log(`${RED}${line}${RESET}`);
    } else {
      console.log(`${DIM}${line}${RESET}`);
    }
  }

  if (capped) {
    console.log(`\n${YELLOW}... diff truncated (showing ${maxLines} of ${lines.length} lines)${RESET}`);
  }
  console.log('');
}

/**
 * Wrap a LangChain tool with structured logging.
 *
 * Logs: timestamp, running tool count / limit, tool name, arguments, and duration.
 * Follows the same wrapping pattern as wrapWithCircuitBreaker.
 *
 * If a ToolCallCounter is provided, the log shows "TOOL #N/M" headroom.
 * If not, the log shows "TOOL" without a count.
 *
 * Errors are logged with context before being returned to the LLM.
 * Tool responses are NOT logged (they are too large and verbose).
 */
export function wrapWithLogging<T extends ReturnType<typeof tool>>(
  wrappedTool: T,
  counter?: ToolCallCounter,
): T {
  const originalInvoke = wrappedTool.invoke.bind(wrappedTool);

  wrappedTool.invoke = async (input: any, options?: any) => {
    const start = performance.now();
    const timestamp = formatTime(new Date());

    // Build the count label: "#7/30" if counter is available, empty otherwise
    const countLabel = counter
      ? ` #${counter.getCount() + 1}/${counter.limit}`
      : '';

    // Stringify the arguments (compact, single line)
    let argsStr: string;
    try {
      argsStr = JSON.stringify(input);
    } catch {
      argsStr = String(input);
    }

    try {
      const result = await originalInvoke(input, options);
      const durationMs = Math.round(performance.now() - start);
      console.log(
        `[${timestamp}] TOOL${countLabel} | ${wrappedTool.name} | ${argsStr} | ${durationMs}ms`,
      );
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      console.error(
        `[${timestamp}] TOOL${countLabel} | ${wrappedTool.name} | ${argsStr} | ${durationMs}ms | ERROR: ${error}`,
      );
      throw error;
    }
  };

  return wrappedTool;
}
