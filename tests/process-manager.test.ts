import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessManager } from '../src/process-manager.js';
import type { ProcessEvent, AgentProcess } from '../src/process-manager.js';

// Mock dependencies
vi.mock('../src/architect.js', () => ({
  runArchitect: vi.fn(),
}));

vi.mock('../src/reviewer-agent.js', () => ({
  runReviewSingle: vi.fn(),
}));

vi.mock('../src/core.js', () => ({
  loadPollState: vi.fn(),
}));

import { runArchitect } from '../src/architect.js';
import { runReviewSingle } from '../src/reviewer-agent.js';
import { loadPollState } from '../src/core.js';

const mockConfig = {
  github: { owner: 'test-owner', repo: 'test-repo', token: 'fake' },
  llm: { provider: 'anthropic', apiKey: 'fake', model: null, baseUrl: null },
} as any;

describe('ProcessManager', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    vi.clearAllMocks();
    pm = new ProcessManager(mockConfig);
  });

  describe('startAnalysis', () => {
    it('creates a process with correct fields', () => {
      vi.mocked(runArchitect).mockResolvedValue({
        issueNumber: 42,
        prNumber: 99,
        prNumbers: [99],
        outcome: 'Done',
      });

      const proc = pm.startAnalysis(42);

      expect(proc.id).toMatch(/^analyze-42-/);
      expect(proc.type).toBe('analyze');
      expect(proc.status).toBe('running');
      expect(proc.issueNumber).toBe(42);
      expect(proc.owner).toBe('test-owner');
      expect(proc.repo).toBe('test-repo');
      expect(proc.startedAt).toBeTruthy();
      expect(proc.logs).toEqual([]);
    });

    it('emits process_started event', () => {
      vi.mocked(runArchitect).mockResolvedValue({
        issueNumber: 42,
        prNumber: null,
        prNumbers: [],
        outcome: 'Done',
      });

      const events: ProcessEvent[] = [];
      pm.on('process_event', (e) => events.push(e));

      pm.startAnalysis(42);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('process_started');
      expect(events[0].process.issueNumber).toBe(42);
    });

    it('emits process_completed on success', async () => {
      vi.mocked(runArchitect).mockResolvedValue({
        issueNumber: 42,
        prNumber: 99,
        prNumbers: [99],
        outcome: 'All good',
      });

      const events: ProcessEvent[] = [];
      pm.on('process_event', (e) => events.push(e));

      pm.startAnalysis(42);

      // Wait for the async run to complete
      await vi.waitFor(() => {
        expect(events.some(e => e.type === 'process_completed')).toBe(true);
      });

      const completed = events.find(e => e.type === 'process_completed')!;
      expect(completed.process.status).toBe('completed');
      expect(completed.process.prNumber).toBe(99);
      expect(completed.process.outcome).toBe('All good');
    });

    it('emits process_failed on error', async () => {
      vi.mocked(runArchitect).mockRejectedValue(new Error('LLM failed'));

      const events: ProcessEvent[] = [];
      pm.on('process_event', (e) => events.push(e));

      pm.startAnalysis(42);

      await vi.waitFor(() => {
        expect(events.some(e => e.type === 'process_failed')).toBe(true);
      });

      const failed = events.find(e => e.type === 'process_failed')!;
      expect(failed.process.status).toBe('failed');
      expect(failed.process.error).toBe('LLM failed');
    });
  });

  describe('continueAnalysis', () => {
    it('creates a process with issue and PR pre-filled', () => {
      vi.mocked(runArchitect).mockImplementation(() => new Promise(() => {}));

      const proc = pm.continueAnalysis(20, 21, 'issue-20-fix');

      expect(proc.id).toMatch(/^continue-20-/);
      expect(proc.type).toBe('analyze');
      expect(proc.status).toBe('running');
      expect(proc.issueNumber).toBe(20);
      expect(proc.prNumber).toBe(21);
    });

    it('passes continueContext to runArchitect', async () => {
      vi.mocked(runArchitect).mockResolvedValue({
        issueNumber: 20,
        prNumber: 21,
        prNumbers: [21],
        outcome: 'Fixed',
      });

      pm.continueAnalysis(20, 21, 'issue-20-fix');

      await vi.waitFor(() => {
        expect(runArchitect).toHaveBeenCalled();
      });

      const call = vi.mocked(runArchitect).mock.calls[0];
      expect(call[2]?.continueContext).toEqual({
        prNumber: 21,
        branchName: 'issue-20-fix',
      });
    });
  });

  describe('startReview', () => {
    it('creates a review process with correct fields', () => {
      vi.mocked(runReviewSingle).mockResolvedValue({
        verdict: 'resolved',
        summary: 'Looks good',
        feedbackItems: [],
        reviewBody: '',
      });

      const proc = pm.startReview(10);

      expect(proc.id).toMatch(/^review-10-/);
      expect(proc.type).toBe('review');
      expect(proc.status).toBe('running');
      expect(proc.prNumber).toBe(10);
    });

    it('emits process_completed on review success', async () => {
      vi.mocked(runReviewSingle).mockResolvedValue({
        verdict: 'resolved',
        summary: 'All clear',
        feedbackItems: [],
        reviewBody: 'LGTM',
      });

      const events: ProcessEvent[] = [];
      pm.on('process_event', (e) => events.push(e));

      pm.startReview(10);

      await vi.waitFor(() => {
        expect(events.some(e => e.type === 'process_completed')).toBe(true);
      });

      const completed = events.find(e => e.type === 'process_completed')!;
      expect(completed.process.outcome).toBe('All clear');
    });
  });

  describe('cancelProcess', () => {
    it('cancels a running process', () => {
      vi.mocked(runArchitect).mockImplementation(
        () => new Promise(() => {}), // never resolves
      );

      const proc = pm.startAnalysis(42);

      const events: ProcessEvent[] = [];
      pm.on('process_event', (e) => events.push(e));

      const cancelled = pm.cancelProcess(proc.id);

      expect(cancelled).toBe(true);
      expect(events.some(e => e.type === 'process_cancelled')).toBe(true);
    });

    it('returns false for non-existent process', () => {
      expect(pm.cancelProcess('nonexistent')).toBe(false);
    });

    it('returns false for already completed process', async () => {
      vi.mocked(runArchitect).mockResolvedValue({
        issueNumber: 42,
        prNumber: null,
        prNumbers: [],
        outcome: 'Done',
      });

      const proc = pm.startAnalysis(42);

      // Wait for completion
      await vi.waitFor(async () => {
        const p = await pm.getProcess(proc.id);
        expect(p?.status).toBe('completed');
      });

      expect(pm.cancelProcess(proc.id)).toBe(false);
    });
  });

  describe('listProcesses', () => {
    it('lists all processes', async () => {
      vi.mocked(runArchitect).mockImplementation(() => new Promise(() => {}));
      vi.mocked(runReviewSingle).mockImplementation(() => new Promise(() => {}));

      pm.startAnalysis(1);
      pm.startAnalysis(2);
      pm.startReview(3);

      expect(await pm.listProcesses()).toHaveLength(3);
    });

    it('filters by status', async () => {
      vi.mocked(runArchitect).mockImplementation(() => new Promise(() => {}));

      const proc = pm.startAnalysis(1);
      pm.startAnalysis(2);
      pm.cancelProcess(proc.id);

      expect(await pm.listProcesses('running')).toHaveLength(1);
      expect(await pm.listProcesses('cancelled')).toHaveLength(1);
    });
  });

  describe('getProcess', () => {
    it('returns process by ID', async () => {
      vi.mocked(runArchitect).mockImplementation(() => new Promise(() => {}));

      const proc = pm.startAnalysis(42);
      const fetched = await pm.getProcess(proc.id);

      expect(fetched).toBeDefined();
      expect(fetched!.issueNumber).toBe(42);
    });

    it('returns undefined for unknown ID', async () => {
      expect(await pm.getProcess('unknown')).toBeUndefined();
    });
  });

  describe('getHistory', () => {
    it('delegates to loadPollState', () => {
      const mockState = {
        lastPollTimestamp: '2024-01-01T00:00:00.000Z',
        lastPollIssueNumbers: [1, 2],
        issues: {},
      };
      vi.mocked(loadPollState).mockReturnValue(mockState);

      const result = pm.getHistory();
      expect(result).toEqual(mockState);
      expect(loadPollState).toHaveBeenCalled();
    });

    it('returns null when no poll state exists', () => {
      vi.mocked(loadPollState).mockReturnValue(null);
      expect(pm.getHistory()).toBeNull();
    });
  });

  describe('concurrent phase tracking', () => {
    it('tracks activePhases via progress callback', async () => {
      let capturedOnProgress: ((update: any) => void) | undefined;

      vi.mocked(runArchitect).mockImplementation(async (_config, _issue, opts) => {
        capturedOnProgress = opts?.onProgress;
        // Simulate two concurrent subagents starting
        opts?.onProgress?.({ phase: 'coder', action: 'started', runId: 'run-1' });
        opts?.onProgress?.({ phase: 'coder', action: 'started', runId: 'run-2' });
        // Then one completes
        opts?.onProgress?.({ phase: 'coder', action: 'completed', runId: 'run-1' });
        return { issueNumber: 42, prNumber: null, prNumbers: [], outcome: 'Done' };
      });

      const events: ProcessEvent[] = [];
      pm.on('process_event', (e) => events.push(e));

      pm.startAnalysis(42);

      await vi.waitFor(() => {
        expect(events.some(e => e.type === 'process_completed')).toBe(true);
      });

      // After both started, activePhases should have had two entries
      const updateEvents = events.filter(e => e.type === 'process_updated');
      // The second started event should show 2 active phases
      expect(updateEvents.length).toBeGreaterThanOrEqual(3);
      const secondStart = updateEvents[1];
      expect(secondStart.process.activePhases).toEqual(['coder', 'coder']);
      // After one completed, should have 1 remaining
      const afterComplete = updateEvents[2];
      expect(afterComplete.process.activePhases).toEqual(['coder']);
    });

    it('sets prNumbers from result', async () => {
      vi.mocked(runArchitect).mockResolvedValue({
        issueNumber: 42,
        prNumber: 10,
        prNumbers: [10, 11],
        outcome: 'Done',
      });

      const events: ProcessEvent[] = [];
      pm.on('process_event', (e) => events.push(e));

      pm.startAnalysis(42);

      await vi.waitFor(() => {
        expect(events.some(e => e.type === 'process_completed')).toBe(true);
      });

      const completed = events.find(e => e.type === 'process_completed')!;
      expect(completed.process.prNumbers).toEqual([10, 11]);
    });
  });

  describe('log capture', () => {
    it('emits process_log events during execution', async () => {
      vi.mocked(runArchitect).mockImplementation(async () => {
        console.log('Test log line');
        return { issueNumber: 42, prNumber: null, prNumbers: [], outcome: 'Done' };
      });

      const logEvents: ProcessEvent[] = [];
      pm.on('process_event', (e) => {
        if (e.type === 'process_log') logEvents.push(e);
      });

      pm.startAnalysis(42);

      await vi.waitFor(() => {
        expect(logEvents.length).toBeGreaterThan(0);
      });

      expect(logEvents.some(e => e.logLine?.includes('Test log line'))).toBe(true);
    });
  });
});
