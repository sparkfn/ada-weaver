/**
 * Claude Agent SDK — entry point, single-agent runner, and multi-agent runner.
 *
 * This module provides AGENT_MODE=claude-sdk, a third execution mode alongside
 * 'multi' (LangGraph Architect) and 'single' (LangGraph single-agent).
 *
 * The SDK provides Claude Code's built-in tools (Read, Edit, Write, Bash, Glob, Grep),
 * native subagent support, and MCP tool servers.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options as SdkOptions,
  AgentDefinition,
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKTaskStartedMessage,
  SDKTaskNotificationMessage,
  McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import type { ArchitectResult, ContinueContext } from './architect.js';
import type { ProgressUpdate } from './process-manager.js';
import type { UsageService } from './usage-service.js';
import type { IssueContextRepository } from './issue-context-repository.js';
import type { SettingsRepository } from './settings-repository.js';
import type { LLMProvider } from './usage-types.js';
import {
  createGitHubClient,
  getAuthFromConfig,
} from './github-tools.js';
import { createWorkspace, resolveGitToken } from './workspace.js';
import { createGitHubMcpServer, createContextMcpServer } from './claude-sdk-tools.js';
import { findAllPrsForIssue } from './core.js';
import {
  buildIssuerSystemPrompt,
  buildCoderSystemPrompt,
  buildArchitectSystemPrompt,
  extractTextContent,
  formatUsageSummaryComment,
  getMaxIterations,
} from './architect.js';
import { buildReviewerSystemPrompt } from './reviewer-agent.js';
import { formatDuration, logAgentEvent, logAgentDetail, logDiff } from './logger.js';

// ── Tool name mapping (LangChain → SDK) ─────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  // Local tools → SDK built-in tools
  read_file: 'Read',
  list_files: 'Glob',
  grep: 'Grep',
  edit_file: 'Edit',
  write_file: 'Write',
  bash: 'Bash',
  // GitHub tools → MCP-prefixed
  fetch_github_issues: 'mcp__github__fetch_github_issues',
  comment_on_issue: 'mcp__github__comment_on_issue',
  create_pull_request: 'mcp__github__create_pull_request',
  get_pr_diff: 'mcp__github__get_pr_diff',
  submit_pr_review: 'mcp__github__submit_pr_review',
  check_ci_status: 'mcp__github__check_ci_status',
  fetch_sub_issues: 'mcp__github__fetch_sub_issues',
  get_parent_issue: 'mcp__github__get_parent_issue',
  create_sub_issue: 'mcp__github__create_sub_issue',
  // Context tools → MCP-prefixed
  save_issue_context: 'mcp__context__save_issue_context',
  get_issue_context: 'mcp__context__get_issue_context',
  search_past_issues: 'mcp__context__search_past_issues',
};

/**
 * Replace tool name references in existing prompts to use SDK naming.
 */
export function adaptPromptForSdk(prompt: string): string {
  let adapted = prompt;
  // Sort by length descending so longer names are replaced first
  const entries = Object.entries(TOOL_NAME_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [oldName, newName] of entries) {
    // Replace tool names used as identifiers (word boundaries)
    adapted = adapted.replace(new RegExp(`\\b${oldName}\\b`, 'g'), newName);
  }
  return adapted;
}

/**
 * Map per-agent LLM overrides to SDK model names.
 */
export function mapToSdkModel(config: Config, role: 'issuer' | 'coder' | 'reviewer'): 'sonnet' | 'opus' | 'haiku' | 'inherit' {
  let modelStr: string | null | undefined;
  switch (role) {
    case 'issuer': modelStr = config.issuerLlm?.model; break;
    case 'coder': modelStr = config.coderLlm?.model; break;
    case 'reviewer': modelStr = config.reviewerLlm?.model; break;
  }
  if (!modelStr) return 'inherit';
  const lower = modelStr.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return 'inherit';
}

/**
 * Detect the current phase from tool call names in an assistant message.
 */
