#!/usr/bin/env node
import 'dotenv/config';

import type { Server } from 'http';
import { execSync } from 'child_process';
import { loadConfig } from './config.js';
import { runPollCycle, showStatus, retractIssue, requestShutdown } from './core.js';
import { runArchitect } from './architect.js';
import { startWebhookServer, startDialogServer } from './listener.js';
import { runReviewSingle } from './reviewer-agent.js';
import { startDashboardServer, startUnifiedServer } from './dashboard.js';
import { createGitHubClient, getAuthFromConfig } from './github-tools.js';
import { UsageService } from './usage-service.js';

// ── Signal handlers for graceful shutdown ────────────────────────────────────

let activeServer: Server | null = null;

function gracefulShutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down...`);
  requestShutdown();

  if (activeServer) {
    activeServer.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    // Force exit after 5s if connections don't drain
    setTimeout(() => process.exit(1), 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * CLI entry point for the Deep Agents GitHub Issue Poller.
 *
 * Usage:
 *   deepagents poll [--no-save] [--max-issues N]
 *   deepagents analyze --issue N
 *   deepagents status
 *
 * No external CLI framework -- uses manual process.argv parsing.
 */

const USAGE = `
Usage: deepagents <command> [options]

Commands:
  migrate           Run database migrations (requires DATABASE_URL or PG_* env vars)
  test-access       Quick read/write test against GitHub (posts + deletes a comment)
  serve             Start unified server (dashboard + webhook + dialog on one port)
  poll              Run a poll cycle: fetch, analyze, comment, branch, PR
  analyze           Analyze a single issue (Architect: understand, implement, review)
  continue          Continue review/fix cycle on an existing PR for an issue
  review            Review a pull request (fetch diff, analyze, post review comment)
  retract           Undo agent actions on an issue (close PR, delete branch, delete comment)
  webhook           Start the HTTP webhook listener for GitHub events
  dialog            Start the interactive chat server (agent + human conversation)
  dashboard         Start the web dashboard for managing agent processes
  kill              Force kill all running deepagents processes
  status            Show current polling state
  help              Show this help message

Options for 'test-access':
  --issue N         Issue number to test against
  --pr N            PR number to test against
                    (at least one of --issue or --pr is required; both can be used together)

Options for 'serve':
  --port N          Port for the unified server (default: PORT env var or 3000)

Options for 'poll':
  --dry-run           Skip all GitHub writes (comments, branches, PRs) and poll state save
  --no-save           Run without saving poll state (GitHub writes still execute)
  --max-issues N      Override maxIssuesPerRun from config

Options for 'analyze':
  --issue N         Issue number to analyze (required)
  --dry-run         Skip GitHub writes (comments, branches, PRs)

Options for 'continue':
  --issue N         Issue number (required)
  --pr N            Existing PR number (required)
  --branch NAME     Existing branch name (required)

Options for 'review':
  --pr N            Pull request number to review (required)

Options for 'retract':
  --issue N         Issue number to retract (required)

Options for 'dialog':
  --port N          Port for the dialog server (default: 3001)

Options for 'dashboard':
  --port N          Port for the dashboard server (default: 3000)

Environment variables:
  PORT=3000         Default port for 'serve' command

Examples:
  deepagents test-access --issue 1
  deepagents test-access --pr 10
  deepagents test-access --issue 1 --pr 10
  deepagents serve
  deepagents serve --port 8080
  deepagents poll
  deepagents poll --dry-run
  deepagents poll --no-save
  deepagents poll --max-issues 3
  deepagents analyze --issue 42
  deepagents analyze --issue 42 --dry-run
  deepagents review --pr 10
  deepagents continue --issue 20 --pr 21 --branch issue-20-fix
  deepagents retract --issue 42
  deepagents webhook
  deepagents dialog
  deepagents kill
  deepagents dashboard
  deepagents dashboard --port 8080
  deepagents dialog --port 8080
  deepagents status
