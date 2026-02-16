import { createPatchToolCallsMiddleware } from 'deepagents';
import { createAgent, anthropicPromptCachingMiddleware, summarizationMiddleware, tool } from 'langchain';
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
import { createContextCompactionMiddleware } from './context-compaction.js';
import { createIterationPruningMiddleware } from './context-pruning.js';
import { ToolCache, wrapDiffWithDelta, prDiffKey } from './tool-cache.js';
import { findPrForIssue, findAllPrsForIssue } from './core.js';
import type { Octokit } from 'octokit';
import type { ProgressUpdate } from './process-manager.js';
import type { UsageService } from './usage-service.js';
import type { AgentRole, LLMProvider } from './usage-types.js';
import type { IssueContextRepository } from './issue-context-repository.js';
import { createSaveContextTool, createGetContextTool, createSearchPastIssuesTool } from './context-tools.js';
import {
  extractTextContent,
  formatUsageSummaryComment,
  getMaxIterations,
} from './architect.js';
import { wrapWithOutputCap } from './tool-output-cap.js';
import type { ArchitectResult, ContinueContext } from './architect.js';

// ── Tool assembly ────────────────────────────────────────────────────────────

/**
 * Assemble ALL tools from all subagent roles into a single flat array.
 * No duplicates since each factory produces a unique tool name.
 */
export function buildSingleAgentTools(
  owner: string,
  repo: string,
  octokit: Octokit,
  ws: Workspace,
  opts: { dryRun?: boolean; cache?: ToolCache; contextTools?: ReturnType<typeof tool>[] },
) {
  const dryRun = opts.dryRun ?? false;
  return [
    // Read-only exploration (shared by all subagents)
    createGitHubIssuesTool(owner, repo, octokit),
    createLocalListFilesTool(ws),
    createLocalReadFileTool(ws),
    createLocalGrepTool(ws),
    // Issue graph
    createFetchSubIssuesTool(owner, repo, octokit),
    createGetParentIssueTool(owner, repo, octokit),
    // Write tools (coder)
    dryRun ? createDryRunCommentTool() : createCommentOnIssueTool(owner, repo, octokit),
    dryRun ? createDryRunEditFileTool() : createLocalEditFileTool(ws),
    dryRun ? createDryRunWriteFileTool() : createLocalWriteFileTool(ws),
    dryRun ? createDryRunBashTool() : createLocalBashTool(ws),
    dryRun ? createDryRunPullRequestTool() : createPullRequestTool(owner, repo, octokit),
    dryRun ? createDryRunCreateSubIssueTool() : createCreateSubIssueTool(owner, repo, octokit),
    // Review tools
    opts.cache
      ? wrapDiffWithDelta(createGetPrDiffTool(octokit, owner, repo), opts.cache, { extractKey: prDiffKey })
      : createGetPrDiffTool(octokit, owner, repo),
    createSubmitPrReviewTool(octokit, owner, repo),
    // CI
    dryRun ? createDryRunCheckCiStatusTool() : createCheckCiStatusTool(owner, repo, octokit),
    // Context tools
    ...(opts.contextTools ?? []),
  ].map(t => wrapWithOutputCap(t));
}

// ── System prompt ────────────────────────────────────────────────────────────

/**
 * Build the comprehensive single-agent system prompt covering all phases.
 */
export function buildSingleAgentSystemPrompt(
  owner: string,
  repo: string,
  modelName: string,
  maxIterations: number,
): string {
  return `You are a single autonomous agent for the GitHub repository ${owner}/${repo}.
Your name is ${modelName}. You handle the complete issue lifecycle: analysis, planning, implementation, review, and iteration.

You have ALL tools available — read-only exploration, code editing, git operations, GitHub API, and PR review.

═══ PHASE 1: ISSUE ANALYSIS ═══
1. Read the issue (fetch_github_issues)
2. Check for sub-issues (fetch_sub_issues) and parent (get_parent_issue)
3. Explore the repo: list_files → read_file → grep
4. Post analysis comment on the issue (comment_on_issue)
5. Decide whether to proceed or stop

═══ PHASE 2: PLANNING ═══
1. Read ALL relevant files
2. Identify patterns, conventions, dependencies
3. Produce numbered execution plan (which files, what changes, why)
4. Do NOT start coding until you have a plan

═══ PHASE 3: IMPLEMENTATION ═══
1. Create branch: git checkout -b issue-<N>-<desc>
2. Make changes with edit_file (surgical) or write_file (new files)
3. Commit and push: git add -A && git commit && git push origin HEAD
4. Open PR: create_pull_request with "Closes #N" in body
5. Write tests if the change warrants them

═══ PHASE 4: SELF-REVIEW ═══
1. Fetch the PR diff (get_pr_diff)
2. Read source files for context
3. Critically evaluate: bugs, logic errors, security, readability, patterns
4. Submit review (submit_pr_review) — COMMENT event only
5. Determine verdict: "resolved" or "needs_changes"

═══ PHASE 5: FIX ITERATION (if needed) ═══
If your review found issues, fix them:
1. Apply fixes with edit_file
2. Commit and push to the same branch
3. Re-review (get_pr_diff again, submit_pr_review)
4. Repeat up to ${maxIterations} times

CONTINUE MODE (when resuming an existing PR):
Skip phases 1-3. Go directly to Phase 4 (review the existing PR).

CONSTRAINTS:
- Never merge PRs — only open and review them
- COMMENT reviews only (no approve/request_changes)
- Self-review must be genuinely critical
- Max ${maxIterations} review→fix cycles
- Use edit_file for surgical changes, write_file for new files only

SHARED CONTEXT:
- save_issue_context: Record your analysis, plan, and review feedback
- get_issue_context: Read previous entries from this run
- search_past_issues: Find similar resolved issues`;
}

