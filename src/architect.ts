import { createSubAgentMiddleware, createPatchToolCallsMiddleware } from 'deepagents';
import type { SubAgent } from 'deepagents';
import { createAgent, anthropicPromptCachingMiddleware, summarizationMiddleware } from 'langchain';
import type { Config } from './config.js';
import { createModel } from './model.js';
import {
  createGitHubClient,
  getAuthFromConfig,
  createGitHubIssuesTool,
  createCommentOnIssueTool,
  createPullRequestTool,
  createDryRunCommentTool,
  createDryRunPullRequestTool,
  createFetchSubIssuesTool,
  createGetParentIssueTool,
  createCreateSubIssueTool,
  createDryRunCreateSubIssueTool,
  createGetPrDiffTool,
  createSubmitPrReviewTool,
  createCheckCiStatusTool,
  createDryRunCheckCiStatusTool,
} from './github-tools.js';
import {
  createLocalReadFileTool,
  createLocalListFilesTool,
  createLocalGrepTool,
  createLocalEditFileTool,
  createLocalWriteFileTool,
  createLocalBashTool,
  createDryRunEditFileTool,
  createDryRunWriteFileTool,
  createDryRunBashTool,
} from './local-tools.js';
import { createWorkspace, resolveGitToken } from './workspace.js';
import type { Workspace } from './workspace.js';
import { formatDuration, logAgentEvent, logAgentDetail, logDiff } from './logger.js';
import { createIterationPruningMiddleware } from './context-pruning.js';
import { createContextCompactionMiddleware } from './context-compaction.js';
import { buildReviewerSystemPrompt } from './reviewer-agent.js';
import { ToolCache, wrapDiffWithDelta, prDiffKey } from './tool-cache.js';
import { findPrForIssue, findAllPrsForIssue } from './core.js';
import type { Octokit } from 'octokit';
import type { ProgressUpdate } from './process-manager.js';
import type { UsageService } from './usage-service.js';
import type { AgentRole, LLMProvider } from './usage-types.js';
import type { IssueContextRepository } from './issue-context-repository.js';
import { createSaveContextTool, createGetContextTool, createSearchPastIssuesTool } from './context-tools.js';
import { wrapWithOutputCap } from './tool-output-cap.js';

// ── Result interface ────────────────────────────────────────────────────────

export interface ArchitectResult {
  issueNumber: number;
  prNumber: number | null;
  prNumbers: number[];
  outcome: string;
  cacheStats?: { hits: number; misses: number; invalidations: number; size: number; hitRate: string };
}

interface SubagentRun {
  subagentType: string;
  startTime: number;
  label: string;
}

// ── LLM content extraction ───────────────────────────────────────────────────

/**
 * Extract the text portion from an LLM response content field.
 *
 * Handles both formats:
 * - Plain string: `"Based on the brief..."`
 * - Array of content blocks: `[{ type: 'text', text: '...' }, { type: 'tool_use', ... }]`
 */
export function extractTextContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('\n');
  }
  return '';
}

/**
 * Extract the meaningful text response from a subagent's tool output.
 *
 * The raw output from LangGraph's `task` tool is a Command object:
 * ```
 * {
 *   lg_name: "Command",
 *   update: {
 *     files: {},
 *     messages: [{
 *       lc: 1, type: "constructor",
 *       id: ["langchain_core", "messages", "ToolMessage"],
 *       kwargs: { content: "The actual agent response text...", ... }
 *     }]
 *   }
 * }
 * ```
 *
 * This function digs into that structure to return the `kwargs.content` string.
 * Falls back to plain string output if the structure is different.
 */
export function extractSubagentResponse(output: any): string {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object') return '';

  // LangGraph Command: output.update.messages[].kwargs.content
  const messages = output?.update?.messages;
  if (Array.isArray(messages)) {
    const contents = messages
      .map((msg: any) => {
        const content = msg?.kwargs?.content;
        if (typeof content === 'string') return content;
        // content could also be an array of blocks
        return extractTextContent(content);
      })
      .filter(Boolean);
    if (contents.length > 0) return contents.join('\n\n');
  }

  // Direct messages array (no update wrapper)
  if (Array.isArray(output?.messages)) {
    const contents = output.messages
      .map((msg: any) => {
        const content = msg?.kwargs?.content ?? msg?.content;
        if (typeof content === 'string') return content;
        return extractTextContent(content);
      })
      .filter(Boolean);
    if (contents.length > 0) return contents.join('\n\n');
  }

  // Fallback: if it has a content field directly
  if (typeof output.content === 'string') return output.content;

  return '';
}

// ── Event input extraction ───────────────────────────────────────────────────

/**
 * Extract subagent_type and description from a streamEvents `on_tool_start`
 * event's data payload.  The structure varies across LangGraph / deepagents
 * versions — try multiple paths before falling back to 'unknown'.
 */
