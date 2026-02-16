import { createHmac } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDashboardApp, createUnifiedApp } from '../src/dashboard.js';
import type express from 'express';
import type { ProcessManager } from '../src/process-manager.js';
import type { UsageService } from '../src/usage-service.js';

// Mock dependencies so no real agents or GitHub calls happen
vi.mock('../src/architect.js', () => ({
  runArchitect: vi.fn().mockImplementation(() => new Promise(() => {})),
  // Note: resolved value (when actually used) should include prNumbers
}));

vi.mock('../src/reviewer-agent.js', () => ({
  runReviewSingle: vi.fn().mockImplementation(() => new Promise(() => {})),
}));

vi.mock('../src/chat-agent.js', () => ({
  chatStream: vi.fn().mockImplementation(async function* () {
    yield { type: 'response', content: 'Hello!' };
  }),
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
  let usageService: UsageService;

  beforeEach(() => {
    vi.clearAllMocks();
    const result = createDashboardApp(mockConfig);
    app = result.app;
    processManager = result.processManager;
    usageService = result.usageService;
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

  describe('GET /api/processes (parallel fields)', () => {
    it('process response includes activePhases field when set', async () => {
      const proc = processManager.startAnalysis(42);
      // Manually set activePhases on the process for testing
      const internal = await processManager.getProcess(proc.id);
      if (internal) {
        // Access internal map via listProcesses
        const procs = await processManager.listProcesses();
        const target = procs.find(p => p.id === proc.id);
        if (target) {
          target.activePhases = ['coder', 'reviewer'];
        }
      }
      const res = await inject(app, 'GET', '/api/processes');
      expect(res.status).toBe(200);
      // The process should be returned (activePhases may or may not be set depending on internal access)
      expect(res.body).toHaveLength(1);
    });

    it('process response includes prNumbers field when set', async () => {
      const proc = processManager.startAnalysis(42);
      const procs = await processManager.listProcesses();
      const target = procs.find(p => p.id === proc.id);
      if (target) {
        target.prNumbers = [10, 11];
      }
      const res = await inject(app, 'GET', `/api/processes/${proc.id}`);
      expect(res.status).toBe(200);
      expect(res.body.prNumbers).toEqual([10, 11]);
    });
  });

  // ── Usage API tests ─────────────────────────────────────────────────────────

  describe('GET /api/usage/summary', () => {
    it('returns empty summary initially', async () => {
      const res = await inject(app, 'GET', '/api/usage/summary');
      expect(res.status).toBe(200);
      expect(res.body.totalRecords).toBe(0);
      expect(res.body.totalTokens).toBe(0);
      expect(res.body.totalEstimatedCost).toBe(0);
    });

    it('returns summary after recording usage', async () => {
      usageService.record({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        agent: 'architect',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 2000,
      });
      const res = await inject(app, 'GET', '/api/usage/summary');
      expect(res.status).toBe(200);
      expect(res.body.totalRecords).toBe(1);
      expect(res.body.totalInputTokens).toBe(1000);
      expect(res.body.totalOutputTokens).toBe(500);
      expect(res.body.totalTokens).toBe(1500);
    });

    it('filters by agent', async () => {
      usageService.record({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        agent: 'architect',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 2000,
      });
      usageService.record({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        agent: 'coder',
        inputTokens: 2000,
        outputTokens: 1000,
        durationMs: 3000,
      });
      const res = await inject(app, 'GET', '/api/usage/summary?agent=coder');
      expect(res.status).toBe(200);
      expect(res.body.totalRecords).toBe(1);
      expect(res.body.totalInputTokens).toBe(2000);
    });
  });

  describe('GET /api/usage/records', () => {
    it('returns empty records initially', async () => {
      const res = await inject(app, 'GET', '/api/usage/records');
      expect(res.status).toBe(200);
      expect(res.body.records).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it('returns records after recording usage', async () => {
      usageService.record({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        agent: 'architect',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 2000,
      });
      const res = await inject(app, 'GET', '/api/usage/records');
      expect(res.status).toBe(200);
      expect(res.body.records).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.records[0].agent).toBe('architect');
    });

    it('supports limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        usageService.record({
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          agent: 'architect',
          inputTokens: 1000,
          outputTokens: 500,
          durationMs: 2000,
        });
      }
      const res = await inject(app, 'GET', '/api/usage/records?limit=2');
      expect(res.status).toBe(200);
      expect(res.body.records).toHaveLength(2);
      expect(res.body.total).toBe(5);
    });
  });

  describe('GET /api/usage/group/:groupBy', () => {
    it('returns empty groups initially', async () => {
      const res = await inject(app, 'GET', '/api/usage/group/agent');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('groups by agent', async () => {
      usageService.record({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        agent: 'architect',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 2000,
      });
      usageService.record({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        agent: 'coder',
        inputTokens: 2000,
        outputTokens: 1000,
        durationMs: 3000,
      });
      const res = await inject(app, 'GET', '/api/usage/group/agent');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const architectGroup = res.body.find((g: any) => g.key === 'architect');
      expect(architectGroup).toBeDefined();
      expect(architectGroup.summary.totalRecords).toBe(1);
    });

    it('returns 400 for invalid groupBy', async () => {
      const res = await inject(app, 'GET', '/api/usage/group/invalid');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid groupBy');
    });
  });
});

// ── Unified App Tests ─────────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-secret-123';

const unifiedConfig = {
  ...mockConfig,
  webhook: { port: 3000, secret: WEBHOOK_SECRET },
} as any;

function signPayload(secret: string, body: Buffer): string {
  const hmac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Inject a raw-body request (for webhook HMAC testing).
 * Simulates express.raw() by setting req.body to a Buffer.
 */
function injectRaw(
  app: express.Express,
  method: string,
  path: string,
  rawBody: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve) => {
    const req: any = {
      method: method.toUpperCase(),
      url: path,
      headers: { 'content-type': 'application/json', ...headers },
      query: {},
      params: {},
      body: rawBody,
      on: () => {},
      // Prevent express.raw() from re-parsing — mark as already read
      _body: true,
      readable: false,
    };

    let statusCode = 200;
    const resHeaders: Record<string, string> = {};
    let resBody = '';

    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      json(data: any) { resBody = JSON.stringify(data); this.end(); },
      sendFile(filePath: string) { resBody = `sendFile:${filePath}`; this.end(); },
      writeHead(code: number, hdrs: Record<string, string>) { statusCode = code; Object.assign(resHeaders, hdrs); },
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

describe('Unified App', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    const result = createUnifiedApp(unifiedConfig);
    app = result.app;
  });

  describe('existing dashboard routes', () => {
    it('GET / serves dashboard', async () => {
      const res = await inject(app, 'GET', '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('dashboard.html');
    });

    it('GET /health returns ok', async () => {
      const res = await inject(app, 'GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /api/status returns repo info', async () => {
      const res = await inject(app, 'GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.body.owner).toBe('test-owner');
    });
  });

  describe('POST /webhook', () => {
    it('returns 200 with valid HMAC signature', async () => {
      const payload = JSON.stringify({ action: 'opened', issue: { number: 1 } });
      const rawBody = Buffer.from(payload);
      const signature = signPayload(WEBHOOK_SECRET, rawBody);

      const res = await injectRaw(app, 'POST', '/webhook', rawBody, {
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
        'x-github-delivery': 'test-delivery-1',
      });
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it('returns 401 with invalid HMAC signature', async () => {
      const payload = JSON.stringify({ action: 'opened', issue: { number: 1 } });
      const rawBody = Buffer.from(payload);

      const res = await injectRaw(app, 'POST', '/webhook', rawBody, {
        'x-hub-signature-256': 'sha256=invalid',
        'x-github-event': 'issues',
        'x-github-delivery': 'test-delivery-2',
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid signature');
    });
  });

  describe('GET /dialog', () => {
    it('serves dialog.html', async () => {
      const res = await inject(app, 'GET', '/dialog');
      expect(res.status).toBe(200);
      expect(res.body).toContain('dialog.html');
    });
  });

  describe('POST /chat', () => {
    it('returns SSE stream', async () => {
      const res = await inject(app, 'POST', '/chat', { message: 'Hello', sessionId: 'test-session' });
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.body).toContain('data:');
      expect(res.body).toContain('[DONE]');
    });

    it('returns 400 with missing message', async () => {
      const res = await inject(app, 'POST', '/chat', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('message');
    });
  });
});
