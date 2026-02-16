import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import type { Request, Response } from 'express';
import type { Config } from './config.js';
import { ProcessManager } from './process-manager.js';
import { UsageService } from './usage-service.js';
import type { UsageQuery, UsageGroupBy } from './usage-types.js';
import type { UsageRepository } from './usage-repository.js';
import type { ProcessRepository } from './process-repository.js';
import type { IssueContextRepository } from './issue-context-repository.js';
import type { RepoRepository } from './repo-repository.js';
import { verifySignature, handleWebhookEvent } from './listener.js';
import { chatStream } from './chat-agent.js';

// ── Static directory ─────────────────────────────────────────────────────────

function getStaticDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', 'static');
}

// ── Query parser ─────────────────────────────────────────────────────────────

const VALID_GROUP_BY = new Set<UsageGroupBy>(['agent', 'provider', 'model', 'processId', 'day', 'month']);

function parseUsageQuery(query: Record<string, any>): UsageQuery {
  const result: UsageQuery = {};
  if (typeof query.agent === 'string' && query.agent) result.agent = query.agent as any;
  if (typeof query.provider === 'string' && query.provider) result.provider = query.provider as any;
  if (typeof query.model === 'string' && query.model) result.model = query.model;
  if (typeof query.processId === 'string' && query.processId) result.processId = query.processId;
  if (typeof query.since === 'string' && query.since) result.since = query.since;
  if (typeof query.until === 'string' && query.until) result.until = query.until;
  if (query.issueNumber !== undefined) {
    const n = parseInt(query.issueNumber, 10);
    if (!isNaN(n)) result.issueNumber = n;
  }
  if (query.limit !== undefined) {
    const n = parseInt(query.limit, 10);
    if (!isNaN(n) && n > 0) result.limit = n;
  }
  if (query.offset !== undefined) {
    const n = parseInt(query.offset, 10);
    if (!isNaN(n) && n >= 0) result.offset = n;
  }
  return result;
}

// ── Express app factory ──────────────────────────────────────────────────────

export interface DashboardOptions {
  usageRepository?: UsageRepository;
  processRepository?: ProcessRepository;
  issueContextRepository?: IssueContextRepository;
  repoRepository?: RepoRepository;
  repoId?: number;
}

