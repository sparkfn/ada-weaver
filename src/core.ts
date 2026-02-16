import fs from 'fs';
import path from 'path';
import type { Config } from './config.js';
import { createGitHubClient, getAuthFromConfig } from './github-tools.js';
import type { Octokit } from 'octokit';
import { withRetry } from './utils.js';
import { runArchitect } from './architect.js';
import type { PollRepository } from './poll-repository.js';
import { FilePollRepository } from './poll-repository.js';
import { UsageService } from './usage-service.js';
import type { IssueContextRepository } from './issue-context-repository.js';

// ── Issue data interface ─────────────────────────────────────────────────────

/**
 * Shared interface for issue data used across enrichment and analysis.
 * All new fields are optional for backward compatibility.
 */
export interface IssueData {
  number: number;
  title: string;
  body: string;
  labels: string[];
  id?: number;                    // internal GitHub ID, needed for sub-issue API
  subIssues?: IssueData[];        // populated by enrichment
  parentIssue?: { number: number; title: string; body: string };
}

// ── Sub-issue enrichment ─────────────────────────────────────────────────────

/**
 * Enrich issues with sub-issue and parent data.
 * Non-fatal: if API calls fail, proceed without enrichment (log warning).
 * 404 on parent endpoint = no parent (normal, not an error).
 */
export async function enrichSubIssueData(
  issues: IssueData[],
  owner: string,
  repo: string,
  octokit: Octokit,
): Promise<void> {
  for (const issue of issues) {
    // Fetch sub-issues
    try {
      const { data: subIssues } = await octokit.request(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
        { owner, repo, issue_number: issue.number, per_page: 100 },
      );
      const children = (subIssues as any[]);
      if (children.length > 0) {
        issue.subIssues = children.map((si: any) => ({
          number: si.number,
          title: si.title,
          body: si.body || '(no description)',
          labels: (si.labels || []).map((l: any) => typeof l === 'string' ? l : l.name ?? ''),
          id: si.id,
        }));
        console.log(`🔗 Issue #${issue.number} has ${children.length} sub-issue(s)`);
      }
    } catch (error) {
      console.warn(`⚠️  Could not fetch sub-issues for #${issue.number}: ${error}`);
    }

    // Check for parent
    try {
      const { data: parent } = await octokit.request(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/parent',
        { owner, repo, issue_number: issue.number },
      );
      const p = parent as any;
      issue.parentIssue = {
        number: p.number,
        title: p.title,
        body: p.body || '(no description)',
      };
      console.log(`🔗 Issue #${issue.number} is a sub-issue of #${p.number}`);
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status !== 404) {
        console.warn(`⚠️  Could not fetch parent for #${issue.number}: ${error}`);
      }
      // 404 = no parent, which is normal
    }
  }
}

/**
 * Deduplicate issue hierarchy: if a parent and its children both appear
 * as top-level issues, remove the children (they're nested under parent's subIssues).
 * Also removes issues that reference a parent via parentIssue when that parent is in the batch.
 */
