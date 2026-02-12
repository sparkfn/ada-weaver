import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDashboardApp } from '../src/dashboard.js';
import type express from 'express';
import type { ProcessManager } from '../src/process-manager.js';

// Mock dependencies so no real agents or GitHub calls happen
vi.mock('../src/architect.js', () => ({
  runArchitect: vi.fn().mockImplementation(() => new Promise(() => {})),
}));

vi.mock('../src/reviewer-agent.js', () => ({
  runReviewSingle: vi.fn().mockImplementation(() => new Promise(() => {})),
}));

vi.mock('../src/core.js', () => ({
  loadPollState: vi.fn().mockReturnValue({
    lastPollTimestamp: '2024-01-01T00:00:00.000Z',
    lastPollIssueNumbers: [1, 2],
    issues: {
      '1': { comment: null, branch: { name: 'issue-1-fix', sha: 'abc' }, commits: [], pr: { number: 5, html_url: '' } },
      '2': { comment: null, branch: null, commits: [], pr: null },
    },
  }),
}));

const mockConfig = {
  github: { owner: 'test-owner', repo: 'test-repo', token: 'fake' },
  llm: { provider: 'anthropic', apiKey: 'fake', model: null, baseUrl: null },
} as any;

// Simple inject helper — creates a minimal request/response for Express
function inject(app: express.Express, method: string, path: string, body?: any): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve) => {
    // Use the app's handle method directly
    const req: any = {
      method: method.toUpperCase(),
      url: path,
      headers: { 'content-type': 'application/json' },
      query: Object.fromEntries(new URL(path, 'http://localhost').searchParams),
      params: {},
      body: body || {},
      on: () => {},
    };

    // Extract path without query for Express routing
    req.url = path;

    let statusCode = 200;
    const resHeaders: Record<string, string> = {};
    let resBody = '';

    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      json(data: any) { resBody = JSON.stringify(data); this.end(); },
      sendFile(filePath: string) { resBody = `sendFile:${filePath}`; this.end(); },
      writeHead(code: number, headers: Record<string, string>) { statusCode = code; Object.assign(resHeaders, headers); },
      write(chunk: string) { resBody += chunk; },
      end() {
        resolve({
          status: statusCode,
          body: resBody.startsWith('{') || resBody.startsWith('[') ? JSON.parse(resBody) : resBody,
          headers: resHeaders,
        });
      },
      setHeader(k: string, v: string) { resHeaders[k] = v; },
      getHeader(k: string) { return resHeaders[k]; },
    };

    app.handle(req, res, () => {
      statusCode = 404;
      resolve({ status: 404, body: { error: 'Not Found' }, headers: resHeaders });
    });
  });
}

describe('Dashboard API', () => {
  let app: express.Express;
  let processManager: ProcessManager;

  beforeEach(() => {
    vi.clearAllMocks();
    const result = createDashboardApp(mockConfig);
    app = result.app;
    processManager = result.processManager;
  });

  describe('GET /health', () => {
    it('returns ok status', async () => {
      const res = await inject(app, 'GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeTruthy();
    });
  });

  describe('GET /api/status', () => {
    it('returns repo info and counts', async () => {
      const res = await inject(app, 'GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.body.owner).toBe('test-owner');
      expect(res.body.repo).toBe('test-repo');
      expect(res.body.runningCount).toBe(0);
      expect(res.body.totalCount).toBe(0);
    });
  });

  describe('GET /api/processes', () => {
    it('returns empty list initially', async () => {
      const res = await inject(app, 'GET', '/api/processes');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns processes after starting one', async () => {
      processManager.startAnalysis(42);
      const res = await inject(app, 'GET', '/api/processes');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].issueNumber).toBe(42);
    });
  });

  describe('GET /api/processes/:id', () => {
    it('returns 404 for unknown process', async () => {
      const res = await inject(app, 'GET', '/api/processes/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns process details', async () => {
      const proc = processManager.startAnalysis(42);
      const res = await inject(app, 'GET', `/api/processes/${proc.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(proc.id);
      expect(res.body.issueNumber).toBe(42);
    });
  });

  describe('POST /api/processes/analyze', () => {
    it('returns 201 with valid issue number', async () => {
      const res = await inject(app, 'POST', '/api/processes/analyze', { issueNumber: 42 });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('analyze');
      expect(res.body.issueNumber).toBe(42);
    });

    it('returns 400 with missing issue number', async () => {
      const res = await inject(app, 'POST', '/api/processes/analyze', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('issueNumber');
    });

    it('returns 400 with invalid issue number', async () => {
      const res = await inject(app, 'POST', '/api/processes/analyze', { issueNumber: -1 });
      expect(res.status).toBe(400);
    });

    it('supports dryRun option', async () => {
      const res = await inject(app, 'POST', '/api/processes/analyze', { issueNumber: 42, dryRun: true });
      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/processes/review', () => {
    it('returns 201 with valid PR number', async () => {
      const res = await inject(app, 'POST', '/api/processes/review', { prNumber: 10 });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('review');
      expect(res.body.prNumber).toBe(10);
    });

    it('returns 400 with missing PR number', async () => {
      const res = await inject(app, 'POST', '/api/processes/review', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('prNumber');
    });
  });

  describe('POST /api/processes/continue', () => {
    it('returns 201 with valid continue params', async () => {
      const res = await inject(app, 'POST', '/api/processes/continue', {
        issueNumber: 20,
        prNumber: 21,
        branchName: 'issue-20-fix',
      });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('analyze');
      expect(res.body.issueNumber).toBe(20);
      expect(res.body.prNumber).toBe(21);
    });

    it('returns 400 with missing issueNumber', async () => {
      const res = await inject(app, 'POST', '/api/processes/continue', {
        prNumber: 21,
        branchName: 'issue-20-fix',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('issueNumber');
    });

    it('returns 400 with missing prNumber', async () => {
      const res = await inject(app, 'POST', '/api/processes/continue', {
        issueNumber: 20,
        branchName: 'issue-20-fix',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('prNumber');
    });

    it('returns 400 with missing branchName', async () => {
      const res = await inject(app, 'POST', '/api/processes/continue', {
        issueNumber: 20,
        prNumber: 21,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('branchName');
    });
  });

  describe('DELETE /api/processes/:id', () => {
    it('cancels a running process', async () => {
      const proc = processManager.startAnalysis(42);
      const res = await inject(app, 'DELETE', `/api/processes/${proc.id}`);
      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(true);
    });

    it('returns 404 for unknown process', async () => {
      const res = await inject(app, 'DELETE', '/api/processes/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/history', () => {
    it('returns poll state', async () => {
      const res = await inject(app, 'GET', '/api/history');
      expect(res.status).toBe(200);
      expect(res.body.lastPollIssueNumbers).toEqual([1, 2]);
      expect(res.body.issues).toBeDefined();
      expect(res.body.issues['1'].pr.number).toBe(5);
    });
  });
});
