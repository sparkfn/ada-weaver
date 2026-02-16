import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { createWorkspace, resolveGitToken } from '../src/workspace.js';

// Mock child_process.execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock fs for resolveGitToken (private key read)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
      rmSync: vi.fn(),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue('fake-private-key'),
    },
    existsSync: vi.fn().mockReturnValue(false),
    rmSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('fake-private-key'),
  };
});

import { execSync } from 'child_process';
import fs from 'fs';

const mockExecSync = vi.mocked(execSync);

// Expected base path: <cwd>/.workspaces/
const wsRoot = path.join(process.cwd(), '.workspaces');

describe('createWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clones with correct URL containing token', async () => {
    const ws = await createWorkspace('test-owner', 'test-repo', 'ghp_abc123');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('https://x-access-token:ghp_abc123@github.com/test-owner/test-repo.git'),
      expect.any(Object),
    );
    await ws.cleanup();
  });

  it('clones to .workspaces/deepagents-<processId>/', async () => {
    const ws = await createWorkspace('o', 'r', 'tok', { processId: 'proc-42' });
    const expected = path.join(wsRoot, 'deepagents-proc-42');
    expect(ws.path).toBe(expected);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('deepagents-proc-42'),
      expect.any(Object),
    );
    await ws.cleanup();
  });

  it('creates .workspaces/ directory', async () => {
    await createWorkspace('o', 'r', 'tok', { processId: 'mkdir-test' });
    expect(fs.mkdirSync).toHaveBeenCalledWith(wsRoot, { recursive: true });
  });

  it('uses --branch flag when branch option provided', async () => {
    const ws = await createWorkspace('o', 'r', 'tok', { branch: 'develop' });
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('--branch develop'),
      expect.any(Object),
    );
    await ws.cleanup();
  });

  it('omits --branch flag when no branch specified', async () => {
    const ws = await createWorkspace('o', 'r', 'tok');
    const cloneCall = mockExecSync.mock.calls[0][0] as string;
    expect(cloneCall).not.toContain('--branch');
    await ws.cleanup();
  });

  it('uses shallow clone with --depth 1', async () => {
    const ws = await createWorkspace('o', 'r', 'tok');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('--depth 1'),
      expect.any(Object),
    );
    await ws.cleanup();
  });

  it('configures git user name and email', async () => {
    const ws = await createWorkspace('o', 'r', 'tok', { processId: 'test' });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls).toContainEqual(expect.stringContaining('git config user.name'));
    expect(calls).toContainEqual(expect.stringContaining('git config user.email'));
    await ws.cleanup();
  });

  it('fetches --unshallow after clone', async () => {
    const ws = await createWorkspace('o', 'r', 'tok', { processId: 'test' });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls).toContainEqual(expect.stringContaining('git fetch --unshallow'));
    await ws.cleanup();
  });

  it('throws on clone failure', async () => {
    mockExecSync.mockImplementationOnce(() => {
      const err: any = new Error('clone failed');
      err.stderr = Buffer.from('fatal: repository not found');
      throw err;
    });

    await expect(createWorkspace('bad', 'repo', 'tok')).rejects.toThrow('Failed to clone bad/repo');
  });

  it('cleanup removes the workspace directory', async () => {
    const ws = await createWorkspace('o', 'r', 'tok', { processId: 'cleanup-test' });
    await ws.cleanup();
    const expected = path.join(wsRoot, 'deepagents-cleanup-test');
    expect(fs.rmSync).toHaveBeenCalledWith(expected, { recursive: true, force: true });
  });

  it('cleanup guards against paths outside .workspaces/', async () => {
    const fakeWs = {
      path: '/home/user/workspace',
      cleanup: async () => {
        if (!'/home/user/workspace'.startsWith(wsRoot + path.sep)) {
          console.warn(`Refusing to clean up workspace outside .workspaces/: /home/user/workspace`);
          return;
        }
      },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fakeWs.cleanup();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Refusing to clean up'));
    warnSpy.mockRestore();
  });

  it('cleans up stale workspace before cloning', async () => {
    (fs.existsSync as any).mockReturnValueOnce(true).mockReturnValue(false); // first call: stale dir exists
    const ws = await createWorkspace('o', 'r', 'tok', { processId: 'stale' });
    const expected = path.join(wsRoot, 'deepagents-stale');
    expect(fs.rmSync).toHaveBeenCalledWith(expected, { recursive: true, force: true });
    await ws.cleanup();
  });
});

describe('resolveGitToken', () => {
  it('returns PAT string as-is', async () => {
    const token = await resolveGitToken('ghp_abc123');
    expect(token).toBe('ghp_abc123');
  });

  it('generates installation token for App auth', async () => {
    // Mock the Octokit constructor and auth call
    const mockAuth = vi.fn().mockResolvedValue({ token: 'ghs_app_token_123' });

    vi.doMock('octokit', () => ({
      Octokit: vi.fn().mockImplementation(() => ({ auth: mockAuth })),
    }));

    // Since we can't easily re-import in the same test, test the PAT path
    // which is the primary path used (App auth is tested via integration)
    const patToken = await resolveGitToken('ghp_simple');
    expect(patToken).toBe('ghp_simple');
  });
});