export function deduplicateIssueHierarchy(issues: IssueData[]): IssueData[] {
  const issueNumbers = new Set(issues.map((i) => i.number));
  const childNumbers = new Set<number>();

  for (const issue of issues) {
    // Children nested under a parent's subIssues
    if (issue.subIssues) {
      for (const child of issue.subIssues) {
        if (issueNumbers.has(child.number)) {
          childNumbers.add(child.number);
        }
      }
    }

    // Issues that know their parent (and the parent is in this batch)
    if (issue.parentIssue && issueNumbers.has(issue.parentIssue.number)) {
      childNumbers.add(issue.number);
    }
  }

  if (childNumbers.size > 0) {
    console.log(`🔗 Deduplication: removing ${childNumbers.size} child issue(s) from top-level: ${[...childNumbers].join(', ')}`);
  }

  return issues.filter((i) => !childNumbers.has(i.number));
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

/**
 * When true, the poll cycle will finish its current issue and exit cleanly
 * instead of picking up the next issue. Set by SIGTERM/SIGINT handlers.
 */
let shuttingDown = false;

export function requestShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Reset shutdown flag. Used in tests to restore clean state.
 */
export function resetShutdown(): void {
  shuttingDown = false;
}

/**
 * Per-issue action tracking. Records which workflow steps have been
 * completed so the agent can resume partially-processed issues.
 * v0.3.4: enriched with full response metadata for retraction capability.
 */
export interface IssueActions {
  comment: { id: number; html_url: string } | null;
  branch: { name: string; sha: string } | null;
  commits: Array<{ path: string; sha: string; commit_sha: string }>;
  pr: { number: number; html_url: string } | null;
}

/**
 * Polling state -- tracks which issues we have already processed
 * and what actions were taken for each one.
 */
export interface PollState {
  lastPollTimestamp: string;
  lastPollIssueNumbers: number[];
  /** Per-issue action tracking (added in v0.2.10). */
  issues?: Record<string, IssueActions>;
}

const POLL_STATE_FILE = path.resolve('./last_poll.json');

/**
 * Maximum number of issues to process per run (default).
 * Can be overridden via MAX_ISSUES_PER_RUN env var or --max-issues CLI flag.
 */
const DEFAULT_MAX_ISSUES_PER_RUN = 5;

/**
 * Maximum number of tool calls per run (default).
 * Prevents runaway agent loops from burning API credits.
 * Can be overridden via MAX_TOOL_CALLS_PER_RUN env var or --max-tool-calls CLI flag.
 */
const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 30;

export function loadPollState(): PollState | null {
  if (!fs.existsSync(POLL_STATE_FILE)) return null;
  const raw = JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf-8'));
  return migratePollState(raw);
}

/**
 * Check if an issue actions entry uses the old v0.2.10 boolean format.
 */
function isOldActionFormat(entry: any): boolean {
  return typeof entry.commented === 'boolean';
}

/**
 * Migrate a single v0.2.10 boolean action entry to the enriched format.
 */
function migrateActionEntry(old: any): IssueActions {
  return {
    comment: old.commented ? { id: 0, html_url: '' } : null,
    branch: old.branch ? { name: old.branch, sha: '' } : null,
    commits: [],
    pr: (old.pr !== null && old.pr > 0) ? { number: old.pr, html_url: '' } : null,
  };
}

/**
 * Migrate poll state across 3 format generations:
 *   Case 1: pre-v0.2.10 — no `issues` field at all
 *   Case 2: v0.2.10 — `issues` with boolean format { commented, branch, pr }
 *   Case 3: v0.3.4+ — enriched format { comment, branch, commits, pr }
 */
export function migratePollState(raw: any): PollState {
  // Case 1: pre-v0.2.10 — no issues field
  if (!raw.issues) {
    const issues: Record<string, IssueActions> = {};
    for (const num of raw.lastPollIssueNumbers ?? []) {
      issues[String(num)] = { comment: { id: 0, html_url: '' }, branch: null, commits: [], pr: null };
    }
    return {
      lastPollTimestamp: raw.lastPollTimestamp,
      lastPollIssueNumbers: raw.lastPollIssueNumbers ?? [],
      issues,
    };
  }

  // Case 2: v0.2.10 boolean format
  const entries = Object.values(raw.issues);
  if (entries.length > 0 && isOldActionFormat(entries[0])) {
    const migrated: Record<string, IssueActions> = {};
    for (const [num, entry] of Object.entries(raw.issues)) {
      migrated[num] = migrateActionEntry(entry);
    }
    return {
      lastPollTimestamp: raw.lastPollTimestamp,
      lastPollIssueNumbers: raw.lastPollIssueNumbers ?? [],
      issues: migrated,
    };
  }

  // Case 3: already enriched format
  // Strip triageResults if present (legacy field from pre-Architect era)
  const { triageResults, ...state } = raw;
  return state as PollState;
}

export function savePollState(state: PollState): void {
  fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Resolve the effective max issues value from config.
 */
export function getMaxIssues(config: Config): number {
  const raw = config.maxIssuesPerRun;
  return (typeof raw === 'number' && raw > 0) ? raw : DEFAULT_MAX_ISSUES_PER_RUN;
}

/**
 * Resolve the effective max tool calls value from config.
 */
export function getMaxToolCalls(config: Config): number {
  const raw = config.maxToolCallsPerRun;
  return (typeof raw === 'number' && raw > 0) ? raw : DEFAULT_MAX_TOOL_CALLS_PER_RUN;
}

/**
 * Fetch issues from GitHub that are new/updated since the last poll.
 * Returns formatted issue objects.
 */
async function fetchIssuesForPoll(
  config: Config,
  maxIssues: number,
  sinceDate: string | null,
): Promise<IssueData[]> {
  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  const params: Record<string, any> = {
    owner,
    repo,
    state: 'open',
    per_page: maxIssues,
    sort: 'updated',
    direction: 'desc',
  };
  if (sinceDate) params.since = sinceDate;

  const { data: issues } = await octokit.rest.issues.listForRepo(params);

  const mapped: IssueData[] = issues.map((issue: any) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body || '(no description)',
    labels: issue.labels.map((l: any) => typeof l === 'string' ? l : l.name ?? ''),
    id: issue.id,
  }));

  // Enrich with sub-issue data (non-fatal)
  await enrichSubIssueData(mapped, owner, repo, octokit);

  return mapped;
}

