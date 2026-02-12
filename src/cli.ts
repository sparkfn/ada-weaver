#!/usr/bin/env node
import 'dotenv/config';

import type { Server } from 'http';
import { execSync } from 'child_process';
import { loadConfig } from './config.js';
import { runPollCycle, showStatus, retractIssue, requestShutdown } from './core.js';
import { runArchitect } from './architect.js';
import { startWebhookServer, startDialogServer } from './listener.js';
import { runReviewSingle } from './reviewer-agent.js';

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
  poll              Run a poll cycle: fetch, analyze, comment, branch, PR
  analyze           Analyze a single issue (Architect: understand, implement, review)
  review            Review a pull request (fetch diff, analyze, post review comment)
  retract           Undo agent actions on an issue (close PR, delete branch, delete comment)
  webhook           Start the HTTP webhook listener for GitHub events
  dialog            Start the interactive chat server (agent + human conversation)
  kill              Force kill all running deepagents processes
  status            Show current polling state
  help              Show this help message

Options for 'poll':
  --dry-run           Skip all GitHub writes (comments, branches, PRs) and poll state save
  --no-save           Run without saving poll state (GitHub writes still execute)
  --max-issues N      Override maxIssuesPerRun from config

Options for 'analyze':
  --issue N         Issue number to analyze (required)
  --dry-run         Skip GitHub writes (comments, branches, PRs)

Options for 'review':
  --pr N            Pull request number to review (required)

Options for 'retract':
  --issue N         Issue number to retract (required)

Options for 'dialog':
  --port N          Port for the dialog server (default: 3001)

Examples:
  deepagents poll
  deepagents poll --dry-run
  deepagents poll --no-save
  deepagents poll --max-issues 3
  deepagents analyze --issue 42
  deepagents analyze --issue 42 --dry-run
  deepagents review --pr 10
  deepagents retract --issue 42
  deepagents webhook
  deepagents dialog
  deepagents kill
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

  // All commands except 'help' and 'kill' need config
  const config = loadConfig();

  switch (command) {
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
      await runPollCycle(config, { dryRun, noSave, maxIssues, maxToolCalls });
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
      const result = await runArchitect(config, issueNumber, { dryRun });

      console.log('\n' + '\u{2500}'.repeat(60));
      console.log('\u{1F4CB} Architect summary:');
      console.log(`   Issue:   #${result.issueNumber}`);
      console.log(`   PR:      ${result.prNumber ? `#${result.prNumber}` : 'none'}`);
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

    case 'no-save': {
      // Shorthand for `poll --no-save`
      console.log('\u{1F916} Deep Agents GitHub Issue Poller (No-Save Mode)\n');
      await runPollCycle(config, { noSave: true });
      break;
    }

    case 'status': {
      showStatus(config);
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