export function extractTaskInput(data: any): { subagentType: string; description: string; prompt: string } {
  const tryExtract = (obj: any): { subagentType: string; description: string; prompt: string } | null => {
    if (obj && typeof obj === 'object' && typeof obj.subagent_type === 'string') {
      return { subagentType: obj.subagent_type, description: obj.description ?? '', prompt: obj.prompt ?? '' };
    }
    return null;
  };

  const tryParse = (val: any): Record<string, any> | null => {
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return null; }
    }
    return null;
  };

  // LangGraph's on_tool_start sets ev.data = { input: run.inputs }
  // where run.inputs = { input: JSON.stringify(toolArgs) }.
  // So the actual path is: ev.data.input.input → JSON string of tool args.
  const raw = data?.input;

  // 1. Direct object: data.input = { subagent_type, description }
  const direct = tryExtract(raw);
  if (direct) return direct;

  // 2. JSON string: data.input = '{"subagent_type":"...","description":"..."}'
  const parsed = tryParse(raw);
  if (parsed) {
    const fromParsed = tryExtract(parsed);
    if (fromParsed) return fromParsed;
  }

  // 3–5: Nested structures within data.input (object with sub-keys)
  if (raw && typeof raw === 'object') {
    // 3. data.input.args = { subagent_type, description }
    const fromArgs = tryExtract(raw.args);
    if (fromArgs) return fromArgs;

    // 3b. data.input.args is a JSON string
    const parsedArgs = tryParse(raw.args);
    if (parsedArgs) {
      const fromParsedArgs = tryExtract(parsedArgs);
      if (fromParsedArgs) return fromParsedArgs;
    }

    // 4. data.input.input = { subagent_type, description }
    const fromNested = tryExtract(raw.input);
    if (fromNested) return fromNested;

    // 4b. data.input.input is a JSON string (LangGraph's actual format:
    //     handleToolStart stringifies args, BaseTracer wraps as { input: str })
    const parsedNested = tryParse(raw.input);
    if (parsedNested) {
      const fromParsedNested = tryExtract(parsedNested);
      if (fromParsedNested) return fromParsedNested;
    }

    // 5. data.input.tool_input = { subagent_type, description }
    const fromToolInput = tryExtract(raw.tool_input);
    if (fromToolInput) return fromToolInput;

    const parsedToolInput = tryParse(raw.tool_input);
    if (parsedToolInput) {
      const fromParsedToolInput = tryExtract(parsedToolInput);
      if (fromParsedToolInput) return fromParsedToolInput;
    }
  }

  // 6. Fallback: search the entire data object for subagent_type
  //    Handle escaped quotes from nested JSON strings (\\")
  try {
    const json = JSON.stringify(data ?? {});
    const match = json.match(/\\?"subagent_type\\?"\s*:\s*\\?"(\w+)\\?"/);
    if (match) {
      const descMatch = json.match(/\\?"description\\?"\s*:\s*\\?"([^"\\]{0,200})\\?"/);
      const promptMatch = json.match(/\\?"prompt\\?"\s*:\s*\\?"([^"\\]{0,500})\\?"/);
      return { subagentType: match[1], description: descMatch?.[1] ?? '', prompt: promptMatch?.[1] ?? '' };
    }
  } catch { /* stringify can fail on circular refs */ }

  // Debug: log the actual structure when we can't find subagent_type
  console.warn(`⚠️  Could not extract subagent_type from task event data. Raw keys: ${
    raw && typeof raw === 'object' ? Object.keys(raw).join(', ') : typeof raw
  }. Full data keys: ${
    data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data
  }`);

  return { subagentType: 'unknown', description: '', prompt: '' };
}

// ── Subagent builders ────────────────────────────────────────────────────────

/**
 * Create the Issuer subagent — understands issues, explores repo, produces a brief,
 * and posts a formatted analysis comment on the issue.
 */
export function createIssuerSubagent(
  owner: string,
  repo: string,
  octokit: Octokit,
  opts: { dryRun?: boolean; model?: ReturnType<typeof createModel>; workspacePath: string; contextTools?: ReturnType<typeof tool>[] },
): SubAgent {
  const dryRun = opts.dryRun ?? false;
  const ws: Workspace = { path: opts.workspacePath, cleanup: async () => {} };

  const tools = [
    createGitHubIssuesTool(owner, repo, octokit),
    createLocalListFilesTool(ws),
    createLocalReadFileTool(ws),
    createLocalGrepTool(ws),
    createFetchSubIssuesTool(owner, repo, octokit),
    createGetParentIssueTool(owner, repo, octokit),
    dryRun ? createDryRunCommentTool() : createCommentOnIssueTool(owner, repo, octokit),
    ...(opts.contextTools ?? []),
  ].map(t => wrapWithOutputCap(t));

  const systemPrompt = `You are the Issuer agent for the GitHub repository ${owner}/${repo}.

Your job is to thoroughly understand a GitHub issue, produce a brief for the team, and post a formatted analysis comment on the issue itself.

You have local filesystem access to the repository clone. Use the local tools to explore files.

WORKFLOW:
1. Read the issue title, body, and labels
2. Check for sub-issues (fetch_sub_issues) and parent issue (get_parent_issue)
3. Use list_files to see the top-level repo structure. Then drill into the relevant directory with a path filter (e.g., path: "src/").
4. Use read_file to read 2-5 files relevant to the issue. Use grep to search for specific patterns.
5. Post your analysis as a comment on the issue using comment_on_issue (see format below)
6. Return your brief as your final message (the Architect will read it)

ISSUE COMMENT FORMAT:
Post a well-formatted Markdown comment on the issue using comment_on_issue. The comment should help the issue author and other developers understand the analysis at a glance:

\`\`\`markdown
## 🔍 Issue Analysis

**Type:** \`feature\` | **Complexity:** \`moderate\`

### Summary
<1-2 sentence plain-language summary of what is being asked>

### Relevant Files
- \`src/path/to/file.ts\` — <why this file is relevant>
- \`src/path/to/other.ts\` — <why this file is relevant>

### Recommended Approach
1. <step one>
2. <step two>
3. <step three>

### Additional Context
<sub-issue relationships, base branch notes, or anything else relevant>

---
*🤖 Automated analysis by Deep Agents*
\`\`\`

YOUR BRIEF (returned as your final message) MUST INCLUDE:
- Issue summary: what is being asked for
- Issue type: bug, feature, docs, question, or unknown
- Complexity: trivial, simple, moderate, or complex
- Relevant files: which files need to change and why
- Recommended approach: step-by-step plan for fixing/implementing
- Base branch: if the issue specifies a base branch (e.g. "base branch: develop", "branch: feature/x", or similar), include it. Otherwise default to "main"
- Whether to proceed: should the team work on this? If not, explain why
- Sub-issue context: if there are sub-issues or a parent, describe the relationship

CONSTRAINTS:
- Be thorough but concise. The Architect will use your brief to instruct the Coder.
- Your final message output is natural language, not JSON. Write clearly and specifically.
- Post the comment BEFORE returning your brief. The comment enriches the issue for humans; the brief is for the Architect.

TOOL USAGE:
- Use local tools for repo exploration: list_files, read_file, grep
- Use GitHub API tools for issue operations: fetch_github_issues, fetch_sub_issues, get_parent_issue, comment_on_issue

SHARED CONTEXT:
- After your analysis, save your brief with \`save_issue_context\` (entry_type: "issuer_brief"). Include the files you identified in files_touched.
- Use \`search_past_issues\` to check if similar issues have been resolved before — pass the relevant file paths to find overlap.`;

  return {
    name: 'issuer',
    description: 'Understands GitHub issues — explores the repo, reads relevant files, posts a formatted analysis comment on the issue, and produces a brief with issue summary, type, complexity, relevant files, and recommended approach.',
    systemPrompt,
    tools,
    ...(opts.model ? { model: opts.model } : {}),
  };
}