/**
 * Run a full poll cycle: fetch new issues, deduplicate, process via Architect.
 *
 * The Architect supervisor handles everything: issue understanding (Issuer),
 * implementation (Coder), and review (Reviewer). No separate triage phase needed.
 */
export async function runPollCycle(config: Config, options: { noSave?: boolean; dryRun?: boolean; maxIssues?: number; maxToolCalls?: number; pollRepository?: PollRepository; repoId?: number; issueContextRepository?: IssueContextRepository } = {}): Promise<void> {
  const maxIssues = options.maxIssues ?? getMaxIssues(config);
  // Dry run implies no-save (never persist state when skipping writes)
  const skipSave = options.noSave || options.dryRun;
  const pollRepo = options.pollRepository ?? new FilePollRepository();
  const repoId = options.repoId ?? 0;

  console.log(`\u{2705} Config loaded: ${config.github.owner}/${config.github.repo}`);
  console.log(`\u{1F6E1}\uFE0F  Max issues per run: ${maxIssues}`);
  if (options.dryRun) {
    console.log('\u{1F9EA} DRY RUN MODE -- GitHub writes (comments, branches, PRs) will be SKIPPED');
    console.log('   Read operations (fetch issues, list files, read files) still execute.');
    console.log('   Poll state will NOT be saved.');
  } else if (options.noSave) {
    console.log('\u{1F9EA} NO-SAVE MODE -- poll state will NOT be saved after this run');
    console.log('   NOTE: GitHub operations (comments, branches, PRs) WILL still execute.');
  }
  console.log('');

  // Load polling state
  const pollState = await pollRepo.load(repoId);
  const sinceDate = pollState?.lastPollTimestamp ?? null;

  if (sinceDate) {
    console.log(`\u{1F4C5} Last poll: ${sinceDate}`);
    console.log(`\u{1F4CB} Previously processed issues: ${pollState!.lastPollIssueNumbers.join(', ')}\n`);
  } else {
    console.log('\u{1F195} First poll run -- no previous state found.\n');
  }

  const previousIssueNumbers = pollState?.lastPollIssueNumbers ?? [];

  // Fetch issues
  console.log('\u{1F50E} Fetching issues...');
  const issues = await fetchIssuesForPoll(config, maxIssues, sinceDate);

  // Filter out previously processed issues
  const newIssues = issues.filter((i) => !previousIssueNumbers.includes(i.number));

  if (newIssues.length === 0) {
    console.log('\u{2705} No new issues to process.\n');

    if (!skipSave) {
      await pollRepo.save(repoId, {
        lastPollTimestamp: new Date().toISOString(),
        lastPollIssueNumbers: previousIssueNumbers,
        issues: pollState?.issues ?? {},
      });
      console.log('\u{1F4BE} Poll state saved');
    }
    return;
  }

  // Deduplicate: remove children when their parent is also in the batch
  const deduped = deduplicateIssueHierarchy(newIssues);

  console.log(`\u{1F4CB} Found ${deduped.length} new issue(s) to process.\n`);

  // Process each issue via Architect (check shutdown flag between issues)
  const processedNumbers = [...previousIssueNumbers];
  const issueActions: Record<string, IssueActions> = { ...pollState?.issues };

  for (const issue of deduped) {
    if (isShuttingDown()) {
      console.log('\n\u{1F6D1} Shutdown requested -- stopping early, saving state...');
      break;
    }

    console.log(`\n\u{1F3D7}\uFE0F  Processing issue #${issue.number}: ${issue.title}`);
    try {
      const usageService = new UsageService();
      const processId = `poll-${issue.number}-${Date.now()}`;
      const result = await runArchitect(config, issue.number, {
        dryRun: options.dryRun,
        usageService,
        processId,
        contextRepo: options.issueContextRepository,
        repoId: options.repoId,
      });
      processedNumbers.push(issue.number);

      // Record actions from the Architect result
      if (result.prNumber) {
        issueActions[String(issue.number)] = {
          comment: null,
          branch: null,
          commits: [],
          pr: { number: result.prNumber, html_url: `https://github.com/${config.github.owner}/${config.github.repo}/pull/${result.prNumber}` },
        };
      } else {
        issueActions[String(issue.number)] = {
          comment: null,
          branch: null,
          commits: [],
          pr: null,
        };
      }
    } catch (error) {
      console.error(`\u{274C} Architect failed for issue #${issue.number}:`, error);
      processedNumbers.push(issue.number);
    }
  }

  // Save poll state
  if (!skipSave) {
    await pollRepo.save(repoId, {
      lastPollTimestamp: new Date().toISOString(),
      lastPollIssueNumbers: processedNumbers,
      issues: issueActions,
    });
    console.log('\n\u{1F4BE} Poll state saved');
  } else {
    console.log(`\n\u{1F9EA} ${options.dryRun ? 'Dry run' : 'No-save'} mode -- poll state NOT saved`);
  }
  console.log(`   Processed issues: ${processedNumbers.join(', ')}`);
}