export function detectPhaseFromToolCalls(toolNames: string[]): string | null {
  for (const name of toolNames) {
    if (name.includes('fetch_github_issues') || name.includes('fetch_sub_issues') || name.includes('get_parent_issue')) {
      return 'analysis';
    }
    if (name === 'Edit' || name === 'Write' || name === 'Bash') {
      return 'coding';
    }
    if (name.includes('get_pr_diff') || name.includes('submit_pr_review')) {
      return 'review';
    }
    if (name.includes('create_pull_request')) {
      return 'pr-creation';
    }
    if (name.includes('check_ci_status')) {
      return 'ci-check';
    }
  }
  return null;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Run the Claude SDK agent on a single issue.
 * Routes to single-agent or multi-agent based on config.claudeSdk.multi.
 */
export async function runClaudeSdkAgent(
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
    settingsRepo?: SettingsRepository;
  } = {},
): Promise<ArchitectResult> {
  if (config.claudeSdk.multi) {
    return runClaudeSdkMultiAgent(config, issueNumber, options);
  }
  return runClaudeSdkSingleAgent(config, issueNumber, options);
}

// ── Shared setup ─────────────────────────────────────────────────────────────

interface SdkSetup {
  workspace: { path: string; cleanup: () => Promise<void> };
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  octokit: ReturnType<typeof createGitHubClient>;
  owner: string;
  repo: string;
}

async function setupSdkAgent(
  config: Config,
  issueNumber: number,
  options: {
    dryRun?: boolean;
    continueContext?: ContinueContext;
    processId?: string;
    contextRepo?: IssueContextRepository;
    repoId?: number;
  },
): Promise<SdkSetup> {
  const { owner, repo } = config.github;
  const auth = getAuthFromConfig(config.github);
  const octokit = createGitHubClient(auth);

  // Clone workspace
  const gitToken = await resolveGitToken(auth);
  const workspace = await createWorkspace(owner, repo, gitToken, {
    branch: options.continueContext?.branchName,
    processId: options.processId ?? undefined,
  });
  console.log(`\u{1F4C2} Workspace cloned to ${workspace.path}`);

  // Create MCP servers
  const mcpServers: Record<string, McpSdkServerConfigWithInstance> = {
    github: createGitHubMcpServer(owner, repo, octokit, { dryRun: options.dryRun }),
  };

  if (options.contextRepo && issueNumber > 0) {
    mcpServers.context = createContextMcpServer(
      options.contextRepo,
      options.repoId ?? 0,
      issueNumber,
      options.processId ?? null,
      'claude-sdk',
    );
  }

  return { workspace, mcpServers, octokit, owner, repo };
}

// ── Single SDK Agent ─────────────────────────────────────────────────────────

