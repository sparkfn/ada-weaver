import { createPatchToolCallsMiddleware } from 'deepagents';
import { createAgent, anthropicPromptCachingMiddleware, summarizationMiddleware } from 'langchain';
import type { Config } from './config.js';
import { createModel } from './model.js';
import {
  createGitHubClient,
  getAuthFromConfig,
  createGetPrDiffTool,
  createReadRepoFileTool,
  createSubmitPrReviewTool,
  ToolCallCounter,
  wrapWithCircuitBreaker,
} from './github-tools.js';
import { wrapWithLogging } from './logger.js';
import { ToolCache, wrapWithCache, readFileKey, prDiffKey } from './tool-cache.js';
import type { UsageService } from './usage-service.js';
import type { LLMProvider } from './usage-types.js';

// ── Review output interface ──────────────────────────────────────────────────

/**
 * Structured output from the reviewer agent.
 * This is the contract between the review phase and the feedback loop.
 */
export interface ReviewOutput {
  verdict: 'resolved' | 'needs_changes';
  summary: string;
  feedbackItems: string[];   // actionable items, empty when resolved
  reviewBody: string;        // raw review text posted to GitHub
}

/**
 * Default review output when parsing fails.
 * Conservative: defaults to needs_changes so the loop retries.
 */
const FALLBACK_REVIEW: ReviewOutput = {
  verdict: 'needs_changes',
  summary: 'Review output could not be parsed. Defaulting to needs_changes.',
  feedbackItems: [],
  reviewBody: '',
};

const VALID_VERDICTS = new Set(['resolved', 'needs_changes']);

/**
 * Parse the reviewer agent's final message into a structured ReviewOutput.
 *
 * The agent is instructed to output a JSON verdict block as its final message.
 * We extract JSON from the text, parse it, and validate the fields.
 * Falls back to FALLBACK_REVIEW if parsing fails.
 */
export function parseReviewOutput(text: string): ReviewOutput {
  // Try to extract JSON from the text (handles markdown fences, extra whitespace)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('Review: no JSON object found in agent response. Using fallback.');
    return { ...FALLBACK_REVIEW };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn('Review: failed to parse JSON from agent response. Using fallback.');
    return { ...FALLBACK_REVIEW };
  }

  // Validate and normalize fields
  const verdict = VALID_VERDICTS.has(parsed.verdict) ? parsed.verdict : 'needs_changes';
  const summary = typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided.';
  const feedbackItems = Array.isArray(parsed.feedbackItems)
    ? parsed.feedbackItems.filter((f: unknown) => typeof f === 'string')
    : [];

  return { verdict, summary, feedbackItems, reviewBody: text };
}

// ── Reviewer system prompt ───────────────────────────────────────────────────

export function buildReviewerSystemPrompt(
  owner: string,
  repo: string,
  iterationContext?: { iteration: number; previousFeedback: string[] },
): string {
  let prompt = `You are a code review agent for the GitHub repository ${owner}/${repo}.

Your job is to review a pull request and provide constructive feedback. You are an automated reviewer -- your review helps human maintainers decide whether to merge.

WORKFLOW:
1. Fetch the PR diff using get_pr_diff
2. Read ONLY the source files touched in the diff for context. Use start_line/end_line to read just the changed regions (±30 lines), not entire files.
3. Evaluate the changes:
   - Does the approach make sense for the problem it's solving?
   - Are there any bugs, logic errors, or edge cases missed?
   - Is the code readable and maintainable?
   - Are there any security concerns (injection, XSS, etc.)?
   - Does the change follow existing patterns in the codebase?
4. Submit your review using submit_pr_review with:
   - A summary of your assessment in the body
   - Inline comments on specific lines where you have feedback
   - Be constructive -- suggest improvements, don't just criticize

CONSTRAINTS:
- You can ONLY post a COMMENT review. You CANNOT approve or request changes.
- You are NOT a human. Always be transparent that this is an automated review.
- Keep reviews focused and actionable. Don't nitpick style if the code works.
- If the PR looks good, say so! Not every review needs to find problems.
- Read at most 5 source files for context (don't over-explore).

IMPORTANT — TOOL USAGE:
- ONLY use the GitHub API tools: get_pr_diff, list_repo_files, read_repo_file, submit_pr_review.
- You may see other tools (ls, write, edit, grep, glob, etc.) — these are sandbox filesystem tools. Do NOT use them. They have no access to the repository. All repo operations go through the GitHub API tools listed above.

After submitting your review, your FINAL message must be a JSON object:
{
  "verdict": "resolved" | "needs_changes",
  "summary": "One paragraph assessment",
  "feedbackItems": ["specific fix 1", "specific fix 2"]
}

VERDICT GUIDE:
- "resolved": PR correctly addresses the issue. Minor style nits do NOT warrant "needs_changes".
- "needs_changes": Bugs, missing functionality, logic errors, or approach doesn't solve the problem.
- "feedbackItems" should be empty when "resolved". When "needs_changes", list specific actionable fixes.`;

  if (iterationContext && iterationContext.iteration > 1) {
    prompt += `\n\nThis is review iteration ${iterationContext.iteration}. Previous review found these issues:\n`;
    for (const item of iterationContext.previousFeedback) {
      prompt += `- ${item}\n`;
    }
    prompt += `\nFocus on whether these issues were addressed and check for regressions.`;
  }

  return prompt;
}

