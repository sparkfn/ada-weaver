/**
 * Claude Agent SDK — MCP server factories for GitHub and context tools.
 *
 * Two factories that create in-process MCP servers for the Claude Agent SDK:
 * - createGitHubMcpServer(): wraps GitHub API operations
 * - createContextMcpServer(): wraps cross-agent context tools
 *
 * SDK built-in tools (Read, Edit, Write, Bash, Glob, Grep) replace our
 * custom local-tools.ts when cwd is set to the workspace path.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Octokit } from 'octokit';
import { withRetry } from './utils.js';
import type { IssueContextRepository, IssueContextEntryType } from './issue-context-repository.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ISSUE_BODY_CHARS = 2_000;
const MAX_CI_SUMMARY_CHARS = 1_000;
const MAX_DIFF_LENGTH = 15_000;
const BOT_COMMENT_MARKER = '<!-- deep-agent-analysis -->';
const BOT_REVIEW_MARKER = '<!-- deep-agent-review -->';
const REVIEW_FOOTER = '\n\n> This is an automated review by deep-agents. A human should verify before merging.';

const VALID_ENTRY_TYPES: IssueContextEntryType[] = [
  'issuer_brief', 'architect_plan', 'coder_plan', 'review_feedback', 'ci_result', 'outcome',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateBody(body: string | null, maxChars: number): string {
  if (!body) return '(no description)';
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars) + `\n[... body truncated at ${maxChars} chars (original: ${body.length} chars)]`;
}

function truncateSummary(summary: string | undefined | null, maxChars: number): string | null {
  if (!summary) return null;
  if (summary.length <= maxChars) return summary;
  return summary.slice(0, maxChars) + `\n[... summary truncated at ${maxChars} chars (original: ${summary.length} chars)]`;
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function dryRunResult(action: string) {
  return textResult({ dry_run: true, would_have: action });
}

// ── GitHub MCP Server ────────────────────────────────────────────────────────

/**
 * Create an in-process MCP server wrapping all GitHub API tools.
 * Tools are prefixed with `mcp__github__` by the SDK.
 */