async function runClaudeSdkSingleAgent(
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
    settingsRepo?: SettingsRepository;
  } = {},
): Promise<ArchitectResult> {
  const maxIterations = getMaxIterations(config);
  const sdkModel = config.claudeSdk.model || config.llm.model || undefined;

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  if (options.continueContext) {
    console.log(`\u{1F504} Continuing issue #${issueNumber} — PR #${options.continueContext.prNumber} on branch ${options.continueContext.branchName}`);
  } else {
    console.log(`\u{1F916} Claude SDK single-agent processing issue #${issueNumber} (max ${maxIterations} review iterations)`);
  }
  if (options.dryRun) {
    console.log('\u{1F9EA} DRY RUN MODE -- write tools will skip actual changes');
  }
  console.log('');

  const { workspace, mcpServers, octokit, owner, repo } = await setupSdkAgent(config, issueNumber, options);

  // Build system prompt from existing single-agent prompt + SDK tool mapping
  const { buildSingleAgentSystemPrompt } = await import('./single-agent.js');
  const modelName = sdkModel ?? 'claude-sdk';
  let systemPrompt = buildSingleAgentSystemPrompt(owner, repo, modelName, maxIterations);
  systemPrompt = adaptPromptForSdk(systemPrompt);
  systemPrompt += `\n\nTOOL NAME MAPPING (SDK mode):
The following tool names are available in SDK mode:
- Read: read file contents (replaces read_file)
- Glob: list/find files (replaces list_files)
- Grep: search for patterns (replaces grep)
- Edit: surgical file edits (replaces edit_file)
- Write: create or overwrite files (replaces write_file)
- Bash: run shell commands (replaces bash)
- GitHub tools are prefixed with mcp__github__ (e.g., mcp__github__fetch_github_issues)
- Context tools are prefixed with mcp__context__ (e.g., mcp__context__save_issue_context)`;

  // Build user message
  let userMessage: string;
  if (options.continueContext) {
    const { prNumber, branchName, humanFeedback } = options.continueContext;
    userMessage = `Continue working on issue #${issueNumber}. A PR #${prNumber} already exists on branch "${branchName}".

Skip phases 1-3. Go directly to Phase 4 (self-review):
1. Fetch the PR diff (mcp__github__get_pr_diff for PR #${prNumber})
2. Review it critically
3. If issues found, fix them (Edit, commit, push to ${branchName})
4. Re-review until resolved or iteration limit reached`;
    if (humanFeedback) {
      userMessage += `\n\nIMPORTANT — A human reviewer left the following feedback on this PR. Address this:\n\n${humanFeedback}`;
    }
  } else {
    userMessage = `Process issue #${issueNumber}. Follow the full lifecycle: analyze the issue, plan, implement, self-review, and iterate on fixes.`;
  }

  console.log('='.repeat(60));

  // SDK options
  const abortController = new AbortController();
  if (options.signal) {
    options.signal.addEventListener('abort', () => abortController.abort());
  }

  const sdkOptions: SdkOptions = {
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'mcp__github__*', 'mcp__context__*'],
    cwd: workspace.path,
    permissionMode: config.claudeSdk.permissionMode,
    allowDangerouslySkipPermissions: config.claudeSdk.permissionMode === 'bypassPermissions',
    maxTurns: config.claudeSdk.maxTurns,
    maxBudgetUsd: config.claudeSdk.maxBudgetUsd,
    model: sdkModel,
    systemPrompt,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: config.llm.apiKey!,
      GIT_TERMINAL_PROMPT: '0',
    },
    mcpServers,
    abortController,
    settingSources: [],
    persistSession: false,
  };

  let lastResponse = '';
  let currentPhase = 'analysis';
  let sessionId = '';

  try {
    const conversation = query({ prompt: userMessage, options: sdkOptions });

    for await (const msg of conversation) {
      if (options.signal?.aborted) {
        conversation.close();
        break;
      }

      if (msg.type === 'system' && (msg as SDKSystemMessage).subtype === 'init') {
        const initMsg = msg as SDKSystemMessage;
        sessionId = initMsg.session_id;
        logAgentEvent('claude-sdk', `session ${sessionId} initialized (model: ${initMsg.model})`);
      } else if (msg.type === 'assistant') {
        const assistantMsg = msg as SDKAssistantMessage;
        // Extract text and detect phase from tool calls
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
          const textParts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
          if (textParts.length > 0) {
            lastResponse = textParts.join('\n');
            logAgentEvent('claude-sdk', 'reasoning', lastResponse);
            options.onProgress?.({ phase: currentPhase, action: 'reasoning', detail: lastResponse.slice(0, 200) });
          }

          const toolNames = content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.name);
          const detectedPhase = detectPhaseFromToolCalls(toolNames);
          if (detectedPhase && detectedPhase !== currentPhase) {
            currentPhase = detectedPhase;
            logAgentEvent('claude-sdk', `phase: ${currentPhase}`);
            options.onProgress?.({ phase: currentPhase, action: 'started' });
          }
        }
      } else if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          const success = resultMsg as SDKResultSuccess;
          if (success.result) lastResponse = success.result;

          // Record usage
          if (options.usageService) {
            try {
              const usage = success.usage;
              options.usageService.record({
                provider: config.llm.provider as LLMProvider,
                model: sdkModel ?? config.llm.model ?? 'unknown',
                agent: 'claude-sdk',
                processId: options.processId,
                issueNumber,
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                durationMs: success.duration_ms,
              });
            } catch { /* best-effort */ }
          }

          logAgentEvent('claude-sdk', `completed (${formatDuration(success.duration_ms)}, $${success.total_cost_usd.toFixed(4)})`);
        } else {
          logAgentEvent('claude-sdk', `error: ${resultMsg.subtype}`);
        }
      }
    }
  } finally {
    console.log(`\u{1F9F9} Cleaning up workspace at ${workspace.path}`);
    await workspace.cleanup();
  }

  console.log('='.repeat(60));
  console.log('\n\u{2705} Claude SDK single-agent completed!\n');

  // Auto-save outcome
  if (options.contextRepo && lastResponse && issueNumber > 0) {
    try {
      await options.contextRepo.addEntry({
        repoId: options.repoId ?? 0, issueNumber,
        processId: options.processId ?? null,
        entryType: 'outcome', agent: 'claude-sdk:auto',
        content: lastResponse.slice(0, 10000), filesTouched: [], iteration: 0,
      });
    } catch { /* best-effort */ }
  }

  const outcome = lastResponse || 'No response captured from Claude SDK agent.';
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

  // Post usage summary
  if (options.usageService && options.processId && !options.dryRun) {
    try {
      const comment = await formatUsageSummaryComment(options.usageService, options.processId);
      if (comment) {
        await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: comment });
        console.log(`\n\u{1F4CA} Usage summary posted to issue #${issueNumber}`);
      }
    } catch (err) {
      console.warn(`\u{26A0}\uFE0F  Could not post usage summary: ${err}`);
    }
  }

  return { issueNumber, prNumber, prNumbers, outcome };
}