`.trim();

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  // argv[0] = node, argv[1] = script, argv[2+] = user args
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      flags['dry-run'] = true;
    } else if (arg === '--no-save') {
      flags['no-save'] = true;
    } else if (arg === '--max-issues' && i + 1 < args.length) {
      flags['max-issues'] = args[++i];
    } else if (arg === '--max-tool-calls' && i + 1 < args.length) {
      flags['max-tool-calls'] = args[++i];
    } else if (arg === '--issue' && i + 1 < args.length) {
      flags['issue'] = args[++i];
    } else if (arg === '--pr' && i + 1 < args.length) {
      flags['pr'] = args[++i];
    } else if (arg === '--port' && i + 1 < args.length) {
      flags['port'] = args[++i];
    } else if (arg === '--branch' && i + 1 < args.length) {
      flags['branch'] = args[++i];
    } else {
      console.error(`Unknown option: ${arg}`);
      console.log(USAGE);
      process.exit(1);
    }
  }

  return { command, flags };
}

function killOrphanedProcesses() {
  const excludePids = new Set([process.pid, process.ppid]);

  let output: string;
  try {
    output = execSync(
      `ps ax -o pid=,command= | grep -E 'tsx.*src/(cli|index)\\.ts' | grep -v grep | grep -v ' kill'`,
      { encoding: 'utf-8' },
    );
  } catch {
    // grep returns exit code 1 when no matches
    console.log('No running deepagents processes found.');
    return;
  }

  const lines = output.trim().split('\n').filter(Boolean);
  const pids = lines
    .map((line) => parseInt(line.trim().split(/\s+/)[0], 10))
    .filter((pid) => !isNaN(pid) && !excludePids.has(pid));

  if (pids.length === 0) {
    console.log('No running deepagents processes found.');
    return;
  }

  console.log(`Found ${pids.length} deepagents process(es):`);
  for (const line of lines) {
    const pid = parseInt(line.trim().split(/\s+/)[0], 10);
    if (!excludePids.has(pid)) {
      console.log(`  PID ${pid}: ${line.trim().slice(line.trim().indexOf(' ') + 1)}`);
    }
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      console.log(`  Killed PID ${pid}`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        console.log(`  PID ${pid} already exited`);
      } else {
        console.error(`  Failed to kill PID ${pid}: ${err}`);
      }
    }
  }

  console.log('Done.');
}

async function main() {
  const { command, flags } = parseArgs(process.argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (command === 'kill') {
    killOrphanedProcesses();
    return;
  }

  if (command === 'migrate') {
    const { initPool, closePool } = await import('./db/connection.js');
    const { runMigrations } = await import('./db/migrate.js');

    const databaseUrl = process.env.DATABASE_URL;
    const dbConfig = {
      databaseUrl: databaseUrl || undefined,
      host: process.env.PG_HOST || undefined,
      port: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : undefined,
      database: process.env.PG_DATABASE || undefined,
      user: process.env.PG_USER || undefined,
      password: process.env.PG_PASSWORD || undefined,
    };

    if (!databaseUrl && !process.env.PG_HOST) {
      console.error('Database config required. Set DATABASE_URL or PG_HOST in .env');
      process.exit(1);
    }

    console.log('Running database migrations...\n');
    const pool = initPool(dbConfig);
    try {
      const count = await runMigrations(pool);
      console.log(count > 0 ? `\nApplied ${count} migration(s).` : '\nDatabase is up to date.');
    } finally {
      await closePool();
    }
    return;
  }

  // All commands except 'help', 'kill', and 'migrate' need config
  const config = loadConfig();

  switch (command) {
    case 'test-access': {
      const taIssueStr = flags['issue'];
      const taPrStr = flags['pr'];

      if (!taIssueStr && !taPrStr) {
        console.error('--issue N or --pr N is required for the test-access command');
        console.log('\nUsage: deepagents test-access --issue 1');
        console.log('       deepagents test-access --pr 10');
        console.log('       deepagents test-access --issue 1 --pr 10');
        process.exit(1);
      }

      const { owner, repo } = config.github;
      const octokit = createGitHubClient(getAuthFromConfig(config.github));

      console.log(`\u{1F50D} Testing GitHub access for ${owner}/${repo}...\n`);

      // ── Issue access ──
      if (taIssueStr && typeof taIssueStr === 'string') {
        const taIssueNumber = parseInt(taIssueStr, 10);
        if (isNaN(taIssueNumber) || taIssueNumber < 1) {
          console.error('--issue must be a positive integer');
          process.exit(1);
        }

        // Read
        try {
          const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: taIssueNumber });
          console.log(`\u{2705} READ  issue — #${taIssueNumber}: "${issue.title}" (${issue.state})`);
        } catch (err: any) {
          console.error(`\u{274C} READ  issue — Failed to fetch issue #${taIssueNumber}: ${err.message}`);
          process.exit(1);
        }

        // Write + delete
        let commentId: number | undefined;
        try {
          const { data: comment } = await octokit.rest.issues.createComment({
            owner, repo,
            issue_number: taIssueNumber,
            body: '\u{1F916} **Deep Agents access test** — this comment will be deleted immediately.',
          });
          commentId = comment.id;
          console.log(`\u{2705} WRITE issue — Posted test comment (id: ${commentId})`);
        } catch (err: any) {
          console.error(`\u{274C} WRITE issue — Failed to post comment on issue #${taIssueNumber}: ${err.message}`);
          process.exit(1);
        }

        try {
          await octokit.rest.issues.deleteComment({ owner, repo, comment_id: commentId! });
          console.log(`\u{2705} DELETE issue — Removed test comment (id: ${commentId})`);
        } catch (err: any) {
          console.error(`\u{26A0}\uFE0F  DELETE issue — Failed to delete comment ${commentId}: ${err.message}`);
        }
      }

      // ── PR access ──
      if (taPrStr && typeof taPrStr === 'string') {
        const taPrNumber = parseInt(taPrStr, 10);
        if (isNaN(taPrNumber) || taPrNumber < 1) {
          console.error('--pr must be a positive integer');
          process.exit(1);
        }

        // Read PR
        try {
          const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: taPrNumber });
          console.log(`\u{2705} READ  PR — #${taPrNumber}: "${pr.title}" (${pr.state})`);
        } catch (err: any) {
          console.error(`\u{274C} READ  PR — Failed to fetch PR #${taPrNumber}: ${err.message}`);
          process.exit(1);
        }

        // Read diff
        try {
          const { data } = await octokit.rest.pulls.get({
            owner, repo, pull_number: taPrNumber,
            mediaType: { format: 'diff' },
          });
          const diff = data as unknown as string;
          const lineCount = diff.split('\n').length;
          console.log(`\u{2705} READ  diff — ${lineCount} lines`);
        } catch (err: any) {
          console.error(`\u{274C} READ  diff — Failed to fetch diff for PR #${taPrNumber}: ${err.message}`);
        }

        // Write review + delete
        let reviewId: number | undefined;
        try {
          const { data: review } = await octokit.rest.pulls.createReview({
            owner, repo, pull_number: taPrNumber,
            event: 'COMMENT',
            body: '\u{1F916} **Deep Agents access test** — this review will be deleted immediately.',
          });
          reviewId = review.id;
          console.log(`\u{2705} WRITE PR — Posted test review (id: ${reviewId})`);
        } catch (err: any) {
          console.error(`\u{274C} WRITE PR — Failed to post review on PR #${taPrNumber}: ${err.message}`);
          process.exit(1);
        }

        try {
          await octokit.rest.pulls.deleteReview({ owner, repo, pull_number: taPrNumber, review_id: reviewId! });
          console.log(`\u{2705} DELETE PR — Removed test review (id: ${reviewId})`);
        } catch (err: any) {
          // Submitted reviews can't be deleted — try dismissing instead
          try {
            await octokit.rest.pulls.dismissReview({
              owner, repo, pull_number: taPrNumber, review_id: reviewId!,
              message: 'Access test cleanup',
            });
            console.log(`\u{2705} DELETE PR — Dismissed test review (id: ${reviewId})`);
          } catch {
            console.error(`\u{26A0}\uFE0F  DELETE PR — Could not remove review ${reviewId}: ${err.message}`);
          }
        }
      }

      console.log('\n\u{1F389} All access checks passed!');
      break;
    }

    case 'poll': {
      const dryRun = flags['dry-run'] === true;
      const noSave = flags['no-save'] === true;
      const maxIssuesStr = flags['max-issues'];
      const maxIssues = typeof maxIssuesStr === 'string' ? parseInt(maxIssuesStr, 10) : undefined;
      const maxToolCallsStr = flags['max-tool-calls'];
      const maxToolCalls = typeof maxToolCallsStr === 'string' ? parseInt(maxToolCallsStr, 10) : undefined;

      if (maxIssues !== undefined && (isNaN(maxIssues) || maxIssues < 1)) {
        console.error('--max-issues must be a positive integer');
        process.exit(1);
      }

      if (maxToolCalls !== undefined && (isNaN(maxToolCalls) || maxToolCalls < 1)) {
        console.error('--max-tool-calls must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents GitHub Issue Poller\n');
      const { createRepositories: createPollRepos } = await import('./db/repositories.js');
      const pollRepos = await createPollRepos(config);
      await runPollCycle(config, {
        dryRun,
        noSave,
        maxIssues,
        maxToolCalls,
        pollRepository: pollRepos.pollRepository,
        repoId: pollRepos.repoId,
        issueContextRepository: pollRepos.issueContextRepository,
        processRepository: pollRepos.processRepository,
      });
      break;
    }

    case 'analyze': {
      const issueStr = flags['issue'];
      if (!issueStr || typeof issueStr !== 'string') {
        console.error('--issue N is required for the analyze command');
        console.log('\nUsage: deepagents analyze --issue 42');
        process.exit(1);
      }

      const issueNumber = parseInt(issueStr, 10);
      if (isNaN(issueNumber) || issueNumber < 1) {
        console.error('--issue must be a positive integer');
        process.exit(1);
      }

      const dryRun = flags['dry-run'] === true;

      console.log('\u{1F916} Deep Agents Architect\n');
      const { createRepositories: createAnalyzeRepos } = await import('./db/repositories.js');
      const analyzeRepos = await createAnalyzeRepos(config);
      const usageService = new UsageService(analyzeRepos.usageRepository);
      const processId = `analyze-${issueNumber}-${Date.now()}`;
      const result = await runArchitect(config, issueNumber, {
        dryRun,
        usageService,
        processId,
        contextRepo: analyzeRepos.issueContextRepository,
        repoId: analyzeRepos.repoId,
      });

      console.log('\n' + '\u{2500}'.repeat(60));
      console.log('\u{1F4CB} Architect summary:');
      console.log(`   Issue:   #${result.issueNumber}`);
      if (result.prNumbers.length > 1) {
        console.log(`   PRs:     ${result.prNumbers.map(n => `#${n}`).join(', ')}`);
      } else {
        console.log(`   PR:      ${result.prNumber ? `#${result.prNumber}` : 'none'}`);
      }
      break;
    }

    case 'continue': {
      const contIssueStr = flags['issue'];
      const contPrStr = flags['pr'];
      const contBranch = flags['branch'];

      if (!contIssueStr || typeof contIssueStr !== 'string') {
        console.error('--issue N is required for the continue command');
        console.log('\nUsage: deepagents continue --issue 20 --pr 21 --branch issue-20-fix');
        process.exit(1);
      }
      if (!contPrStr || typeof contPrStr !== 'string') {
        console.error('--pr N is required for the continue command');
        console.log('\nUsage: deepagents continue --issue 20 --pr 21 --branch issue-20-fix');
        process.exit(1);
      }
      if (!contBranch || typeof contBranch !== 'string') {
        console.error('--branch NAME is required for the continue command');
        console.log('\nUsage: deepagents continue --issue 20 --pr 21 --branch issue-20-fix');
        process.exit(1);
      }

      const contIssueNumber = parseInt(contIssueStr, 10);
      const contPrNumber = parseInt(contPrStr, 10);
      if (isNaN(contIssueNumber) || contIssueNumber < 1) {
        console.error('--issue must be a positive integer');
        process.exit(1);
      }
      if (isNaN(contPrNumber) || contPrNumber < 1) {
        console.error('--pr must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents Continue\n');
      const contUsageService = new UsageService();
      const contProcessId = `continue-${contIssueNumber}-${Date.now()}`;
      const contResult = await runArchitect(config, contIssueNumber, {
        continueContext: { prNumber: contPrNumber, branchName: contBranch },
        usageService: contUsageService,
        processId: contProcessId,
      });

      console.log('\n' + '\u{2500}'.repeat(60));
      console.log('\u{1F4CB} Continue summary:');
      console.log(`   Issue:   #${contResult.issueNumber}`);
      if (contResult.prNumbers.length > 1) {
        console.log(`   PRs:     ${contResult.prNumbers.map(n => `#${n}`).join(', ')}`);
      } else {
        console.log(`   PR:      ${contResult.prNumber ? `#${contResult.prNumber}` : 'none'}`);
      }
      break;
    }

    case 'review': {
      const prStr = flags['pr'];
      if (!prStr || typeof prStr !== 'string') {
        console.error('--pr N is required for the review command');
        console.log('\nUsage: deepagents review --pr 10');
        process.exit(1);
      }

      const prNumber = parseInt(prStr, 10);
      if (isNaN(prNumber) || prNumber < 1) {
        console.error('--pr must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents PR Reviewer\n');
      await runReviewSingle(config, prNumber);
      break;
    }

    case 'retract': {
      const retractIssueStr = flags['issue'];
      if (!retractIssueStr || typeof retractIssueStr !== 'string') {
        console.error('--issue N is required for the retract command');
        console.log('\nUsage: deepagents retract --issue 42');
        process.exit(1);
      }

      const retractIssueNumber = parseInt(retractIssueStr, 10);
      if (isNaN(retractIssueNumber) || retractIssueNumber < 1) {
        console.error('--issue must be a positive integer');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents Retract\n');
      console.log(`Retracting actions for issue #${retractIssueNumber}...\n`);

      const retractResult = await retractIssue(config, retractIssueNumber);

      console.log('\nRetraction summary:');
      console.log(`  PR closed:       ${retractResult.prClosed ? 'yes' : 'no'}`);
      console.log(`  Branch deleted:   ${retractResult.branchDeleted ? 'yes' : 'no'}`);
      console.log(`  Comment deleted:  ${retractResult.commentDeleted ? 'yes' : 'no'}`);
      if (retractResult.errors.length > 0) {
        console.log(`  Errors:          ${retractResult.errors.length}`);
        for (const err of retractResult.errors) {
          console.log(`    - ${err}`);
        }
      }
      break;
    }

    case 'serve': {
      const servePortStr = flags['port'];
      if (servePortStr !== undefined) {
        const servePort = typeof servePortStr === 'string' ? parseInt(servePortStr, 10) : NaN;
        if (isNaN(servePort) || servePort < 1 || servePort > 65535) {
          console.error('--port must be a number between 1 and 65535');
          process.exit(1);
        }
        config.port = servePort;
      }

      console.log('\u{1F916} Deep Agents Unified Server\n');
      const { createRepositories } = await import('./db/repositories.js');
      const repos = await createRepositories(config);
      activeServer = startUnifiedServer(config, {
        usageRepository: repos.usageRepository,
        processRepository: repos.processRepository,
        issueContextRepository: repos.issueContextRepository,
        repoId: repos.repoId,
      });
      // Server runs until process is killed (SIGTERM/SIGINT)
      break;
    }

    case 'webhook': {
      if (!config.webhook) {
        console.error('Webhook config is required. Set WEBHOOK_PORT and WEBHOOK_SECRET in .env');
        process.exit(1);
      }
      console.log('\u{1F916} Deep Agents Webhook Listener\n');
      activeServer = startWebhookServer(config.webhook, config);
      // Server runs until process is killed (SIGTERM/SIGINT)
      break;
    }

    case 'dialog': {
      const portStr = flags['port'];
      const port = typeof portStr === 'string' ? parseInt(portStr, 10) : 3001;

      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('--port must be a number between 1 and 65535');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents Interactive Dialog\n');
      activeServer = startDialogServer(config, port);
      // Server runs until process is killed (SIGTERM/SIGINT)
      break;
    }

    case 'dashboard': {
      const dashPortStr = flags['port'];
      const dashPort = typeof dashPortStr === 'string' ? parseInt(dashPortStr, 10) : 3000;

      if (isNaN(dashPort) || dashPort < 1 || dashPort > 65535) {
        console.error('--port must be a number between 1 and 65535');
        process.exit(1);
      }

      console.log('\u{1F916} Deep Agents Dashboard\n');
      const { createRepositories: createDashRepos } = await import('./db/repositories.js');
      const dashRepos = await createDashRepos(config);
      activeServer = startDashboardServer(config, dashPort, {
        usageRepository: dashRepos.usageRepository,
        processRepository: dashRepos.processRepository,
        issueContextRepository: dashRepos.issueContextRepository,
        repoId: dashRepos.repoId,
      });
      // Server runs until process is killed (SIGTERM/SIGINT)
      break;
    }

    case 'no-save': {
      // Shorthand for `poll --no-save`
      console.log('\u{1F916} Deep Agents GitHub Issue Poller (No-Save Mode)\n');
      await runPollCycle(config, { noSave: true });
      break;
    }

    case 'status': {
      await showStatus(config);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('\u{274C} Error:', error);
  process.exitCode = 1;
});
