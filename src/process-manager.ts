import { EventEmitter } from 'events';
import type { Config } from './config.js';
import { runArchitect } from './architect.js';
import type { ContinueContext } from './architect.js';
import { runReviewSingle } from './reviewer-agent.js';
import { loadPollState } from './core.js';
import type { UsageService } from './usage-service.js';
import type { ProcessRepository } from './process-repository.js';

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface AgentProcess {
  id: string;
  type: 'analyze' | 'review';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  issueNumber?: number;
  prNumber?: number;
  prNumbers?: number[];
  owner: string;
  repo: string;
  startedAt: string;
  completedAt?: string;
  currentPhase?: string;
  activePhases?: string[];
  iteration?: number;
  maxIterations?: number;
  outcome?: string;
  error?: string;
  logs: string[];
}

export interface ProcessEvent {
  type: 'process_started' | 'process_updated' | 'process_completed'
      | 'process_failed' | 'process_cancelled' | 'process_log';
  process: AgentProcess;
  logLine?: string;
  timestamp: string;
}

export interface ProgressUpdate {
  phase: string;
  action: 'started' | 'completed' | 'reasoning';
  iteration?: number;
  maxIterations?: number;
  detail?: string;
  runId?: string;
}

// ── ProcessManager ───────────────────────────────────────────────────────────

export class ProcessManager extends EventEmitter {
  private processes: Map<string, AgentProcess> = new Map();
  private controllers: Map<string, AbortController> = new Map();
  private config: Config;
  private usageService?: UsageService;
  private processRepo?: ProcessRepository;

  constructor(config: Config, usageService?: UsageService, processRepo?: ProcessRepository) {
    super();
    this.config = config;
    this.usageService = usageService;
    this.processRepo = processRepo;
  }

  private persistSave(proc: AgentProcess): void {
    if (this.processRepo) {
      Promise.resolve(this.processRepo.save(proc)).catch(err =>
        console.error(`[process-manager] Failed to persist process ${proc.id}:`, err),
      );
    }
  }

  private persistUpdate(proc: AgentProcess): void {
    if (this.processRepo) {
      Promise.resolve(this.processRepo.update(proc)).catch(err =>
        console.error(`[process-manager] Failed to persist process update ${proc.id}:`, err),
      );
    }
  }

  continueAnalysis(issueNumber: number, prNumber: number, branchName: string, humanFeedback?: string): AgentProcess {
    const id = `continue-${issueNumber}-${Date.now()}`;
    const proc: AgentProcess = {
      id,
      type: 'analyze',
      status: 'running',
      issueNumber,
      prNumber,
      owner: this.config.github.owner,
      repo: this.config.github.repo,
      startedAt: new Date().toISOString(),
      logs: [],
    };

    this.processes.set(id, proc);
    this.persistSave(proc);
    const controller = new AbortController();
    this.controllers.set(id, controller);

    this.emitEvent('process_started', proc);

    this.runAnalysis(proc, controller.signal, {
      continueContext: { prNumber, branchName, humanFeedback },
    }).catch(() => {});

    return { ...proc };
  }

  startAnalysis(issueNumber: number, options: { dryRun?: boolean } = {}): AgentProcess {
    const id = `analyze-${issueNumber}-${Date.now()}`;
    const proc: AgentProcess = {
      id,
      type: 'analyze',
      status: 'running',
      issueNumber,
      owner: this.config.github.owner,
      repo: this.config.github.repo,
      startedAt: new Date().toISOString(),
      logs: [],
    };

    this.processes.set(id, proc);
    this.persistSave(proc);
    const controller = new AbortController();
    this.controllers.set(id, controller);

    this.emitEvent('process_started', proc);

    this.runAnalysis(proc, controller.signal, options).catch(() => {});

    return { ...proc };
  }

  startReview(prNumber: number): AgentProcess {
    const id = `review-${prNumber}-${Date.now()}`;
    const proc: AgentProcess = {
      id,
      type: 'review',
      status: 'running',
      prNumber,
      owner: this.config.github.owner,
      repo: this.config.github.repo,
      startedAt: new Date().toISOString(),
      logs: [],
    };

    this.processes.set(id, proc);
    this.persistSave(proc);
    const controller = new AbortController();
    this.controllers.set(id, controller);

    this.emitEvent('process_started', proc);

    this.runReview(proc, controller.signal).catch(() => {});

    return { ...proc };
  }

  cancelProcess(id: string): boolean {
    const proc = this.processes.get(id);
    if (!proc || proc.status !== 'running') return false;

    const controller = this.controllers.get(id);
    if (controller) controller.abort();

    proc.status = 'cancelled';
    proc.completedAt = new Date().toISOString();
    this.persistUpdate(proc);
    this.emitEvent('process_cancelled', proc);
    this.controllers.delete(id);
    return true;
  }