// ── Single agent factory ─────────────────────────────────────────────────────

/**
 * Create the single agent — same shape as createArchitect() return value.
 */
export async function createSingleAgent(config: Config, options: {
  dryRun?: boolean;
  maxIterations?: number;
  issueNumber?: number;
  processId?: string | null;
  contextRepo?: IssueContextRepository;
  repoId?: number;
  continueContext?: ContinueContext;
}) {
  const { owner, repo } = config.github;
  const auth = getAuthFromConfig(config.github);
  const octokit = createGitHubClient(auth);

  const maxIterations = options.maxIterations ?? 3;

  // Clone workspace
  const gitToken = await resolveGitToken(auth);
  const workspace = await createWorkspace(owner, repo, gitToken, {
    branch: options.continueContext?.branchName,
    processId: options.processId ?? undefined,
  });
  console.log(`\u{1F4C2} Workspace cloned to ${workspace.path}`);

  const ws: Workspace = { path: workspace.path, cleanup: async () => {} };
  const cache = new ToolCache();

  // Build context tools
  const ctxRepo = options.contextRepo;
  const ctxRepoId = options.repoId ?? 0;
  const ctxIssue = options.issueNumber ?? 0;
  const ctxProcess = options.processId ?? null;

  let contextTools: ReturnType<typeof tool>[] = [];
  if (ctxRepo && ctxIssue > 0) {
    contextTools = [
      createSaveContextTool(ctxRepo, ctxRepoId, ctxIssue, ctxProcess, 'single-agent'),
      ...(ctxProcess ? [createGetContextTool(ctxRepo, ctxProcess)] : []),
      createSearchPastIssuesTool(ctxRepo, ctxRepoId, ctxIssue),
    ];
  }

  // Build tools and system prompt
  const allTools = buildSingleAgentTools(owner, repo, octokit, ws, {
    dryRun: options.dryRun,
    cache,
    contextTools,
  });

  const modelName = config.llm.model ?? 'unknown-model';
  const systemPrompt = buildSingleAgentSystemPrompt(owner, repo, modelName, maxIterations);
  const model = createModel(config);

  const agent = createAgent({
    model,
    tools: allTools,
    systemPrompt,
    middleware: [
      createContextCompactionMiddleware(),
      summarizationMiddleware({ model, trigger: { tokens: 50_000 }, keep: { messages: 6 } }),
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: 'ignore' }),
      createPatchToolCallsMiddleware(),
      createIterationPruningMiddleware(),
    ],
  }).withConfig({ recursionLimit: 10_000 });

  return { agent, cache, workspace };
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run the single agent on a single issue.
 * Same signature and return type as runArchitect().
 */