// ── Multi SDK Agent ──────────────────────────────────────────────────────────

async function runClaudeSdkMultiAgent(
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
    settingsRepo?: SettingsRepository;
  } = {},
): Promise<ArchitectResult> {
  const maxIterations = getMaxIterations(config);
  const sdkModel = config.claudeSdk.model || config.llm.model || undefined;

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  if (options.continueContext) {
    console.log(`\u{1F504} Continuing issue #${issueNumber} — PR #${options.continueContext.prNumber} on branch ${options.continueContext.branchName}`);
  } else {
    console.log(`\u{1F3D7}\uFE0F  Claude SDK multi-agent processing issue #${issueNumber} (max ${maxIterations} review iterations)`);
  }
  if (options.dryRun) {
    console.log('\u{1F9EA} DRY RUN MODE -- write tools will skip actual changes');
  }
  console.log('');

  const { workspace, mcpServers, octokit, owner, repo } = await setupSdkAgent(config, issueNumber, options);

  // Build subagent definitions
  const agents: Record<string, AgentDefinition> = {
    issuer: {
      description: 'Understands GitHub issues — explores repo, posts analysis comment, produces brief.',
      tools: ['Read', 'Glob', 'Grep',
        'mcp__github__fetch_github_issues', 'mcp__github__comment_on_issue',
        'mcp__github__fetch_sub_issues', 'mcp__github__get_parent_issue',
        'mcp__context__save_issue_context', 'mcp__context__get_issue_context', 'mcp__context__search_past_issues'],
      prompt: adaptPromptForSdk(buildIssuerSystemPrompt(owner, repo)),
      model: mapToSdkModel(config, 'issuer'),
    },
    coder: {
      description: 'Implements changes — branches, edits, commits, pushes, opens PRs.',
      tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
        'mcp__github__comment_on_issue', 'mcp__github__create_pull_request', 'mcp__github__create_sub_issue',
        'mcp__context__save_issue_context', 'mcp__context__get_issue_context'],
      prompt: adaptPromptForSdk(buildCoderSystemPrompt(owner, repo)),
      model: mapToSdkModel(config, 'coder'),
    },
    reviewer: {
      description: 'Reviews PRs — fetches diff, posts structured review with verdict.',
      tools: ['Read', 'Glob', 'Grep',
        'mcp__github__get_pr_diff', 'mcp__github__submit_pr_review',
        'mcp__context__save_issue_context', 'mcp__context__get_issue_context'],
      prompt: adaptPromptForSdk(buildReviewerSystemPrompt(owner, repo)),
      model: mapToSdkModel(config, 'reviewer'),
    },
  };

  // Build architect system prompt adapted for SDK
  let architectPrompt = adaptPromptForSdk(buildArchitectSystemPrompt(owner, repo, maxIterations));
  architectPrompt += `\n\nIMPORTANT — SDK MODE:
You have three subagents: issuer, coder, reviewer. Use the Task tool to delegate to them.
Built-in tools (Read, Glob, Grep) are available for your own verification.
GitHub tools are prefixed with mcp__github__, context tools with mcp__context__.`;

  // Build user message
  let userMessage: string;
  if (options.continueContext) {
    const { prNumber, branchName, humanFeedback } = options.continueContext;
    userMessage = `Continue working on issue #${issueNumber}. A PR #${prNumber} already exists on branch "${branchName}".

Skip the issuer step — go directly to the reviewer:
1. Delegate to reviewer: "Review PR #${prNumber}"
2. If the reviewer's verdict is "needs_changes", delegate to coder with the feedback
3. Then delegate to reviewer again.
4. Repeat the review→fix cycle up to the iteration limit.
5. Report the final outcome.`;
    if (humanFeedback) {
      userMessage += `\n\nIMPORTANT — Human feedback:\n\n${humanFeedback}`;
    }
  } else {
    userMessage = `Process issue #${issueNumber}. Delegate to your team to understand, implement, and review a fix for this issue.`;
  }

  console.log('='.repeat(60));

  // SDK options
  const abortController = new AbortController();
  if (options.signal) {
    options.signal.addEventListener('abort', () => abortController.abort());
  }

  const sdkOptions: SdkOptions = {
    tools: ['Read', 'Glob', 'Grep', 'Task'],
    allowedTools: ['Read', 'Glob', 'Grep', 'Task',
      'mcp__github__fetch_github_issues', 'mcp__github__check_ci_status',
      'mcp__context__save_issue_context', 'mcp__context__get_issue_context', 'mcp__context__search_past_issues'],
    agents,
    cwd: workspace.path,
    permissionMode: config.claudeSdk.permissionMode,
    allowDangerouslySkipPermissions: config.claudeSdk.permissionMode === 'bypassPermissions',
    maxTurns: config.claudeSdk.maxTurns,
    maxBudgetUsd: config.claudeSdk.maxBudgetUsd,
    model: sdkModel,
    systemPrompt: architectPrompt,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: config.llm.apiKey!,
      GIT_TERMINAL_PROMPT: '0',
    },
    mcpServers,
    abortController,
    settingSources: [],
    persistSession: false,
  };

  let lastResponse = '';
  let sessionId = '';
  // Track subagent lifecycle
  const activeTasks = new Map<string, { type: string; startTime: number }>();
  let reviewerCount = 0;

  try {
    const conversation = query({ prompt: userMessage, options: sdkOptions });

    for await (const msg of conversation) {
      if (options.signal?.aborted) {
        conversation.close();
        break;
      }

      if (msg.type === 'system') {
        const sysMsg = msg as SDKSystemMessage | SDKTaskStartedMessage | SDKTaskNotificationMessage;

        if ('subtype' in sysMsg && sysMsg.subtype === 'init') {
          const initMsg = sysMsg as SDKSystemMessage;
          sessionId = initMsg.session_id;
          logAgentEvent('architect', `SDK session ${sessionId} initialized (model: ${initMsg.model})`);
        } else if ('subtype' in sysMsg && sysMsg.subtype === 'task_started') {
          const taskMsg = sysMsg as SDKTaskStartedMessage;
          activeTasks.set(taskMsg.task_id, {
            type: taskMsg.task_type ?? taskMsg.description ?? 'unknown',
            startTime: performance.now(),
          });
          const agentType = taskMsg.task_type ?? taskMsg.description ?? 'unknown';
          logAgentEvent('architect', `\u2192 ${agentType.toUpperCase()}`, taskMsg.description);
          options.onProgress?.({
            phase: agentType,
            action: 'started',
            runId: taskMsg.task_id,
            detail: taskMsg.description,
          });
        } else if ('subtype' in sysMsg && sysMsg.subtype === 'task_notification') {
          const notifMsg = sysMsg as SDKTaskNotificationMessage;
          const task = activeTasks.get(notifMsg.task_id);
          if (task) {
            const duration = formatDuration(performance.now() - task.startTime);
            logAgentEvent(task.type, `${notifMsg.status} (${duration})`);
            if (notifMsg.summary) {
              logAgentDetail(`${task.type} output`, notifMsg.summary);
            }

            if (task.type === 'reviewer' || task.type.includes('reviewer')) {
              reviewerCount++;
            }

            options.onProgress?.({
              phase: task.type,
              action: 'completed',
              runId: notifMsg.task_id,
              iteration: reviewerCount || undefined,
              maxIterations,
            });
            activeTasks.delete(notifMsg.task_id);
          }
        }
      } else if (msg.type === 'assistant') {
        const assistantMsg = msg as SDKAssistantMessage;
        // Only track architect-level messages (not subagent)
        if (!assistantMsg.parent_tool_use_id) {
          const content = assistantMsg.message?.content;
          if (Array.isArray(content)) {
            const textParts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
            if (textParts.length > 0) {
              lastResponse = textParts.join('\n');
              logAgentEvent('architect', 'reasoning', lastResponse);
              options.onProgress?.({
                phase: 'architect',
                action: 'reasoning',
                detail: lastResponse.slice(0, 200),
              });
            }
          }
        }
      } else if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          const success = resultMsg as SDKResultSuccess;
          if (success.result) lastResponse = success.result;

          // Record usage
          if (options.usageService) {
            try {
              const usage = success.usage;
              // Record per-model usage from modelUsage breakdown
              if (success.modelUsage) {
                for (const [modelKey, modelUsage] of Object.entries(success.modelUsage)) {
                  options.usageService.record({
                    provider: config.llm.provider as LLMProvider,
                    model: modelKey,
                    agent: 'architect',
                    processId: options.processId,
                    issueNumber,
                    inputTokens: modelUsage.inputTokens,
                    outputTokens: modelUsage.outputTokens,
                    durationMs: success.duration_ms,
                  });
                }
              } else {
                options.usageService.record({
                  provider: config.llm.provider as LLMProvider,
                  model: sdkModel ?? config.llm.model ?? 'unknown',
                  agent: 'architect',
                  processId: options.processId,
                  issueNumber,
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                  durationMs: success.duration_ms,
                });
              }
            } catch { /* best-effort */ }
          }

          logAgentEvent('architect', `completed (${formatDuration(success.duration_ms)}, $${success.total_cost_usd.toFixed(4)})`);
        } else {
          logAgentEvent('architect', `error: ${resultMsg.subtype}`);
        }
      }
    }
  } finally {
    console.log(`\u{1F9F9} Cleaning up workspace at ${workspace.path}`);
    await workspace.cleanup();
  }

  console.log('='.repeat(60));
  console.log('\n\u{2705} Claude SDK multi-agent completed!\n');

  // Auto-save outcome
  if (options.contextRepo && lastResponse && issueNumber > 0) {
    try {
      await options.contextRepo.addEntry({
        repoId: options.repoId ?? 0, issueNumber,
        processId: options.processId ?? null,
        entryType: 'outcome', agent: 'architect:auto',
        content: lastResponse.slice(0, 10000), filesTouched: [],
        iteration: reviewerCount,
      });
    } catch { /* best-effort */ }
  }

  const outcome = lastResponse || 'No response captured from Claude SDK architect.';
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

  // Post usage summary
  if (options.usageService && options.processId && !options.dryRun) {
    try {
      const comment = await formatUsageSummaryComment(options.usageService, options.processId);
      if (comment) {
        await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: comment });
        console.log(`\n\u{1F4CA} Usage summary posted to issue #${issueNumber}`);
      }
    } catch (err) {
      console.warn(`\u{26A0}\uFE0F  Could not post usage summary: ${err}`);
    }
  }

  return { issueNumber, prNumber, prNumbers, outcome };
}