/**
 * Create the Coder subagent — implements changes (branches, commits, PRs).
 * Has read + write tools. Respects dry-run mode.
 */
export function createCoderSubagent(
  owner: string,
  repo: string,
  octokit: Octokit,
  opts: { dryRun?: boolean; model?: ReturnType<typeof createModel>; workspacePath: string; contextTools?: ReturnType<typeof tool>[] },
): SubAgent {
  const dryRun = opts.dryRun ?? false;
  const ws: Workspace = { path: opts.workspacePath, cleanup: async () => {} };

  const tools = [
    createLocalListFilesTool(ws),
    createLocalReadFileTool(ws),
    createLocalGrepTool(ws),
    dryRun ? createDryRunEditFileTool() : createLocalEditFileTool(ws),
    dryRun ? createDryRunWriteFileTool() : createLocalWriteFileTool(ws),
    dryRun ? createDryRunBashTool() : createLocalBashTool(ws),
    dryRun ? createDryRunCommentTool() : createCommentOnIssueTool(owner, repo, octokit),
    dryRun ? createDryRunPullRequestTool() : createPullRequestTool(owner, repo, octokit),
    dryRun ? createDryRunCreateSubIssueTool() : createCreateSubIssueTool(owner, repo, octokit),
    ...(opts.contextTools ?? []),
  ].map(t => wrapWithOutputCap(t));

  const systemPrompt = `You are the Coder agent for the GitHub repository ${owner}/${repo}.

Your job is to implement changes based on the Architect's instructions.

You have local filesystem access to a clone of the repository. Use local tools for reading, searching, and editing files. Use git via bash for branching, committing, and pushing. Use GitHub API tools for PRs, comments, and sub-issues.

IMPORTANT: You MUST complete the PLANNING PHASE before writing any code.

═══════════════════════════════════════
PHASE 1: PLANNING (mandatory, do this FIRST)
═══════════════════════════════════════

Before making ANY changes, you must:
1. Call \`get_issue_context\` to read the Issuer's brief — it lists relevant files already analyzed. Do NOT re-explore files the Issuer already identified.
2. Use list_files ONLY if you need to find files not covered by the Issuer's brief.
3. Use grep to find specific code patterns. For files >100 lines, grep first to find relevant line numbers, then use read_file with start_line/end_line to read only those sections.
4. Identify existing patterns, conventions, imports, and dependencies
5. Produce an EXECUTION PLAN as a numbered list:
   - Which files to create or modify, and in what order
   - For each file: what specific changes to make and why
   - What existing patterns to follow (naming, structure, imports)
   - Dependencies between changes (e.g. "create utility before using it in handler")
   - If tests are requested: which test patterns to follow, what to cover

Output your plan clearly before proceeding. Example:
  "EXECUTION PLAN:
   1. Modify src/validator.ts — add amountToPay range check after line 45, following the existing validateField() pattern
   2. Modify src/types.ts — add PaymentValidationError to the error union type
   3. Create tests/validator.test.ts — test valid amounts, zero, negative, and overflow cases using the existing vitest + describe/it pattern
   4. Update src/handler.ts — wire the new validation into the payment flow at the processPayment() entry point"

Do NOT skip the planning phase. Do NOT start creating branches or committing files until you have a plan.

═══════════════════════════════════════
PHASE 2: EXECUTION
═══════════════════════════════════════

WORKFLOW FOR NEW ISSUES:
1. Post a summary comment on the issue using comment_on_issue (include your execution plan)
2. Create and switch to a branch via bash:
   \`\`\`
   bash: git checkout -b issue-<number>-<short-description>
   \`\`\`
   - If the Architect specifies a base branch, first: \`git checkout <base_branch> && git checkout -b issue-<number>-<short-description>\`
3. Make changes using edit_file (for surgical edits to existing files) or write_file (for new files or full rewrites)
   - Prefer edit_file over write_file for existing files — it's surgical and preserves surrounding code
   - Use read_file first to see current content before editing
4. Commit and push via bash:
   \`\`\`
   bash: git add -A && git commit -m "Fix #<number>: <description>" && git push origin HEAD
   \`\`\`
5. Self-review: use read_file to verify your changes
6. Open a PR with title "Fix #<number>: <description>" using create_pull_request
   - If a base branch was specified, set the base parameter to match (e.g. base: "develop")
   - Body must contain "Closes #<number>" on its own line
   - Include your execution plan and a "## Self-Review" section noting what you checked

WORKFLOW FOR FIX ITERATIONS (when told to fix reviewer feedback):
- The branch and PR ALREADY EXIST. Do NOT create new ones.
- Do NOT post a new comment on the issue.
- Do NOT re-run list_files or re-explore the codebase. You already know the repo structure.
- Read ONLY the specific lines mentioned in the reviewer's feedback using grep and read_file with start_line/end_line.
- List the specific fixes, then apply them with edit_file and commit+push:
   \`\`\`
   bash: git add -A && git commit -m "Address review feedback for #<number>" && git push origin HEAD
   \`\`\`
- Use read_file to verify your changes after committing.

CONSTRAINTS:
- Always create the branch BEFORE making changes, and push BEFORE opening the PR
- Never merge PRs — only open them
- Use edit_file for targeted changes; write_file only for new files or complete rewrites
- Base your changes on actual file content from read_file, not assumptions
- If adding new dependencies, explain why in the PR body

CODE QUALITY GUIDELINES:
- Prefer existing patterns and dependencies in the codebase
- Use clear commit messages like "Fix #<number>: improve README structure"
- You MUST commit and push at least one change so the PR has a real diff

SUB-ISSUE SUPPORT:
- If instructed about sub-issues, use create_sub_issue to break down parent issues
- Create a SINGLE branch and PR addressing parent and all sub-issues
- In the PR body, reference all sub-issue numbers ("Addresses #10, #11, #12")

TESTING GUIDELINES (only when instructed by the Architect):
- When the Architect tells you to write tests, write or update tests alongside source changes
- Use the same test framework and patterns already in the repo
- At minimum cover: happy path + one error/edge case
- If the repo has no existing tests, skip — do not introduce a test framework from scratch
- If the Architect does not mention tests, skip this section entirely

SHARED CONTEXT:
- Before planning, read shared context with \`get_issue_context\` to see the issuer's brief and architect's plan directly.
- Save your execution plan with \`save_issue_context\` (entry_type: "coder_plan"). Include the files you plan to modify in files_touched.`;

  return {
    name: 'coder',
    description: 'Implements code changes — creates branches, edits files, commits, pushes, and opens PRs. Can also fix reviewer feedback on existing branches.',
    systemPrompt,
    tools,
    ...(opts.model ? { model: opts.model } : {}),
  };
}