export function createDashboardApp(config: Config, options?: DashboardOptions): { app: express.Express; processManager: ProcessManager; usageService: UsageService } {
  const app = express();
  const usageService = new UsageService(options?.usageRepository);
  const processManager = new ProcessManager(config, usageService, options?.processRepository, options?.issueContextRepository, options?.repoId, options?.repoRepository);

  // Parse JSON for all routes except /webhook (which needs the raw body for HMAC)
  app.use((req, res, next) => {
    if (req.path === '/webhook') return next();
    express.json()(req, res, next);
  });

  // Serve dashboard.html at root
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(getStaticDir(), 'dashboard.html'));
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Status summary
  app.get('/api/status', async (_req: Request, res: Response) => {
    const all = await processManager.listProcesses();
    const running = all.filter(p => p.status === 'running');
    res.json({
      owner: config.github.owner,
      repo: config.github.repo,
      runningCount: running.length,
      totalCount: all.length,
    });
  });

  // List processes
  app.get('/api/processes', async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const processes = await processManager.listProcesses(status);
    res.json(processes.map(p => ({ ...p, logs: [] })));
  });

  // Get single process (includes logs)
  app.get('/api/processes/:id', async (req: Request, res: Response) => {
    const proc = await processManager.getProcess(req.params.id);
    if (!proc) {
      res.status(404).json({ error: 'Process not found' });
      return;
    }
    res.json(proc);
  });

  // Start analysis
  app.post('/api/processes/analyze', (req: Request, res: Response) => {
    const { issueNumber, dryRun, repoId } = req.body as { issueNumber?: number; dryRun?: boolean; repoId?: number };
    if (!issueNumber || typeof issueNumber !== 'number' || issueNumber < 1) {
      res.status(400).json({ error: 'issueNumber must be a positive integer' });
      return;
    }
    const proc = processManager.startAnalysis(issueNumber, { dryRun, repoId });
    res.status(201).json(proc);
  });

  // Continue analysis (review→fix loop on existing PR)
  app.post('/api/processes/continue', (req: Request, res: Response) => {
    const { issueNumber, prNumber, branchName, repoId } = req.body as {
      issueNumber?: number;
      prNumber?: number;
      branchName?: string;
      repoId?: number;
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
    const proc = processManager.continueAnalysis(issueNumber, prNumber, branchName, undefined, repoId);
    res.status(201).json(proc);
  });

  // Start review
  app.post('/api/processes/review', (req: Request, res: Response) => {
    const { prNumber, repoId } = req.body as { prNumber?: number; repoId?: number };
    if (!prNumber || typeof prNumber !== 'number' || prNumber < 1) {
      res.status(400).json({ error: 'prNumber must be a positive integer' });
      return;
    }
    const proc = processManager.startReview(prNumber, { repoId });
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

  // ── Repo CRUD endpoints ────────────────────────────────────────────────────

  app.get('/api/repos', async (req: Request, res: Response) => {
    if (!options?.repoRepository) {
      res.status(501).json({ error: 'Repo management requires a database' });
      return;
    }
    const activeOnly = req.query.activeOnly !== 'false';
    const repos = await options.repoRepository.list(activeOnly);
    res.json(repos);
  });

  app.post('/api/repos', async (req: Request, res: Response) => {
    if (!options?.repoRepository) {
      res.status(501).json({ error: 'Repo management requires a database' });
      return;
    }
    const { owner, repo, configJson } = req.body as { owner?: string; repo?: string; configJson?: Record<string, unknown> };
    if (!owner || typeof owner !== 'string' || !repo || typeof repo !== 'string') {
      res.status(400).json({ error: 'owner and repo are required strings' });
      return;
    }
    try {
      const record = await options.repoRepository.create(owner.trim(), repo.trim(), configJson);
      res.status(201).json(record);
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'Repo already exists' });
        return;
      }
      throw err;
    }
  });

  app.patch('/api/repos/:id', async (req: Request, res: Response) => {
    if (!options?.repoRepository) {
      res.status(501).json({ error: 'Repo management requires a database' });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid repo id' });
      return;
    }
    const { configJson } = req.body as { configJson?: Record<string, unknown> };
    const updated = await options.repoRepository.update(id, { configJson });
    if (!updated) {
      res.status(404).json({ error: 'Repo not found' });
      return;
    }
    res.json(updated);
  });

  app.delete('/api/repos/:id', async (req: Request, res: Response) => {
    if (!options?.repoRepository) {
      res.status(501).json({ error: 'Repo management requires a database' });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid repo id' });
      return;
    }
    const deactivated = await options.repoRepository.deactivate(id);
    if (!deactivated) {
      res.status(404).json({ error: 'Repo not found or already deactivated' });
      return;
    }
    res.json({ deactivated: true });
  });

  // ── Usage API endpoints ─────────────────────────────────────────────────────

  // Usage summary
  app.get('/api/usage/summary', async (req: Request, res: Response) => {
    const filter = parseUsageQuery(req.query);
    res.json(await usageService.summarize(filter));
  });

  // Usage records (paginated)
  app.get('/api/usage/records', async (req: Request, res: Response) => {
    const filter = parseUsageQuery(req.query);
    const [records, total] = await Promise.all([
      usageService.query(filter),
      usageService.count(filter),
    ]);
    res.json({ records, total });
  });

  // Usage group by
  app.get('/api/usage/group/:groupBy', async (req: Request, res: Response) => {
    const groupBy = req.params.groupBy as UsageGroupBy;
    if (!VALID_GROUP_BY.has(groupBy)) {
      res.status(400).json({ error: `Invalid groupBy: ${groupBy}. Must be one of: ${[...VALID_GROUP_BY].join(', ')}` });
      return;
    }
    const filter = parseUsageQuery(req.query);
    res.json(await usageService.groupBy(groupBy, filter));
  });

  // ── SSE event stream ────────────────────────────────────────────────────────

  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write('data: {"type":"connected"}\n\n');

    const onProcessEvent = (event: any) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const onUsageRecorded = (record: any) => {
      res.write(`data: ${JSON.stringify({ type: 'usage_recorded', record })}\n\n`);
    };

    processManager.on('process_event', onProcessEvent);
    usageService.on('usage_recorded', onUsageRecorded);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`data: {"type":"heartbeat","timestamp":"${new Date().toISOString()}"}\n\n`);
    }, 30000);

    req.on('close', () => {
      processManager.off('process_event', onProcessEvent);
      usageService.off('usage_recorded', onUsageRecorded);
      clearInterval(heartbeat);
    });
  });

  return { app, processManager, usageService };
}