export function createGitHubMcpServer(
  owner: string,
  repo: string,
  octokit: Octokit,
  opts: { dryRun?: boolean } = {},
): McpSdkServerConfigWithInstance {
  const dryRun = opts.dryRun ?? false;

  return createSdkMcpServer({
    name: 'github',
    version: '1.0.0',
    tools: [
      // ── fetch_github_issues ──
      {
        name: 'fetch_github_issues',
        description: 'Fetch issues from a GitHub repository. Supports state filter and since timestamp.',
        inputSchema: {
          state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter'),
          limit: z.number().optional().describe('Maximum issues to return (default 5)'),
          since: z.string().optional().describe('ISO 8601 timestamp — only issues updated after this date'),
        },
        handler: async (args: { state?: 'open' | 'closed' | 'all'; limit?: number; since?: string }) => {
          try {
            const effectiveLimit = args.limit ?? 5;
            const params: Parameters<typeof octokit.rest.issues.listForRepo>[0] = {
              owner, repo, state: args.state ?? 'open', per_page: effectiveLimit, sort: 'updated', direction: 'desc',
            };
            if (args.since) params.since = args.since;
            const { data: issues } = await withRetry(() => octokit.rest.issues.listForRepo(params));
            const formatted = issues.map((issue) => ({
              number: issue.number, title: issue.title, body: truncateBody(issue.body, MAX_ISSUE_BODY_CHARS),
              state: issue.state, created_at: issue.created_at, updated_at: issue.updated_at,
              url: issue.html_url, labels: issue.labels.map((l) => l.name),
            }));
            return textResult(formatted);
          } catch (error) {
            return textResult({ error: `Error fetching issues: ${error}` });
          }
        },
      },

      // ── comment_on_issue ──
      {
        name: 'comment_on_issue',
        description: 'Post a comment on a GitHub issue. Idempotent: skips if analysis comment already exists.',
        inputSchema: {
          issue_number: z.number().describe('Issue number'),
          body: z.string().describe('Comment body (Markdown)'),
        },
        handler: async (args: { issue_number: number; body: string }) => {
          if (dryRun) return dryRunResult(`comment on issue #${args.issue_number}`);
          try {
            const { data: existingComments } = await withRetry(() => octokit.rest.issues.listComments({
              owner, repo, issue_number: args.issue_number, per_page: 100,
            }));
            if (existingComments.some((c) => c.body?.includes(BOT_COMMENT_MARKER))) {
              return textResult({ skipped: true, reason: 'Analysis comment already exists.' });
            }
            const markedBody = `${BOT_COMMENT_MARKER}\n${args.body}`;
            const { data: comment } = await withRetry(() => octokit.rest.issues.createComment({
              owner, repo, issue_number: args.issue_number, body: markedBody,
            }));
            return textResult({ id: comment.id, html_url: comment.html_url, created_at: comment.created_at });
          } catch (error) {
            return textResult({ error: `Error commenting on issue #${args.issue_number}: ${error}` });
          }
        },
      },

      // ── create_pull_request ──
      {
        name: 'create_pull_request',
        description: 'Open a pull request. Idempotent: skips if open PR already exists for the same branch.',
        inputSchema: {
          title: z.string().describe('PR title'),
          body: z.string().describe('PR description with "Closes #N"'),
          head: z.string().describe('Branch containing changes'),
          base: z.string().optional().describe('Target branch (default: main)'),
        },
        handler: async (args: { title: string; body: string; head: string; base?: string }) => {
          if (dryRun) return dryRunResult(`create PR "${args.title}"`);
          try {
            const base = args.base ?? 'main';
            const { data: existing } = await withRetry(() => octokit.rest.pulls.list({
              owner, repo, head: `${owner}:${args.head}`, base, state: 'open',
            }));
            if (existing.length > 0) {
              return textResult({ skipped: true, reason: `Open PR #${existing[0].number} already exists.`, number: existing[0].number, html_url: existing[0].html_url });
            }
            const { data: pr } = await withRetry(() => octokit.rest.pulls.create({
              owner, repo, title: args.title, body: args.body, head: args.head, base,
            }));
            return textResult({ number: pr.number, html_url: pr.html_url, state: pr.state });
          } catch (error) {
            return textResult({ error: `Error creating PR: ${error}` });
          }
        },
      },

      // ── get_pr_diff ──
      {
        name: 'get_pr_diff',
        description: 'Fetch unified diff for a PR. Truncated to 15,000 chars.',
        inputSchema: {
          pull_number: z.number().describe('PR number'),
        },
        handler: async (args: { pull_number: number }) => {
          try {
            const { data } = await withRetry(() => octokit.rest.pulls.get({
              owner, repo, pull_number: args.pull_number, mediaType: { format: 'diff' },
            }));
            let diff = data as unknown as string;
            if (diff.length > MAX_DIFF_LENGTH) {
              diff = diff.slice(0, MAX_DIFF_LENGTH) + `\n\n... (truncated at ${MAX_DIFF_LENGTH} chars, total: ${diff.length})`;
            }
            return { content: [{ type: 'text' as const, text: diff }] };
          } catch (error) {
            return textResult({ error: `Error fetching diff for PR #${args.pull_number}: ${error}` });
          }
        },
      },

      // ── submit_pr_review ──
      {
        name: 'submit_pr_review',
        description: 'Submit a COMMENT review on a PR. Idempotent: skips if bot review exists.',
        inputSchema: {
          pull_number: z.number().describe('PR number'),
          body: z.string().describe('Review summary (Markdown)'),
          comments: z.array(z.object({
            path: z.string().describe('File path'),
            line: z.number().describe('Line number'),
            body: z.string().describe('Inline comment'),
          })).optional().describe('Optional inline comments'),
        },
        handler: async (args: { pull_number: number; body: string; comments?: Array<{ path: string; line: number; body: string }> }) => {
          if (dryRun) return dryRunResult(`submit review on PR #${args.pull_number}`);
          try {
            const { data: existingReviews } = await withRetry(() => octokit.rest.pulls.listReviews({
              owner, repo, pull_number: args.pull_number, per_page: 100,
            }));
            if (existingReviews.some((r) => r.body?.includes(BOT_REVIEW_MARKER))) {
              return textResult({ skipped: true, reason: 'Bot review already exists.' });
            }
            const markedBody = `${BOT_REVIEW_MARKER}\n${args.body}${REVIEW_FOOTER}`;
            const reviewParams: Parameters<typeof octokit.rest.pulls.createReview>[0] = {
              owner, repo, pull_number: args.pull_number, body: markedBody, event: 'COMMENT',
            };
            if (args.comments?.length) {
              reviewParams.comments = args.comments.map((c) => ({ path: c.path, line: c.line, body: c.body }));
            }
            const { data: review } = await withRetry(() => octokit.rest.pulls.createReview(reviewParams));
            return textResult({ id: review.id, html_url: review.html_url, state: review.state });
          } catch (error) {
            return textResult({ error: `Error submitting review on PR #${args.pull_number}: ${error}` });
          }
        },
      },

      // ── check_ci_status ──
      {
        name: 'check_ci_status',
        description: 'Check CI status for a PR. Returns overall/total/completed/failed breakdown.',
        inputSchema: {
          pull_number: z.number().describe('PR number'),
        },
        handler: async (args: { pull_number: number }) => {
          if (dryRun) return textResult({ dry_run: true, overall: 'success', checks: [] });
          try {
            const { data: pr } = await withRetry(() => octokit.rest.pulls.get({ owner, repo, pull_number: args.pull_number }));
            const { data: checkData } = await withRetry(() => octokit.rest.checks.listForRef({ owner, repo, ref: pr.head.sha }));
            const checkRuns = checkData.check_runs;
            if (checkRuns.length === 0) {
              return textResult({ overall: 'no_checks', total: 0, completed: 0, failed: 0, checks: [] });
            }
            const checks = checkRuns.map((cr) => ({
              name: cr.name, status: cr.status, conclusion: cr.conclusion,
              output_summary: truncateSummary(cr.output?.summary, MAX_CI_SUMMARY_CHARS),
            }));
            const total = checkRuns.length;
            const completed = checkRuns.filter((cr) => cr.status === 'completed').length;
            const failed = checkRuns.filter((cr) =>
              cr.status === 'completed' && (cr.conclusion === 'failure' || cr.conclusion === 'timed_out'),
            ).length;
            const overall = completed < total ? 'in_progress' : failed > 0 ? 'failure' : 'success';
            return textResult({ overall, total, completed, failed, checks });
          } catch (error) {
            return textResult({ error: `Error checking CI for PR #${args.pull_number}: ${error}` });
          }
        },
      },

      // ── fetch_sub_issues ──
      {
        name: 'fetch_sub_issues',
        description: 'Fetch sub-issues (children) of a GitHub issue.',
        inputSchema: {
          issue_number: z.number().describe('Parent issue number'),
        },
        handler: async (args: { issue_number: number }) => {
          try {
            const { data: subIssues } = await withRetry(() => octokit.request(
              'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
              { owner, repo, issue_number: args.issue_number, per_page: 100 },
            ));
            const formatted = (subIssues as any[]).map((si: any) => ({
              id: si.id, number: si.number, title: si.title,
              body: truncateBody(si.body, MAX_ISSUE_BODY_CHARS), state: si.state,
              labels: (si.labels || []).map((l: any) => typeof l === 'string' ? l : l.name ?? ''),
            }));
            return textResult(formatted);
          } catch (error) {
            return textResult({ error: `Error fetching sub-issues for #${args.issue_number}: ${error}` });
          }
        },
      },

      // ── get_parent_issue ──
      {
        name: 'get_parent_issue',
        description: 'Get the parent issue of a sub-issue. Returns { parent: null } if none.',
        inputSchema: {
          issue_number: z.number().describe('Issue number'),
        },
        handler: async (args: { issue_number: number }) => {
          try {
            const { data: parent } = await withRetry(() => octokit.request(
              'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/parent',
              { owner, repo, issue_number: args.issue_number },
            ));
            const p = parent as any;
            return textResult({
              parent: {
                id: p.id, number: p.number, title: p.title,
                body: truncateBody(p.body, MAX_ISSUE_BODY_CHARS), state: p.state,
                labels: (p.labels || []).map((l: any) => typeof l === 'string' ? l : l.name ?? ''),
              },
            });
          } catch (error: unknown) {
            if ((error as { status?: number }).status === 404) {
              return textResult({ parent: null });
            }
            return textResult({ error: `Error fetching parent of #${args.issue_number}: ${error}` });
          }
        },
      },

      // ── create_sub_issue ──
      {
        name: 'create_sub_issue',
        description: 'Create a sub-issue under a parent issue.',
        inputSchema: {
          parent_issue_number: z.number().describe('Parent issue number'),
          title: z.string().describe('Sub-issue title'),
          body: z.string().describe('Sub-issue body'),
          labels: z.array(z.string()).optional().describe('Labels'),
        },
        handler: async (args: { parent_issue_number: number; title: string; body: string; labels?: string[] }) => {
          if (dryRun) return dryRunResult(`create sub-issue under #${args.parent_issue_number}`);
          try {
            const createParams: Parameters<typeof octokit.rest.issues.create>[0] = {
              owner, repo, title: args.title, body: args.body,
            };
            if (args.labels?.length) createParams.labels = args.labels;
            const { data: newIssue } = await withRetry(() => octokit.rest.issues.create(createParams));
            await withRetry(() => octokit.request(
              'POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
              { owner, repo, issue_number: args.parent_issue_number, sub_issue_id: newIssue.id },
            ));
            return textResult({ id: newIssue.id, number: newIssue.number, title: newIssue.title, html_url: newIssue.html_url, parent_issue_number: args.parent_issue_number });
          } catch (error) {
            return textResult({ error: `Error creating sub-issue under #${args.parent_issue_number}: ${error}` });
          }
        },
      },
    ],
  });
}