/**
 * Create the Reviewer subagent — reviews PRs, reads diffs, posts reviews.
 * Reuses buildReviewerSystemPrompt from reviewer-agent.ts.
 */
export function createReviewerSubagent(
  owner: string,
  repo: string,
  octokit: Octokit,
  model?: ReturnType<typeof createModel>,
  opts?: { workspacePath: string; cache?: ToolCache; contextTools?: ReturnType<typeof tool>[] },
): SubAgent {
  const ws: Workspace = { path: opts?.workspacePath ?? '', cleanup: async () => {} };

  let diffTool = createGetPrDiffTool(octokit, owner, repo);
  if (opts?.cache) {
    diffTool = wrapDiffWithDelta(diffTool, opts.cache, { extractKey: prDiffKey });
  }

  const tools = [
    diffTool,
    createLocalListFilesTool(ws),
    createLocalReadFileTool(ws),
    createLocalGrepTool(ws),
    createSubmitPrReviewTool(octokit, owner, repo),
    ...(opts?.contextTools ?? []),
  ].map(t => wrapWithOutputCap(t));

  let systemPrompt = buildReviewerSystemPrompt(owner, repo);

  systemPrompt += `\n\nLOCAL TOOLS:
You have local filesystem access to the repository clone. Use read_file and grep to read source files for context during review, in addition to the PR diff.

TOKEN-EFFICIENT READING:
- Read ONLY files that appear in the PR diff — do not explore unrelated files.
- Use start_line/end_line to read just the surrounding context of changed lines (±30 lines), not entire files.
- For files >100 lines, use grep first to find the relevant sections, then read only those ranges.

SHARED CONTEXT:
- Read the coder's plan with \`get_issue_context\` before reviewing — understand what was intended before judging the diff.
- Save your feedback with \`save_issue_context\` (entry_type: "review_feedback"). Include the files you reviewed in files_touched.`;

  return {
    name: 'reviewer',
    description: 'Reviews pull requests — fetches the diff, reads source files for context, and posts a structured review with verdict (resolved/needs_changes) and actionable feedback items.',
    systemPrompt,
    tools,
    ...(model ? { model } : {}),
  };
}

// ── Architect system prompt ──────────────────────────────────────────────────

