import { createDeepAgent } from 'deepagents';
import type { SubAgent } from 'deepagents';
import type { Config } from './config.js';
import { createModel } from './model.js';
import {
  createGitHubClient,
  getAuthFromConfig,
  createGitHubIssuesTool,
  createCommentOnIssueTool,
  createBranchTool,
  createPullRequestTool,
  createListRepoFilesTool,
  createReadRepoFileTool,
  createDryRunCommentTool,
  createDryRunBranchTool,
  createDryRunPullRequestTool,
  createOrUpdateFileTool,
  createDryRunCreateOrUpdateFileTool,
  createFetchSubIssuesTool,
  createGetParentIssueTool,
  createCreateSubIssueTool,
  createDryRunCreateSubIssueTool,
  createGetPrDiffTool,
  createSubmitPrReviewTool,
  createCheckCiStatusTool,
  createDryRunCheckCiStatusTool,
} from './github-tools.js';
import { formatDuration, logAgentEvent } from './logger.js';
import { buildReviewerSystemPrompt } from './reviewer-agent.js';
import { findPrForIssue } from './core.js';
import type { Octokit } from 'octokit';

// ── Result interface ────────────────────────────────────────────────────────

export interface ArchitectResult {
  issueNumber: number;
  prNumber: number | null;
  outcome: string;
}

// ── Subagent builders ────────────────────────────────────────────────────────

/**
 * Create the Issuer subagent — understands issues, explores repo, produces a brief.
 * Read-only tools only.
 */