export async function runSingleAgent(
  config: Config,
  issueNumber: number,
  options: {
    dryRun?: boolean;
    onProgress?: (update: ProgressUpdate) => void;
    signal?: AbortSignal;
    continueContext?: ContinueContext;
    usageService?: UsageService;
    processId?: string;
    contextRepo?: IssueContextRepository;
    repoId?: number;
  } = {},
): Promise<ArchitectResult> {
  const maxIterations = getMaxIterations(config);
  const modelName = config.llm.model ?? 'unknown-model';

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  if (options.continueContext) {
    console.log(`\u{1F504} Continuing issue #${issueNumber} — PR #${options.continueContext.prNumber} on branch ${options.continueContext.branchName}`);
  } else {
    console.log(`\u{1F916} Single agent (${modelName}) processing issue #${issueNumber} (max ${maxIterations} review iterations)`);
  }
  if (options.dryRun) {
    console.log('\u{1F9EA} DRY RUN MODE -- write tools will skip actual changes');
  }
  console.log('');

  const { agent, cache, workspace } = await createSingleAgent(config, {
    dryRun: options.dryRun,
    maxIterations,
    issueNumber,
    processId: options.processId,
    contextRepo: options.contextRepo,
    repoId: options.repoId,
    continueContext: options.continueContext,
  });

  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  // Build user message
  let userMessage: string;
  if (options.continueContext) {
    const { prNumber, branchName, humanFeedback } = options.continueContext;
    userMessage = `Continue working on issue #${issueNumber}. A PR #${prNumber} already exists on branch "${branchName}".

Skip phases 1-3. Go directly to Phase 4 (self-review):
1. Fetch the PR diff (get_pr_diff for PR #${prNumber})
2. Review it critically
3. If issues found, fix them (edit_file, commit, push to ${branchName})
4. Re-review until resolved or iteration limit reached`;
    if (humanFeedback) {
      userMessage += `\n\nIMPORTANT — A human reviewer left the following feedback on this PR. Address this in addition to any issues you find:\n\n${humanFeedback}`;
    }
  } else {
    userMessage = `Process issue #${issueNumber}. Follow the full lifecycle: analyze the issue, plan, implement, self-review, and iterate on fixes.`;
  }

  console.log('='.repeat(60));

  // Phase detection from tool names
  let currentPhase = 'analysis';
  let lastResponse = '';
  let chatModelStartTime = 0;

  const stream = agent.streamEvents(
    { messages: [{ role: 'user', content: userMessage }] },
    { version: 'v2' },
  );

  try {
    for await (const ev of stream) {
      if (options.signal?.aborted) break;

      if (ev.event === 'on_tool_start') {
        const toolName = ev.name;

        // Detect phase from tool usage
        let detectedPhase: string | null = null;
        if (toolName === 'fetch_github_issues' || toolName === 'fetch_sub_issues' || toolName === 'get_parent_issue') {
          detectedPhase = 'analysis';
        } else if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'bash') {
          detectedPhase = 'coding';
        } else if (toolName === 'get_pr_diff' || toolName === 'submit_pr_review') {
          detectedPhase = 'review';
        } else if (toolName === 'create_pull_request') {
          detectedPhase = 'pr-creation';
        } else if (toolName === 'check_ci_status') {
          detectedPhase = 'ci-check';
        }

        if (detectedPhase && detectedPhase !== currentPhase) {
          currentPhase = detectedPhase;
          logAgentEvent(modelName, `phase: ${currentPhase}`);
          options.onProgress?.({
            phase: currentPhase,
            action: 'started',
          });
        }
      } else if (ev.event === 'on_chat_model_start') {
        chatModelStartTime = performance.now();
      } else if (ev.event === 'on_chat_model_end') {
        const content = ev.data?.output?.content;
        const textContent = extractTextContent(content);
        if (textContent) {
          lastResponse = textContent;
          logAgentEvent(modelName, 'reasoning', textContent);
          options.onProgress?.({
            phase: currentPhase,
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
              const responseModel = modelOutput?.response_metadata?.model;
              const durationMs = chatModelStartTime > 0 ? performance.now() - chatModelStartTime : 0;
              options.usageService.record({
                provider: config.llm.provider as LLMProvider,
                model: responseModel ?? modelName,
                agent: modelName,
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
    console.log(`\u{1F9F9} Cleaning up workspace at ${workspace.path}`);
    await workspace.cleanup();
  }

  console.log('='.repeat(60));
  console.log('\n\u{2705} Single agent completed!\n');

  // Auto-save outcome entry
  if (options.contextRepo && lastResponse && issueNumber > 0) {
    try {
      await options.contextRepo.addEntry({
        repoId: options.repoId ?? 0,
        issueNumber,
        processId: options.processId ?? null,
        entryType: 'outcome',
        agent: 'single-agent:auto',
        content: lastResponse.slice(0, 10000),
        filesTouched: [],
        iteration: 0,
      });
    } catch { /* best-effort */ }
  }

  // Log cache stats
  const stats = cache.getStats();
  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? ((stats.hits / total) * 100).toFixed(1) : '0.0';
  console.log(`\u{1F4BE} Cache stats: ${stats.hits} hits, ${stats.misses} misses (${hitRate}% hit rate), ${stats.invalidations} invalidations, ${stats.size} entries`);

  const outcome = lastResponse || 'No response captured from single agent.';

  console.log('\u{1F4DD} Agent Summary:');
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