  async listProcesses(status?: string): Promise<AgentProcess[]> {
    // Start with in-memory processes (most up-to-date for running ones)
    const inMemory = new Map(this.processes);

    // Merge in historical processes from the DB
    if (this.processRepo) {
      const dbProcesses = await Promise.resolve(this.processRepo.list(status ? { status } : undefined));
      for (const dbProc of dbProcesses) {
        if (!inMemory.has(dbProc.id)) {
          // Fill owner/repo from config (not stored in DB)
          dbProc.owner = dbProc.owner || this.config.github.owner;
          dbProc.repo = dbProc.repo || this.config.github.repo;
          inMemory.set(dbProc.id, dbProc);
        }
      }
    }

    const all = Array.from(inMemory.values());
    if (status) return all.filter(p => p.status === status);
    return all;
  }

  async getProcess(id: string): Promise<AgentProcess | undefined> {
    // In-memory first (has the latest state for running processes)
    const proc = this.processes.get(id);
    if (proc) return { ...proc, logs: [...proc.logs] };

    // Fall back to DB
    if (this.processRepo) {
      const dbProc = await Promise.resolve(this.processRepo.getById(id));
      if (dbProc) {
        dbProc.owner = dbProc.owner || this.config.github.owner;
        dbProc.repo = dbProc.repo || this.config.github.repo;
        return dbProc;
      }
    }

    return undefined;
  }

  getHistory() {
    return loadPollState();
  }

  private interceptConsole(proc: AgentProcess): () => void {
    const origLog = console.log;
    const origError = console.error;

    const capture = (...args: any[]) => {
      const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
      proc.logs.push(line);
      this.emitEvent('process_log', proc, line);
    };

    console.log = (...args: any[]) => { capture(...args); origLog(...args); };
    console.error = (...args: any[]) => {
      capture('[ERROR] ' + args.map(a => typeof a === 'string' ? a : String(a)).join(' '));
      origError(...args);
    };

    return () => { console.log = origLog; console.error = origError; };
  }

  private async runAnalysis(
    proc: AgentProcess,
    signal: AbortSignal,
    options: { dryRun?: boolean; continueContext?: ContinueContext } = {},
  ): Promise<void> {
    const restore = this.interceptConsole(proc);

    try {
      const activeRunPhases = new Map<string, string>();

      const onProgress = (update: ProgressUpdate) => {
        const runId = update.runId ?? update.phase;
        if (update.action === 'started') {
          activeRunPhases.set(runId, update.phase);
        } else if (update.action === 'completed') {
          activeRunPhases.delete(runId);
        }
        proc.currentPhase = update.phase;
        proc.activePhases = Array.from(activeRunPhases.values());
        if (update.iteration !== undefined) proc.iteration = update.iteration;
        if (update.maxIterations !== undefined) proc.maxIterations = update.maxIterations;
        this.emitEvent('process_updated', proc);
      };

      const result = await runArchitect(this.config, proc.issueNumber!, {
        dryRun: options.dryRun,
        onProgress,
        signal,
        continueContext: options.continueContext,
        usageService: this.usageService,
        processId: proc.id,
      });

      if (signal.aborted) return; // already marked cancelled

      proc.status = 'completed';
      proc.completedAt = new Date().toISOString();
      proc.prNumber = result.prNumber ?? undefined;
      proc.prNumbers = result.prNumbers.length > 0 ? result.prNumbers : undefined;
      proc.outcome = result.outcome;
      this.persistUpdate(proc);
      this.emitEvent('process_completed', proc);
    } catch (err: unknown) {
      if (signal.aborted) return;

      proc.status = 'failed';
      proc.completedAt = new Date().toISOString();
      proc.error = err instanceof Error ? err.message : String(err);
      this.persistUpdate(proc);
      this.emitEvent('process_failed', proc);
    } finally {
      restore();
      this.controllers.delete(proc.id);
    }
  }

  private async runReview(proc: AgentProcess, signal: AbortSignal): Promise<void> {
    const restore = this.interceptConsole(proc);

    try {
      const result = await runReviewSingle(this.config, proc.prNumber!, {
        signal,
        usageService: this.usageService,
        processId: proc.id,
      });

      if (signal.aborted) return;

      proc.status = 'completed';
      proc.completedAt = new Date().toISOString();
      proc.outcome = result.summary;
      this.persistUpdate(proc);
      this.emitEvent('process_completed', proc);
    } catch (err: unknown) {
      if (signal.aborted) return;

      proc.status = 'failed';
      proc.completedAt = new Date().toISOString();
      proc.error = err instanceof Error ? err.message : String(err);
      this.persistUpdate(proc);
      this.emitEvent('process_failed', proc);
    } finally {
      restore();
      this.controllers.delete(proc.id);
    }
  }

  private emitEvent(
    type: ProcessEvent['type'],
    proc: AgentProcess,
    logLine?: string,
  ): void {
    const event: ProcessEvent = {
      type,
      process: { ...proc, logs: type === 'process_log' ? [] : [...proc.logs] },
      timestamp: new Date().toISOString(),
      ...(logLine !== undefined ? { logLine } : {}),
    };
    this.emit('process_event', event);
  }
}
