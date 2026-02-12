import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import type { Request, Response } from 'express';
import type { Config } from './config.js';
import { ProcessManager } from './process-manager.js';

// ── Static directory ─────────────────────────────────────────────────────────

function getStaticDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', 'static');
}

// ── Express app factory ──────────────────────────────────────────────────────

export function createDashboardApp(config: Config): { app: express.Express; processManager: ProcessManager } {
  const app = express();
  const processManager = new ProcessManager(config);

  app.use(express.json());

  // Serve dashboard.html at root
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(getStaticDir(), 'dashboard.html'));
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Status summary
  app.get('/api/status', (_req: Request, res: Response) => {
    const all = processManager.listProcesses();
    const running = all.filter(p => p.status === 'running');
    res.json({
      owner: config.github.owner,
      repo: config.github.repo,
      runningCount: running.length,
      totalCount: all.length,
    });
  });

  // List processes
  app.get('/api/processes', (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const processes = processManager.listProcesses(status);
    res.json(processes.map(p => ({ ...p, logs: [] })));
  });

  // Get single process (includes logs)
  app.get('/api/processes/:id', (req: Request, res: Response) => {
    const proc = processManager.getProcess(req.params.id);
    if (!proc) {
      res.status(404).json({ error: 'Process not found' });
      return;
    }
    res.json(proc);
  });

  // Start analysis
  app.post('/api/processes/analyze', (req: Request, res: Response) => {
    const { issueNumber, dryRun } = req.body as { issueNumber?: number; dryRun?: boolean };
    if (!issueNumber || typeof issueNumber !== 'number' || issueNumber < 1) {
      res.status(400).json({ error: 'issueNumber must be a positive integer' });
      return;
    }
    const proc = processManager.startAnalysis(issueNumber, { dryRun });
    res.status(201).json(proc);
  });

  // Continue analysis (review→fix loop on existing PR)
  app.post('/api/processes/continue', (req: Request, res: Response) => {
    const { issueNumber, prNumber, branchName } = req.body as {
      issueNumber?: number;
      prNumber?: number;
      branchName?: string;
    };
    if (!issueNumber || typeof issueNumber !== 'number' || issueNumber < 1) {
      res.status(400).json({ error: 'issueNumber must be a positive integer' });
      return;
    }
    if (!prNumber || typeof prNumber !== 'number' || prNumber < 1) {
      res.status(400).json({ error: 'prNumber must be a positive integer' });
      return;
    }
    if (!branchName || typeof branchName !== 'string') {
      res.status(400).json({ error: 'branchName is required' });
      return;
    }
    const proc = processManager.continueAnalysis(issueNumber, prNumber, branchName);
    res.status(201).json(proc);
  });

  // Start review
  app.post('/api/processes/review', (req: Request, res: Response) => {
    const { prNumber } = req.body as { prNumber?: number };
    if (!prNumber || typeof prNumber !== 'number' || prNumber < 1) {
      res.status(400).json({ error: 'prNumber must be a positive integer' });
      return;
    }
    const proc = processManager.startReview(prNumber);
    res.status(201).json(proc);
  });

  // Cancel process
  app.delete('/api/processes/:id', (req: Request, res: Response) => {
    const cancelled = processManager.cancelProcess(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: 'Process not found or not running' });
      return;
    }
    res.json({ cancelled: true });
  });

  // History from last_poll.json
  app.get('/api/history', (_req: Request, res: Response) => {
    const state = processManager.getHistory();
    if (!state) {
      res.json({ issues: {}, lastPollTimestamp: null, lastPollIssueNumbers: [] });
      return;
    }
    res.json(state);
  });

  // SSE event stream
  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write('data: {"type":"connected"}\n\n');

    const onEvent = (event: any) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    processManager.on('process_event', onEvent);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`data: {"type":"heartbeat","timestamp":"${new Date().toISOString()}"}\n\n`);
    }, 30000);

    req.on('close', () => {
      processManager.off('process_event', onEvent);
      clearInterval(heartbeat);
    });
  });

  return { app, processManager };
}

// ── Server start ─────────────────────────────────────────────────────────────

export function startDashboardServer(config: Config, port: number) {
  const { app } = createDashboardApp(config);

  const server = app.listen(port, () => {
    console.log(`[dashboard] Listening on port ${port}`);
    console.log(`[dashboard] Dashboard:    http://localhost:${port}/`);
    console.log(`[dashboard] API:          http://localhost:${port}/api/status`);
    console.log(`[dashboard] Health check: http://localhost:${port}/health`);
    console.log('[dashboard] Ready.\n');
  });

  return server;
}