// ── Server start ─────────────────────────────────────────────────────────────

export function startDashboardServer(config: Config, port: number, options?: DashboardOptions) {
  const { app } = createDashboardApp(config, options);

  const server = app.listen(port, () => {
    console.log(`[dashboard] Listening on port ${port}`);
    console.log(`[dashboard] Dashboard:    http://localhost:${port}/`);
    console.log(`[dashboard] API:          http://localhost:${port}/api/status`);
    console.log(`[dashboard] Health check: http://localhost:${port}/health`);
    console.log('[dashboard] Ready.\n');
  });

  return server;
}

// ── Unified server (dashboard + webhook + dialog on one port) ───────────────

export function createUnifiedApp(config: Config, options?: DashboardOptions): { app: express.Express; processManager: ProcessManager; usageService: UsageService } {
  const { app, processManager, usageService } = createDashboardApp(config, options);

  // ── Webhook route ───────────────────────────────────────────────────────────
  // Raw body parsing for HMAC verification (must be before json middleware hits this path)
  app.post('/webhook', express.raw({ type: 'application/json' }), (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;

    const secret = config.webhook?.secret;
    if (!secret) {
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifySignature(secret, rawBody, signature)) {
      console.error('[webhook] Signature verification failed');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const event = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    if (!event) {
      res.status(400).json({ error: 'Missing X-GitHub-Event header' });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    const webhookEvent = {
      event,
      deliveryId: deliveryId ?? 'unknown',
      payload,
    };

    const action = typeof payload.action === 'string' ? payload.action : '';
    console.log(
      `[webhook] Received: ${event}${action ? `.${action}` : ''} ` +
      `(delivery: ${webhookEvent.deliveryId})`,
    );

    res.status(200).json({ received: true, event, deliveryId: webhookEvent.deliveryId });

    try {
      // Route issues.opened through ProcessManager for full tracking + SSE
      if (event === 'issues' && action === 'opened') {
        const issue = payload.issue as any;
        if (issue?.number) {
          processManager.startAnalysis(issue.number);
        }
      } else {
        handleWebhookEvent(webhookEvent, config);
      }
    } catch (err) {
      console.error(`[webhook] Handler error for ${event}.${action}:`, err);
    }
  });

  // ── Dialog routes ───────────────────────────────────────────────────────────

  app.get('/dialog', (_req: Request, res: Response) => {
    res.sendFile(path.join(getStaticDir(), 'dialog.html'));
  });

  app.post('/chat', express.json(), async (req: Request, res: Response) => {
    const { message, sessionId } = req.body as { message?: string; sessionId?: string };

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "message" field' });
      return;
    }

    const sid = sessionId || crypto.randomUUID();

    console.log(`[chat] Session ${sid}: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      for await (const event of chatStream(config, message, sid)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      console.error(`[chat] Error for session ${sid}:`, err);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Chat agent failed' })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });

  return { app, processManager, usageService };
}

export function startUnifiedServer(config: Config, options?: DashboardOptions) {
  const port = config.port ?? 3000;
  const { app } = createUnifiedApp(config, options);

  const server = app.listen(port, () => {
    console.log(`[serve] Listening on port ${port}`);
    console.log(`[serve] Dashboard:    http://localhost:${port}/`);
    console.log(`[serve] Dialog:       http://localhost:${port}/dialog`);
    console.log(`[serve] Webhook:      http://localhost:${port}/webhook`);
    console.log(`[serve] Chat API:     http://localhost:${port}/chat`);
    console.log(`[serve] API:          http://localhost:${port}/api/status`);
    console.log(`[serve] Health check: http://localhost:${port}/health`);
    console.log('[serve] Ready.\n');
  });

  return server;
}