/**
 * Find the PR created for a given issue number.
 * Looks for PRs matching "Fix #N:" in title or "issue-N-" in branch name.
 */
export async function findPrForIssue(
  config: Config,
  issueNumber: number,
): Promise<{ prNumber: number; branch: string } | null> {
  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    per_page: 30,
    sort: 'created',
    direction: 'desc',
  });

  for (const pr of prs) {
    const titleMatch = pr.title.includes(`Fix #${issueNumber}:`);
    const branchMatch = pr.head.ref.startsWith(`issue-${issueNumber}-`);
    if (titleMatch || branchMatch) {
      return { prNumber: pr.number, branch: pr.head.ref };
    }
  }

  return null;
}

/**
 * Find ALL PRs created for a given issue number.
 * Looks for PRs matching "Fix #N:" in title or "issue-N-" in branch name.
 * Returns an array of all matches (empty if none found).
 */
export async function findAllPrsForIssue(
  config: Config,
  issueNumber: number,
): Promise<Array<{ prNumber: number; branch: string }>> {
  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    per_page: 30,
    sort: 'created',
    direction: 'desc',
  });

  const matches: Array<{ prNumber: number; branch: string }> = [];

  for (const pr of prs) {
    const titleMatch = pr.title.includes(`Fix #${issueNumber}:`);
    const branchMatch = pr.head.ref.startsWith(`issue-${issueNumber}-`);
    if (titleMatch || branchMatch) {
      matches.push({ prNumber: pr.number, branch: pr.head.ref });
    }
  }

  return matches;
}

/**
 * Show current polling status (last run time, processed issues).
 */
