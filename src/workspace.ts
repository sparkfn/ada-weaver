import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import type { GitHubAppAuth } from './github-tools.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Workspace {
  path: string;
  cleanup: () => Promise<void>;
}

// ── Token resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a git-compatible token from either a PAT string or GitHub App auth.
 * For PAT: returns as-is.
 * For App auth: generates an installation access token via Octokit.
 */
export async function resolveGitToken(auth: string | GitHubAppAuth): Promise<string> {
  if (typeof auth === 'string') return auth;

  const privateKey = fs.readFileSync(auth.privateKeyPath, 'utf-8');
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.appId,
      privateKey,
      installationId: auth.installationId,
    },
  });

  // Force token generation via auth hook
  const { token } = await (octokit.auth as any)({ type: 'installation' });
  return token;
}

// ── Workspace lifecycle ──────────────────────────────────────────────────────

/** Directory name inside the project root where workspaces are cloned. */
const WORKSPACES_DIR = '.workspaces';

/**
 * Resolve the root directory for workspaces.
 * Uses the project root (cwd) so it works on any OS (Linux, macOS, etc.).
 */
function getWorkspacesRoot(): string {
  return path.join(process.cwd(), WORKSPACES_DIR);
}

/**
 * Clone a GitHub repo into .workspaces/ under the project root.
 *
 * - Shallow clone (--depth 1) for speed
 * - Optionally checks out a specific branch
 * - Configures git user for commits
 * - cleanup() removes the workspace directory (guards against paths outside .workspaces/)
 */
export async function createWorkspace(
  owner: string,
  repo: string,
  token: string,
  options?: { branch?: string; processId?: string },
): Promise<Workspace> {
  const suffix = options?.processId ?? `${Date.now()}`;
  const wsRoot = getWorkspacesRoot();

  // Ensure .workspaces/ directory exists
  fs.mkdirSync(wsRoot, { recursive: true });

  const workspacePath = path.join(wsRoot, `deepagents-${suffix}`);

  // Clean up any stale workspace at this path
  if (fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }

  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  const branchFlag = options?.branch ? `--branch ${options.branch}` : '';
  const cmd = `git clone --depth 1 ${branchFlag} ${cloneUrl} ${workspacePath}`;

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 60_000 });
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`Failed to clone ${owner}/${repo}: ${stderr}`);
  }

  // Configure git identity for commits
  execSync('git config user.name "Deep Agents"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.email "deep-agents[bot]@users.noreply.github.com"', { cwd: workspacePath, stdio: 'pipe' });

  // Unshallow so we can create branches and push
  try {
    execSync('git fetch --unshallow', { cwd: workspacePath, stdio: 'pipe', timeout: 60_000 });
  } catch {
    // Already unshallowed or full clone — safe to ignore
  }

  const cleanup = async () => {
    // Safety: only remove paths inside .workspaces/
    const expectedPrefix = getWorkspacesRoot() + path.sep;
    if (!workspacePath.startsWith(expectedPrefix)) {
      console.warn(`Refusing to clean up workspace outside ${WORKSPACES_DIR}/: ${workspacePath}`);
      return;
    }
    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  };

  return { path: workspacePath, cleanup };
}