export function buildArchitectSystemPrompt(
  owner: string,
  repo: string,
  maxIterations: number,
): string {
  return `You are the Architect — the supervising agent for the GitHub repository ${owner}/${repo}.

You coordinate a team of specialist agents to process GitHub issues end-to-end. You make ALL decisions about workflow, delegation, and when to stop.

YOUR TEAM:
- **issuer**: Understands issues. Give it an issue number and it produces a brief (summary, type, complexity, relevant files, recommended approach, whether to proceed).
- **coder**: Implements changes using local filesystem tools and git. Give it specific instructions based on the Issuer's brief. It edits files locally, commits and pushes via git, and opens PRs via the GitHub API.
- **reviewer**: Reviews PRs. Give it a PR number and it reviews the diff, posts feedback, and returns a verdict (resolved or needs_changes with specific feedback items).

STANDARD WORKFLOW:
1. Delegate to issuer: "Analyze issue #N — read the issue, explore the repo, and produce a brief."
2. Read the Issuer's brief. Decide whether to proceed:
   - If the issue is a question, too vague, or not actionable → report that and stop.
   - If the issue should be addressed → continue.
3. Evaluate whether the change warrants tests:
   - For logic/feature changes (APIs, auth, data processing, algorithms): instruct the Coder to write tests alongside the implementation.
   - For cosmetic/docs changes (README, UI colors, config tweaks): skip tests.
4. Delegate to coder with SPECIFIC instructions derived from the brief:
   - Tell it which files to modify and what changes to make
   - Include the issue number and any sub-issue context
   - If the Issuer's brief specifies a base branch, tell the coder: "Create the branch from <base_branch>"
   - If tests are warranted, tell the coder: "Write tests for this change"
   - For first implementation: tell it to create branch, commit, and open PR
5. Delegate to reviewer: "Review PR #N"
6. After review, check CI if tests were written or CI is already configured:
   - Use check_ci_status to verify CI results on the PR
   - If overall is "in_progress", wait and recheck (up to 2 rechecks)
   - If overall is "failure", collect failure details and feed them to the Coder alongside reviewer feedback
   - If overall is "success" or "no_checks", proceed normally
7. If the reviewer's verdict is "needs_changes" or CI failed, and you haven't hit the iteration limit:
   - Delegate back to coder with the reviewer's feedback and/or CI failure details
   - Tell it: "Fix the feedback on branch X for PR #N. Do NOT create a new branch or PR."
   - Then delegate to reviewer again (and recheck CI if applicable)
8. Report the final outcome

PARALLEL EXECUTION — RESTRICTED:
Do NOT use parallel delegation unless the issue has explicit sub-issues returned by fetch_sub_issues.
For a single issue (no sub-issues), ALWAYS use the standard sequential workflow: one issuer → one coder → one reviewer.
Parallel delegation wastes tokens and risks creating duplicate PRs with wrong issue references.
Only when fetch_sub_issues returns multiple truly independent sub-tasks may you delegate to multiple coders, each on a different branch.

ITERATION LIMIT: ${maxIterations} review→fix cycles maximum. After that, report the current state.

CRITICAL RULES:
- You DECIDE the workflow. You can skip steps, reorder, or stop based on judgment.
- You have read-only tools for verification: use them to check issue status or repo state.
- ALWAYS use the task tool to delegate. Never try to write code or post comments yourself.
- When delegating to coder, ALWAYS include the exact issue number: "Fix issue #N". The coder must use this number in the branch name (issue-N-...) and PR title (Fix #N: ...). Never let the coder guess or infer the issue number.
- When delegating to coder for fixes, always specify the existing branch name and PR number.
- Only ONE coder delegation per issue unless there are explicit sub-issues. Never split a single issue into multiple PRs.
- Your final message should be a clear summary of what was done and the outcome.
- All subagents have local filesystem access to the repo clone. They use local tools (list_files, read_file, grep, edit_file, write_file, bash) plus GitHub API tools (create_pull_request, comment_on_issue, etc.).

AVAILABLE TOOLS FOR VERIFICATION (read-only):
- fetch_github_issues: Check issue details
- list_files: Browse repo structure (local filesystem)
- read_file: Read file contents (local filesystem)
- grep: Search for patterns across the codebase (local filesystem)
- check_ci_status: Check CI/check-run results for a PR (returns success, failure, in_progress, or no_checks)

SHARED CONTEXT:
- Use \`save_issue_context\` to record your plan (entry_type: "architect_plan") before delegating to subagents.
- Use \`search_past_issues\` before planning to check if similar issues have been resolved before — pass relevant file paths for overlap search.
- All subagents can read shared context with \`get_issue_context\`. Their outputs are also auto-captured.`;
}

// ── Architect factory ────────────────────────────────────────────────────────

export async function createArchitect(
  config: Config,
  options: {
    dryRun?: boolean;
    maxIterations?: number;
    issueNumber?: number;
    processId?: string | null;
    contextRepo?: IssueContextRepository;
    repoId?: number;
    continueContext?: ContinueContext;
  } = {},
) {
  const { owner, repo } = config.github;
  const auth = getAuthFromConfig(config.github);
  const octokit = createGitHubClient(auth);

  const maxIterations = options.maxIterations ?? 3;

  // Resolve git token and create workspace
  const gitToken = await resolveGitToken(auth);
  const workspace = await createWorkspace(owner, repo, gitToken, {
    branch: options.continueContext?.branchName,
    processId: options.processId ?? undefined,
  });
  console.log(`\u{1F4C2} Workspace cloned to ${workspace.path}`);

  // Models for each subagent (fall back to main LLM)
  const issuerModel = config.issuerLlm
    ? createModel({ ...config, llm: config.issuerLlm })
    : undefined;

  const coderModel = config.coderLlm
    ? createModel({ ...config, llm: config.coderLlm })
    : undefined;

  const reviewerModel = config.reviewerLlm
    ? createModel({ ...config, llm: config.reviewerLlm })
    : undefined;

  // Shared cache (only used for reviewer PR diff delta computation)
  const cache = new ToolCache();

  // Build per-agent context tools (if contextRepo is provided)
  const ctxRepo = options.contextRepo;
  const ctxRepoId = options.repoId ?? 0;
  const ctxIssue = options.issueNumber ?? 0;
  const ctxProcess = options.processId ?? null;

  let issuerContextTools: ReturnType<typeof tool>[] | undefined;
  let coderContextTools: ReturnType<typeof tool>[] | undefined;
  let reviewerContextTools: ReturnType<typeof tool>[] | undefined;
  let architectContextTools: ReturnType<typeof tool>[] = [];

  if (ctxRepo && ctxIssue > 0) {
    issuerContextTools = [
      createSaveContextTool(ctxRepo, ctxRepoId, ctxIssue, ctxProcess, 'issuer'),
      ...(ctxProcess ? [createGetContextTool(ctxRepo, ctxProcess)] : []),
      createSearchPastIssuesTool(ctxRepo, ctxRepoId, ctxIssue),
    ];
    coderContextTools = [
      createSaveContextTool(ctxRepo, ctxRepoId, ctxIssue, ctxProcess, 'coder'),
      ...(ctxProcess ? [createGetContextTool(ctxRepo, ctxProcess)] : []),
    ];
    reviewerContextTools = [
      createSaveContextTool(ctxRepo, ctxRepoId, ctxIssue, ctxProcess, 'reviewer'),
      ...(ctxProcess ? [createGetContextTool(ctxRepo, ctxProcess)] : []),
    ];
    architectContextTools = [
      createSaveContextTool(ctxRepo, ctxRepoId, ctxIssue, ctxProcess, 'architect'),
      ...(ctxProcess ? [createGetContextTool(ctxRepo, ctxProcess)] : []),
      createSearchPastIssuesTool(ctxRepo, ctxRepoId, ctxIssue),
    ];
  }

  // Build subagents with workspace path
  const subagents = [
    createIssuerSubagent(owner, repo, octokit, { dryRun: options.dryRun, model: issuerModel, workspacePath: workspace.path, contextTools: issuerContextTools }),
    createCoderSubagent(owner, repo, octokit, { dryRun: options.dryRun, model: coderModel, workspacePath: workspace.path, contextTools: coderContextTools }),
    createReviewerSubagent(owner, repo, octokit, reviewerModel, { workspacePath: workspace.path, cache, contextTools: reviewerContextTools }),
  ];

  // Architect's own local tools for verification
  const architectWs: Workspace = { path: workspace.path, cleanup: async () => {} };
  const architectTools = [
    createGitHubIssuesTool(owner, repo, octokit),
    createLocalListFilesTool(architectWs),
    createLocalReadFileTool(architectWs),
    createLocalGrepTool(architectWs),
    options.dryRun ? createDryRunCheckCiStatusTool() : createCheckCiStatusTool(owner, repo, octokit),
    ...architectContextTools,
  ].map(t => wrapWithOutputCap(t));

  const systemPrompt = buildArchitectSystemPrompt(owner, repo, maxIterations);
  const model = createModel(config);

  // Lean subagent middleware — no todoList or filesystem (those add duplicate tools)
  const subagentMiddleware = [
    createContextCompactionMiddleware(),
    summarizationMiddleware({ model, trigger: { tokens: 50_000 }, keep: { messages: 6 } }),
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: 'ignore' }),
    createPatchToolCallsMiddleware(),
  ];

  const agent = createAgent({
    model,
    tools: architectTools,
    systemPrompt,
    middleware: [
      createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: architectTools,
        defaultMiddleware: subagentMiddleware,
        generalPurposeMiddleware: subagentMiddleware,
        subagents,
        generalPurposeAgent: false,
      }),
      summarizationMiddleware({ model, trigger: { tokens: 50_000 }, keep: { messages: 6 } }),
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: 'ignore' }),
      createPatchToolCallsMiddleware(),
      createIterationPruningMiddleware(),
    ],
  }).withConfig({ recursionLimit: 10_000 });

  return { agent, cache, workspace };
}