export async function showStatus(config: Config, pollRepository?: PollRepository): Promise<void> {
  const pollRepo = pollRepository ?? new FilePollRepository();
  console.log(`\u{1F4CA} Status for ${config.github.owner}/${config.github.repo}\n`);

  const pollState = await pollRepo.load(0);

  if (!pollState) {
    console.log('No poll state found. Run `deepagents poll` to start.');
    return;
  }

  console.log(`Last poll: ${pollState.lastPollTimestamp}`);
  console.log(`Processed issues: ${pollState.lastPollIssueNumbers.length}`);

  if (pollState.lastPollIssueNumbers.length > 0) {
    console.log(`Issue numbers: ${pollState.lastPollIssueNumbers.join(', ')}`);
  }

  // Show per-issue action tracking
  if (pollState.issues && Object.keys(pollState.issues).length > 0) {
    console.log('\nPer-issue actions:');
    for (const [num, a] of Object.entries(pollState.issues)) {
      const status: string[] = [];
      status.push(a.comment ? 'commented' : 'no comment');
      status.push(a.branch ? `branch: ${a.branch.name}` : 'no branch');
      if (a.commits.length > 0) status.push(`${a.commits.length} commit(s)`);
      status.push(a.pr ? `PR #${a.pr.number}` : 'no PR');
      console.log(`  #${num}: ${status.join(', ')}`);
    }
  }

  const maxIssues = getMaxIssues(config);
  const maxToolCalls = getMaxToolCalls(config);
  console.log(`\nMax issues per run: ${maxIssues}`);
  console.log(`Max tool calls per run: ${maxToolCalls}`);
}

/**
 * Result of a retraction operation. Reports what was retracted and what failed.
 */
export interface RetractResult {
  issueNumber: number;
  prClosed: boolean;
  branchDeleted: boolean;
  commentDeleted: boolean;
  errors: string[];
}

/**
 * Retract all actions taken on a specific issue: close PR, delete branch, delete comment.
 * Order matters: close PR first (it references the branch), then delete branch, then delete comment.
 * Partial retraction is supported -- if one step fails, the others still attempt.
 */
export async function retractIssue(config: Config, issueNumber: number, pollRepository?: PollRepository): Promise<RetractResult> {
  const pollRepo = pollRepository ?? new FilePollRepository();
  const { owner, repo } = config.github;
  const octokit = createGitHubClient(getAuthFromConfig(config.github));

  const pollState = await pollRepo.load(0);
  if (!pollState) {
    throw new Error('No poll state found. Nothing to retract.');
  }

  const actions = pollState.issues?.[String(issueNumber)];
  if (!actions) {
    throw new Error(`No actions recorded for issue #${issueNumber}. Nothing to retract.`);
  }

  const result: RetractResult = {
    issueNumber,
    prClosed: false,
    branchDeleted: false,
    commentDeleted: false,
    errors: [],
  };

  // Step 1: Close PR (must happen before branch deletion)
  if (actions.pr && actions.pr.number > 0) {
    try {
      await withRetry(() => octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: actions.pr!.number,
        state: 'closed',
      }));
      result.prClosed = true;
      console.log(`  Closed PR #${actions.pr.number}`);
    } catch (error) {
      const msg = `Failed to close PR #${actions.pr.number}: ${error}`;
      result.errors.push(msg);
      console.error(`  ${msg}`);
    }
  }

  // Step 2: Delete branch
  if (actions.branch && actions.branch.name) {
    try {
      await withRetry(() => octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${actions.branch!.name}`,
      }));
      result.branchDeleted = true;
      console.log(`  Deleted branch ${actions.branch.name}`);
    } catch (error) {
      const msg = `Failed to delete branch ${actions.branch.name}: ${error}`;
      result.errors.push(msg);
      console.error(`  ${msg}`);
    }
  }

  // Step 3: Delete comment
  if (actions.comment && actions.comment.id > 0) {
    try {
      await withRetry(() => octokit.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: actions.comment!.id,
      }));
      result.commentDeleted = true;
      console.log(`  Deleted comment ${actions.comment.id}`);
    } catch (error) {
      const msg = `Failed to delete comment ${actions.comment.id}: ${error}`;
      result.errors.push(msg);
      console.error(`  ${msg}`);
    }
  }

  // Update poll state: remove the issue's actions and issue number
  delete pollState.issues![String(issueNumber)];
  pollState.lastPollIssueNumbers = pollState.lastPollIssueNumbers.filter(
    (n) => n !== issueNumber,
  );
  await pollRepo.save(0, pollState);
  console.log(`  Poll state updated (issue #${issueNumber} cleared)`);

  return result;
}