// ── Context MCP Server ───────────────────────────────────────────────────────

/**
 * Create an in-process MCP server wrapping context tools.
 * Tools are prefixed with `mcp__context__` by the SDK.
 */
export function createContextMcpServer(
  contextRepo: IssueContextRepository,
  repoId: number,
  issueNumber: number,
  processId: string | null,
  agentName: string,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'context',
    version: '1.0.0',
    tools: [
      // ── save_issue_context ──
      {
        name: 'save_issue_context',
        description: 'Save a context entry for this issue. Other agents can read it.',
        inputSchema: {
          entry_type: z.enum(VALID_ENTRY_TYPES as [string, ...string[]])
            .describe('Type: issuer_brief, architect_plan, coder_plan, review_feedback, ci_result, or outcome'),
          content: z.string().describe('The content to save'),
          files_touched: z.array(z.string()).optional().describe('Relevant file paths'),
          iteration: z.number().optional().describe('Current iteration number'),
        },
        handler: async (args: { entry_type: string; content: string; files_touched?: string[]; iteration?: number }) => {
          try {
            const entry = await contextRepo.addEntry({
              repoId, issueNumber, processId,
              entryType: args.entry_type as IssueContextEntryType,
              agent: agentName,
              content: args.content,
              filesTouched: args.files_touched ?? [],
              iteration: args.iteration ?? 0,
            });
            return textResult({ saved: true, id: entry.id, entry_type: args.entry_type });
          } catch (error) {
            return textResult({ error: `Error saving context: ${error}` });
          }
        },
      },

      // ── get_issue_context ──
      {
        name: 'get_issue_context',
        description: 'Read shared context entries from this pipeline run.',
        inputSchema: {
          entry_type: z.enum(VALID_ENTRY_TYPES as [string, ...string[]])
            .optional().describe('Optional filter by entry type'),
        },
        handler: async (args: { entry_type?: string }) => {
          try {
            if (!processId) return textResult({ entries: [], message: 'No process ID — context unavailable.' });
            const entries = await contextRepo.getEntriesForProcess(processId);
            const filtered = args.entry_type ? entries.filter(e => e.entryType === args.entry_type) : entries;
            if (filtered.length === 0) return textResult({ entries: [], message: 'No context entries found.' });
            const result = filtered.map(e => ({
              entry_type: e.entryType, agent: e.agent, content: e.content,
              files_touched: e.filesTouched, iteration: e.iteration, created_at: e.createdAt,
            }));
            return textResult({ entries: result });
          } catch (error) {
            return textResult({ error: `Error reading context: ${error}` });
          }
        },
      },

      // ── search_past_issues ──
      {
        name: 'search_past_issues',
        description: 'Search past issues by file overlap or recency for cross-run learning.',
        inputSchema: {
          files: z.array(z.string()).optional().describe('File paths to search for overlap'),
          limit: z.number().optional().describe('Max results (default 10)'),
        },
        handler: async (args: { files?: string[]; limit?: number }) => {
          try {
            let results;
            if (args.files?.length) {
              results = await contextRepo.searchByFiles(repoId, args.files, {
                limit: args.limit ?? 10, excludeIssueNumber: issueNumber,
              });
            } else {
              results = await contextRepo.searchRecent(repoId, {
                limit: args.limit ?? 10, excludeIssueNumber: issueNumber,
              });
            }
            if (results.length === 0) return textResult({ past_issues: [], message: 'No past issues found.' });
            const grouped = new Map<number, typeof results>();
            for (const r of results) {
              const group = grouped.get(r.issueNumber);
              if (group) group.push(r); else grouped.set(r.issueNumber, [r]);
            }
            const pastIssues = Array.from(grouped.entries()).map(([num, entries]) => ({
              issue_number: num,
              entries: entries.map(e => ({
                entry_type: e.entryType, agent: e.agent, content: e.content,
                files_touched: e.filesTouched, iteration: e.iteration,
              })),
            }));
            return textResult({ past_issues: pastIssues });
          } catch (error) {
            return textResult({ error: `Error searching past issues: ${error}` });
          }
        },
      },
    ],
  });
}