export function createIssuerSubagent(
  owner: string,
  repo: string,
  octokit: Octokit,
  model?: ReturnType<typeof createModel>,
): SubAgent {
  const tools = [
    createGitHubIssuesTool(owner, repo, octokit),
    createListRepoFilesTool(owner, repo, octokit),
    createReadRepoFileTool(owner, repo, octokit),
    createFetchSubIssuesTool(owner, repo, octokit),
    createGetParentIssueTool(owner, repo, octokit),
  ];

  const systemPrompt = `You are the Issuer agent for the GitHub repository ${owner}/${repo}.

Your job is to thoroughly understand a GitHub issue and produce a brief for the team.

WORKFLOW:
1. Read the issue title, body, and labels
2. Check for sub-issues (fetch_sub_issues) and parent issue (get_parent_issue)
3. Use list_repo_files to see the repository structure
4. Use read_repo_file to read 2-5 files relevant to the issue
5. Produce your brief as a natural language summary

YOUR BRIEF MUST INCLUDE:
- Issue summary: what is being asked for
- Issue type: bug, feature, docs, question, or unknown
- Complexity: trivial, simple, moderate, or complex
- Relevant files: which files need to change and why
- Recommended approach: step-by-step plan for fixing/implementing
- Base branch: if the issue specifies a base branch (e.g. "base branch: develop", "branch: feature/x", or similar), include it. Otherwise default to "main"
- Whether to proceed: should the team work on this? If not, explain why
- Sub-issue context: if there are sub-issues or a parent, describe the relationship

CONSTRAINTS:
- You have READ-ONLY access. You CANNOT post comments, create branches, or open PRs.
- Be thorough but concise. The Architect will use your brief to instruct the Coder.
- Your output is natural language, not JSON. Write clearly and specifically.`;

  return {
    name: 'issuer',
    description: 'Understands GitHub issues — explores the repo, reads relevant files, and produces a brief with issue summary, type, complexity, relevant files, and recommended approach.',
    systemPrompt,
    tools,
    ...(model ? { model } : {}),
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
  opts: { dryRun?: boolean; model?: ReturnType<typeof createModel> },
): SubAgent {
  const dryRun = opts.dryRun ?? false;

  const tools = [
    createListRepoFilesTool(owner, repo, octokit),
    createReadRepoFileTool(owner, repo, octokit),
    dryRun ? createDryRunCommentTool() : createCommentOnIssueTool(owner, repo, octokit),
    dryRun ? createDryRunBranchTool() : createBranchTool(owner, repo, octokit),
    dryRun ? createDryRunCreateOrUpdateFileTool() : createOrUpdateFileTool(owner, repo, octokit),
    dryRun ? createDryRunPullRequestTool() : createPullRequestTool(owner, repo, octokit),
    dryRun ? createDryRunCreateSubIssueTool() : createCreateSubIssueTool(owner, repo, octokit),
  ];

  const systemPrompt = `You are the Coder agent for the GitHub repository ${owner}/${repo}.

Your job is to implement changes based on the Architect's instructions.

WORKFLOW FOR NEW ISSUES:
1. Post a summary comment on the issue using comment_on_issue
2. Create a branch named issue-<number>-<short-description> using create_branch
   - Use the from_branch parameter if the Architect specifies a base branch (e.g. "develop", "feature/x")
   - If no base branch is specified, it defaults to "main"
3. Use create_or_update_file to commit your proposed changes to the branch
   - Write the FULL file content (not a diff) — the tool replaces the entire file
   - Each call commits one file. Make multiple calls for multi-file changes.
4. Self-review: use read_repo_file to read back each committed file and verify correctness
5. Open a draft PR with title "Fix #<number>: <description>" using create_pull_request
   - If a base branch was specified, set the base parameter to match (e.g. base: "develop")
   - Body must contain "Closes #<number>" on its own line
   - Include a "## Self-Review" section noting what you checked

WORKFLOW FOR FIX ITERATIONS (when told to fix reviewer feedback):
- The branch and PR ALREADY EXIST. Do NOT create new ones.
- Do NOT post a new comment on the issue.
- Read the current files from the specified branch, apply fixes, and commit to the same branch.
- Use read_repo_file to verify your changes after committing.

CONSTRAINTS:
- Always create the branch BEFORE committing files, and commit files BEFORE the PR
- Never merge PRs — always open them as drafts
- Write tools are idempotent. If they return { skipped: true }, move to the next step
- Base your changes on actual file content from read_repo_file, not assumptions
- If adding new dependencies, explain why in the PR body

CODE QUALITY GUIDELINES:
- Prefer existing patterns and dependencies in the codebase
- Use clear commit messages like "Fix #<number>: improve README structure"
- You MUST commit at least one file so the PR has a real diff

SUB-ISSUE SUPPORT:
- If instructed about sub-issues, use create_sub_issue to break down parent issues
- Create a SINGLE branch and PR addressing parent and all sub-issues
- In the PR body, reference all sub-issue numbers ("Addresses #10, #11, #12")

TESTING GUIDELINES (only when instructed by the Architect):
- When the Architect tells you to write tests, write or update tests alongside source changes
- Use the same test framework and patterns already in the repo
- At minimum cover: happy path + one error/edge case
- If the repo has no existing tests, skip — do not introduce a test framework from scratch
- If the Architect does not mention tests, skip this section entirely`;

  return {
    name: 'coder',
    description: 'Implements code changes — creates branches, commits files, opens draft PRs. Can also fix reviewer feedback on existing branches.',
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
): SubAgent {
  const tools = [
    createGetPrDiffTool(octokit, owner, repo),
    createListRepoFilesTool(owner, repo, octokit),
    createReadRepoFileTool(owner, repo, octokit),
    createSubmitPrReviewTool(octokit, owner, repo),
  ];

  const systemPrompt = buildReviewerSystemPrompt(owner, repo);

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
- **coder**: Implements changes. Give it specific instructions based on the Issuer's brief. It creates branches, commits code, and opens draft PRs.
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

ITERATION LIMIT: ${maxIterations} review→fix cycles maximum. After that, report the current state.

CRITICAL RULES:
- You DECIDE the workflow. You can skip steps, reorder, or stop based on judgment.
- You have read-only tools for verification: use them to check issue status or repo state.
- ALWAYS use the task tool to delegate. Never try to write code or post comments yourself.
- When delegating to coder for fixes, always specify the existing branch name and PR number.
- Your final message should be a clear summary of what was done and the outcome.

AVAILABLE TOOLS FOR VERIFICATION (read-only):
- fetch_github_issues: Check issue details
- list_repo_files: Browse repo structure
- read_repo_file: Read file contents
- check_ci_status: Check CI/check-run results for a PR (returns success, failure, in_progress, or no_checks)`;
}

// ── Architect factory ────────────────────────────────────────────────────────

export function createArchitect(
  config: Config,
  options: { dryRun?: boolean; maxIterations?: number } = {},
) {
  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  const maxIterations = options.maxIterations ?? 3;

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

  // Build subagents
  const subagents = [
    createIssuerSubagent(owner, repo, octokit, issuerModel),
    createCoderSubagent(owner, repo, octokit, { dryRun: options.dryRun, model: coderModel }),
    createReviewerSubagent(owner, repo, octokit, reviewerModel),
  ];

  // Architect's own read-only tools for verification
  const architectTools = [
    createGitHubIssuesTool(owner, repo, octokit),
    createListRepoFilesTool(owner, repo, octokit),
    createReadRepoFileTool(owner, repo, octokit),
    options.dryRun ? createDryRunCheckCiStatusTool() : createCheckCiStatusTool(owner, repo, octokit),
  ];

  const systemPrompt = buildArchitectSystemPrompt(owner, repo, maxIterations);
  const model = createModel(config);

  const agent = createDeepAgent({
    model,
    tools: architectTools,
    subagents,
    systemPrompt,
  });

  return agent;
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
export async function runArchitect(
  config: Config,
  issueNumber: number,
  options: { dryRun?: boolean } = {},
): Promise<ArchitectResult> {
  const maxIterations = getMaxIterations(config);

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  console.log(`\u{1F3D7}\uFE0F  Architect processing issue #${issueNumber} (max ${maxIterations} review iterations)`);
  if (options.dryRun) {
    console.log('\u{1F9EA} DRY RUN MODE -- Coder subagent will skip GitHub writes');
  }
  console.log('');

  const architect = createArchitect(config, { dryRun: options.dryRun, maxIterations });

  const userMessage = `Process issue #${issueNumber}. Delegate to your team to understand, implement, and review a fix for this issue.`;

  console.log('='.repeat(60));

  // Subagent tracking state
  let reviewerCount = 0;
  let coderAfterReview = false;
  let coderFixCount = 0;
  let activeSubagent: string | null = null;
  let activeStartTime = 0;
  let activeLabel = '';
  let lastResponse = '';

  const stream = architect.streamEvents(
    { messages: [{ role: 'user', content: userMessage }] },
    { version: 'v2' },
  );

  for await (const ev of stream) {
    if (ev.event === 'on_tool_start' && ev.name === 'task') {
      const input = ev.data?.input;
      const subagentType: string = input?.subagent_type ?? 'unknown';
      const description: string = input?.description ?? '';

      activeSubagent = subagentType;
      activeStartTime = performance.now();

      // Build iteration label
      let label = '';
      if (subagentType === 'reviewer') {
        reviewerCount++;
        label = ` [iteration ${reviewerCount}/${maxIterations}]`;
      } else if (subagentType === 'coder' && coderAfterReview) {
        coderFixCount++;
        label = ` [fix iteration ${coderFixCount}]`;
      }
      activeLabel = label;

      logAgentEvent(subagentType, `started${label}`, description);
    } else if (ev.event === 'on_tool_end' && ev.name === 'task') {
      if (activeSubagent) {
        const duration = formatDuration(performance.now() - activeStartTime);

        logAgentEvent(activeSubagent, `completed${activeLabel} (${duration})`);

        // After the first reviewer completes, subsequent coder calls are fix iterations
        if (activeSubagent === 'reviewer') {
          coderAfterReview = true;
        }

        activeSubagent = null;
        activeLabel = '';
      }
    } else if (ev.event === 'on_chat_model_end') {
      const content = ev.data?.output?.content;
      if (typeof content === 'string' && content) {
        lastResponse = content;
      }
    }
  }

  console.log('='.repeat(60));
  console.log('\n\u{2705} Architect completed!\n');

  const outcome = lastResponse || 'No response captured from Architect.';

  console.log('\u{1F4DD} Architect Summary:');
  console.log(outcome);

  // Discover PR via GitHub API
  let prNumber: number | null = null;
  try {
    const prInfo = await findPrForIssue(config, issueNumber);
    if (prInfo) {
      prNumber = prInfo.prNumber;
      console.log(`\n\u{1F517} Found PR #${prNumber} on branch ${prInfo.branch}`);
    }
  } catch (error) {
    console.warn(`\u{26A0}\uFE0F  Could not discover PR for issue #${issueNumber}: ${error}`);
  }

  return {
    issueNumber,
    prNumber,
    outcome,
  };
}