// ── LLM config resolver ──────────────────────────────────────────────────────

/**
 * Resolve the LLM provider and model for a given agent role based on config.
 */
export function resolveAgentLlmConfig(
  config: Config,
  agent: AgentRole,
): { provider: LLMProvider; model: string } {
  let llmConfig: { provider: string; model?: string | null } | undefined;

  switch (agent) {
    case 'issuer':
      llmConfig = config.issuerLlm ?? config.llm;
      break;
    case 'coder':
      llmConfig = config.coderLlm ?? config.llm;
      break;
    case 'reviewer':
      llmConfig = config.reviewerLlm ?? config.llm;
      break;
    default:
      llmConfig = config.llm;
  }

  return {
    provider: (llmConfig?.provider ?? config.llm.provider) as LLMProvider,
    model: llmConfig?.model ?? config.llm.model ?? 'unknown',
  };
}

// ── Usage summary formatting ─────────────────────────────────────────────────

/**
 * Format a Markdown comment summarizing LLM usage for a process run.
 * Returns null if there are no usage records.
 */
export async function formatUsageSummaryComment(usageService: UsageService, processId: string): Promise<string | null> {
  const summary = await usageService.summarize({ processId });
  if (summary.totalRecords === 0) return null;

  const agentBreakdown = await usageService.groupBy('agent', { processId });

  const lines: string[] = [
    '## 📊 Model Usage Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total tokens | ${summary.totalTokens.toLocaleString()} |`,
    `| Input tokens | ${summary.totalInputTokens.toLocaleString()} |`,
    `| Output tokens | ${summary.totalOutputTokens.toLocaleString()} |`,
    `| Total duration | ${formatDuration(summary.totalDurationMs)} |`,
    `| Estimated cost | $${summary.totalEstimatedCost.toFixed(4)} |`,
    `| LLM calls | ${summary.totalRecords} |`,
    '',
  ];

  if (agentBreakdown.length > 0) {
    lines.push(
      '### Per-Agent Breakdown',
      '',
      '| Agent | Tokens | Duration | Cost | Calls |',
      '|-------|--------|----------|------|-------|',
    );
    for (const group of agentBreakdown) {
      const s = group.summary;
      lines.push(
        `| ${group.key} | ${s.totalTokens.toLocaleString()} | ${formatDuration(s.totalDurationMs)} | $${s.totalEstimatedCost.toFixed(4)} | ${s.totalRecords} |`,
      );
    }
    lines.push('');
  }

  lines.push('---', '*Automated usage report by Deep Agents*');

  return lines.join('\n');
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Default max iterations for the review→fix cycle.
 */
const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Resolve the effective max iterations value from config.
 */
export function getMaxIterations(config: Config): number {
  const raw = config.maxIterations;
  return (typeof raw === 'number' && raw > 0) ? raw : DEFAULT_MAX_ITERATIONS;
}

/**
 * Run the Architect supervisor on a single issue.
 *
 * Uses streamEvents() to intercept subagent lifecycle events and log
 * which agent is active + what phase/iteration the pipeline is in.
 *
 * 1. Creates the Architect agent with subagents
 * 2. Streams events — logs subagent start/complete with iteration labels
 * 3. After completion, discovers PR via findPrForIssue (GitHub API)
 * 4. Returns ArchitectResult
 */
export interface ContinueContext {
  prNumber: number;
  branchName: string;
  humanFeedback?: string;
}

export async function runArchitect(
  config: Config,
  issueNumber: number,
  options: { dryRun?: boolean; onProgress?: (update: ProgressUpdate) => void; signal?: AbortSignal; continueContext?: ContinueContext; usageService?: UsageService; processId?: string; contextRepo?: IssueContextRepository; repoId?: number } = {},
): Promise<ArchitectResult> {
  const maxIterations = getMaxIterations(config);

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  if (options.continueContext) {
    console.log(`\u{1F504} Continuing issue #${issueNumber} — PR #${options.continueContext.prNumber} on branch ${options.continueContext.branchName}`);
  } else {
    console.log(`\u{1F3D7}\uFE0F  Architect processing issue #${issueNumber} (max ${maxIterations} review iterations)`);
  }
  // Single-agent mode: delegate to single-agent runner
  if (config.agentMode === 'single') {
    const { runSingleAgent } = await import('./single-agent.js');
    return runSingleAgent(config, issueNumber, options);
  }

  if (options.dryRun) {
    console.log('\u{1F9EA} DRY RUN MODE -- Coder subagent will skip GitHub writes');
  }
  console.log('');

  const { agent: architect, cache, workspace } = await createArchitect(config, {
    dryRun: options.dryRun,
    maxIterations,
    issueNumber,
    processId: options.processId,
    contextRepo: options.contextRepo,
    repoId: options.repoId,
    continueContext: options.continueContext,
  });

  // Octokit client for diff fetching after coder completes
  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  let userMessage: string;
  if (options.continueContext) {
    const { prNumber, branchName, humanFeedback } = options.continueContext;
    userMessage = `Continue working on issue #${issueNumber}. A PR #${prNumber} already exists on branch "${branchName}".

Skip the issuer step — go directly to the reviewer:
1. Delegate to reviewer: "Review PR #${prNumber}"
2. If the reviewer's verdict is "needs_changes", delegate to coder with the feedback: "Fix the feedback on branch ${branchName} for PR #${prNumber}. Do NOT create a new branch or PR."
3. Then delegate to reviewer again.
4. Repeat the review→fix cycle up to the iteration limit.
5. Report the final outcome.`;
    if (humanFeedback) {
      userMessage += `\n\nIMPORTANT — A human reviewer left the following feedback on this PR. Make sure the coder addresses this in addition to any reviewer feedback:\n\n${humanFeedback}`;
    }
  } else {
    userMessage = `Process issue #${issueNumber}. Delegate to your team to understand, implement, and review a fix for this issue.`;
  }

  console.log('='.repeat(60));

  // Subagent tracking state
  let reviewerCount = 0;
  let coderAfterReview = false;
  let coderFixCount = 0;
  const activeRuns = new Map<string, SubagentRun>();
  let lastResponse = '';
  let chatModelStartTime = 0;

  const stream = architect.streamEvents(
    { messages: [{ role: 'user', content: userMessage }] },
    { version: 'v2' },
  );

  try {
  for await (const ev of stream) {
    if (options.signal?.aborted) break;

    if (ev.event === 'on_tool_start' && ev.name === 'task') {
      // Extract subagent_type from the tool input — the structure varies
      // across LangGraph / deepagents versions, so try multiple paths.
      const { subagentType, description, prompt } = extractTaskInput(ev.data);
      const runId: string = ev.run_id ?? `run-${Date.now()}`;

      // Build iteration label
      let label = '';
      if (subagentType === 'reviewer') {
        reviewerCount++;
        label = ` [iteration ${reviewerCount}/${maxIterations}]`;
      } else if (subagentType === 'coder' && coderAfterReview) {
        coderFixCount++;
        label = ` [fix iteration ${coderFixCount}]`;
      }

      activeRuns.set(runId, { subagentType, startTime: performance.now(), label });

      // Show the Architect is orchestrating by logging "ARCHITECT → SUBAGENT"
      const instructionPreview = prompt || description;
      logAgentEvent('architect', `\u2192 ${subagentType.toUpperCase()}${label}`, instructionPreview);
      if (prompt) {
        logAgentDetail(`Architect instructions to ${subagentType}`, prompt);
      }
      options.onProgress?.({
        phase: subagentType,
        action: 'started',
        runId,
        iteration: reviewerCount || coderFixCount || undefined,
        maxIterations,
        detail: description,
      });
    } else if (ev.event === 'on_tool_end' && ev.name === 'task') {
      const runId: string = ev.run_id ?? '';
      const run = activeRuns.get(runId);
      if (run) {
        const duration = formatDuration(performance.now() - run.startTime);

        logAgentEvent(run.subagentType, `completed${run.label} (${duration})`);

        // Log the subagent's response content so the user can see what it did.
        // The raw output is a LangGraph Command object; the actual agent text is
        // at output.update.messages[].kwargs.content (ToolMessage).
        const agentResponse = extractSubagentResponse(ev.data?.output);
        if (agentResponse) {
          logAgentDetail(`${run.subagentType} output`, agentResponse);
        }

        // Auto-capture subagent output as context entry (reliability backstop)
        if (options.contextRepo && agentResponse && issueNumber > 0) {
          const entryTypeMap: Record<string, string> = {
            issuer: 'issuer_brief',
            coder: 'coder_plan',
            reviewer: 'review_feedback',
          };
          const autoEntryType = entryTypeMap[run.subagentType];
          if (autoEntryType) {
            options.contextRepo.addEntry({
              repoId: options.repoId ?? 0,
              issueNumber,
              processId: options.processId ?? null,
              entryType: autoEntryType as any,
              agent: `${run.subagentType}:auto`,
              content: agentResponse.slice(0, 10000),
              filesTouched: [],
              iteration: reviewerCount,
            }).catch(() => { /* best-effort auto-capture */ });
          }
        }

        options.onProgress?.({
          phase: run.subagentType,
          action: 'completed',
          runId,
          iteration: reviewerCount || coderFixCount || undefined,
          maxIterations,
        });

        // After the coder completes, fetch and display the PR diff
        if (run.subagentType === 'coder') {
          try {
            // Extract PR number from tool output or find via API
            let diffPrNumber: number | undefined;
            // Search for PR number in agent response text, falling back to raw output JSON
            const searchStr = agentResponse || JSON.stringify(ev.data?.output ?? '');
            const prMatch = searchStr.match(/PR\s*#(\d+)|pull\s*request\s*#?(\d+)|pull_number['":\s]+(\d+)/i);
            if (prMatch) {
              diffPrNumber = parseInt(prMatch[1] || prMatch[2] || prMatch[3], 10);
            }
            if (!diffPrNumber && options.continueContext) {
              diffPrNumber = options.continueContext.prNumber;
            }
            if (!diffPrNumber) {
              const prInfo = await findPrForIssue(config, issueNumber);
              diffPrNumber = prInfo?.prNumber;
            }

            if (diffPrNumber) {
              const { data } = await octokit.rest.pulls.get({
                owner,
                repo,
                pull_number: diffPrNumber,
                mediaType: { format: 'diff' },
              });
              const diff = data as unknown as string;
              if (diff) {
                logDiff(diff);
              }
            }
          } catch (diffErr) {
            console.warn(`\u{26A0}\uFE0F  Could not fetch diff after coder: ${diffErr}`);
          }
        }

        // After the first reviewer completes, subsequent coder calls are fix iterations
        if (run.subagentType === 'reviewer') {
          coderAfterReview = true;
        }

        activeRuns.delete(runId);
      }
    } else if (ev.event === 'on_chat_model_start') {
      chatModelStartTime = performance.now();
    } else if (ev.event === 'on_chat_model_end') {
      const content = ev.data?.output?.content;
      const textContent = extractTextContent(content);
      if (textContent) {
        lastResponse = textContent;
      }

      // Log the Architect's own reasoning (when no subagent is active)
      if (activeRuns.size === 0 && textContent) {
        logAgentEvent('architect', 'reasoning', textContent);
        options.onProgress?.({
          phase: 'architect',
          action: 'reasoning',
          detail: textContent.slice(0, 200),
        });
      }

      // Record usage metrics
      if (options.usageService) {
        try {
          let modelOutput = ev.data?.output;
          if (typeof modelOutput === 'string') {
            try { modelOutput = JSON.parse(modelOutput); } catch { /* keep as string */ }
          }
          const usage = modelOutput?.usage_metadata;
          if (usage) {
            const agentRole: AgentRole = (() => {
              if (activeRuns.size === 1) {
                const run = activeRuns.values().next().value!;
                return run.subagentType as AgentRole;
              }
              return 'architect';
            })();
            const responseModel = modelOutput?.response_metadata?.model;
            const llmConfig = resolveAgentLlmConfig(config, agentRole);
            const durationMs = chatModelStartTime > 0 ? performance.now() - chatModelStartTime : 0;
            options.usageService.record({
              provider: llmConfig.provider,
              model: responseModel ?? llmConfig.model,
              agent: agentRole,
              processId: options.processId,
              issueNumber,
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              durationMs,
            });
          }
        } catch { /* best-effort */ }
      }
    }
  }
  } finally {
    // Always clean up workspace
    console.log(`\u{1F9F9} Cleaning up workspace at ${workspace.path}`);
    await workspace.cleanup();
  }

  console.log('='.repeat(60));
  console.log('\n\u{2705} Architect completed!\n');

  // Auto-save outcome entry
  if (options.contextRepo && lastResponse && issueNumber > 0) {
    try {
      await options.contextRepo.addEntry({
        repoId: options.repoId ?? 0,
        issueNumber,
        processId: options.processId ?? null,
        entryType: 'outcome',
        agent: 'architect:auto',
        content: lastResponse.slice(0, 10000),
        filesTouched: [],
        iteration: reviewerCount,
      });
    } catch { /* best-effort */ }
  }

  // Log cache stats
  const stats = cache.getStats();
  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? ((stats.hits / total) * 100).toFixed(1) : '0.0';
  console.log(`\u{1F4BE} Cache stats: ${stats.hits} hits, ${stats.misses} misses (${hitRate}% hit rate), ${stats.invalidations} invalidations, ${stats.size} entries`);

  const outcome = lastResponse || 'No response captured from Architect.';

  console.log('\u{1F4DD} Architect Summary:');
  console.log(outcome);

  // Discover PRs via GitHub API
  let prNumber: number | null = null;
  let prNumbers: number[] = [];
  try {
    const prInfos = await findAllPrsForIssue(config, issueNumber);
    prNumber = prInfos.length > 0 ? prInfos[0].prNumber : null;
    prNumbers = prInfos.map(p => p.prNumber);
    for (const prInfo of prInfos) {
      console.log(`\n\u{1F517} Found PR #${prInfo.prNumber} on branch ${prInfo.branch}`);
    }
  } catch (error) {
    console.warn(`\u{26A0}\uFE0F  Could not discover PR for issue #${issueNumber}: ${error}`);
  }

  // Post usage summary comment on the issue
  if (options.usageService && options.processId && !options.dryRun) {
    try {
      const comment = await formatUsageSummaryComment(options.usageService, options.processId);
      if (comment) {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body: comment,
        });
        console.log(`\n📊 Usage summary posted to issue #${issueNumber}`);
      }
    } catch (err) {
      console.warn(`⚠️  Could not post usage summary: ${err}`);
    }
  }

  return {
    issueNumber,
    prNumber,
    prNumbers,
    outcome,
    cacheStats: { hits: stats.hits, misses: stats.misses, invalidations: stats.invalidations, size: stats.size, hitRate: `${hitRate}%` },
  };
}