// ── Reviewer agent factory ───────────────────────────────────────────────────

/** Maximum tool calls for the reviewer agent. */
const REVIEWER_MAX_TOOL_CALLS = 15;

/**
 * Create a PR reviewer agent.
 *
 * Uses a potentially different model (config.reviewerLlm) and has access to:
 * - get_pr_diff: fetch the PR diff
 * - read_repo_file: read source files for context
 * - submit_pr_review: post a review (always COMMENT)
 */
export function createReviewerAgent(
  config: Config,
  options: {
    maxToolCalls?: number;
    iterationContext?: { iteration: number; previousFeedback: string[] };
    iterationTag?: number;
    cache?: ToolCache;
  } = {},
) {
  // Use reviewerLlm if configured, otherwise fall back to main llm
  const modelConfig = config.reviewerLlm
    ? { ...config, llm: config.reviewerLlm }
    : config;
  const model = createModel(modelConfig);

  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  // Tools: diff reader, source reader, review submitter
  let diffTool = createGetPrDiffTool(octokit, owner, repo);
  let readFileTool = createReadRepoFileTool(owner, repo, octokit);
  let reviewTool = createSubmitPrReviewTool(octokit, owner, repo, { iterationTag: options.iterationTag });

  // Cache layer (innermost — cache hit skips API AND circuit breaker)
  if (options.cache) {
    diffTool = wrapWithCache(diffTool, options.cache, { extractKey: prDiffKey });
    readFileTool = wrapWithCache(readFileTool, options.cache, { extractKey: readFileKey });
  }

  // Circuit breaker
  const maxToolCalls = options.maxToolCalls ?? REVIEWER_MAX_TOOL_CALLS;
  const counter = new ToolCallCounter(maxToolCalls);
  diffTool = wrapWithCircuitBreaker(diffTool, counter);
  readFileTool = wrapWithCircuitBreaker(readFileTool, counter);
  reviewTool = wrapWithCircuitBreaker(reviewTool, counter);

  // Structured logging (outermost layer)
  diffTool = wrapWithLogging(diffTool, counter);
  readFileTool = wrapWithLogging(readFileTool, counter);
  reviewTool = wrapWithLogging(reviewTool, counter);

  const systemPrompt = buildReviewerSystemPrompt(owner, repo, options.iterationContext);

  const agent = createAgent({
    model,
    tools: [diffTool, readFileTool, reviewTool],
    systemPrompt,
    middleware: [
      summarizationMiddleware({ model, trigger: { tokens: 50_000 }, keep: { messages: 6 } }),
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: 'ignore' }),
      createPatchToolCallsMiddleware(),
    ],
  }).withConfig({ recursionLimit: 10_000 });

  return agent;
}

// ── Run review on a single PR ────────────────────────────────────────────────

/**
 * Run the reviewer agent on a single PR.
 *
 * Uses streamEvents() to collect the final message via streaming,
 * matching the pattern used by runArchitect and chatStream.
 */
export async function runReviewSingle(
  config: Config,
  prNumber: number,
  options?: { iterationContext?: { iteration: number; previousFeedback: string[] }; signal?: AbortSignal; usageService?: UsageService; processId?: string },
): Promise<ReviewOutput> {
  const iteration = options?.iterationContext?.iteration ?? 1;
  console.log(`\u{1F50D} Reviewing PR #${prNumber}${iteration > 1 ? ` (iteration ${iteration})` : ''}\n`);

  const agent = createReviewerAgent(config, {
    iterationContext: options?.iterationContext,
    iterationTag: iteration,
  });
  const userMessage = `Review pull request #${prNumber}. Fetch the diff, read relevant source files, and submit your review.`;

  console.log('='.repeat(60));

  let lastResponse = '';
  let chatModelStartTime = 0;

  const stream = agent.streamEvents(
    { messages: [{ role: 'user', content: userMessage }] },
    { version: 'v2' },
  );

  for await (const ev of stream) {
    if (options?.signal?.aborted) break;

    if (ev.event === 'on_chat_model_start') {
      chatModelStartTime = performance.now();
    } else if (ev.event === 'on_chat_model_end') {
      const content = ev.data?.output?.content;
      if (typeof content === 'string' && content) {
        lastResponse = content;
      }

      // Record usage metrics
      if (options?.usageService) {
        try {
          let modelOutput = ev.data?.output;
          if (typeof modelOutput === 'string') {
            try { modelOutput = JSON.parse(modelOutput); } catch { /* keep as string */ }
          }
          const usage = modelOutput?.usage_metadata;
          if (usage) {
            const reviewerLlm = config.reviewerLlm ?? config.llm;
            const responseModel = modelOutput?.response_metadata?.model;
            const durationMs = chatModelStartTime > 0 ? performance.now() - chatModelStartTime : 0;
            options.usageService.record({
              provider: (reviewerLlm.provider ?? config.llm.provider) as LLMProvider,
              model: responseModel ?? reviewerLlm.model ?? config.llm.model ?? 'unknown',
              agent: 'reviewer',
              processId: options.processId,
              prNumber,
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              durationMs,
            });
          }
        } catch { /* best-effort */ }
      }
    }
  }

  console.log('='.repeat(60));
  console.log('\n\u{2705} Review completed!\n');

  const content = lastResponse || 'No response captured from reviewer.';

  console.log('\u{1F4DD} Agent Response:');
  console.log(content);

  return parseReviewOutput(content);
}
