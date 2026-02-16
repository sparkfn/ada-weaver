import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryIssueContextRepository } from '../src/issue-context-repository.js';
import type { IssueContextEntry, AddEntryInput } from '../src/issue-context-repository.js';
import { createSaveContextTool, createGetContextTool, createSearchPastIssuesTool } from '../src/context-tools.js';

function makeEntry(overrides: Partial<AddEntryInput> = {}): AddEntryInput {
  return {
    repoId: 1,
    issueNumber: 42,
    processId: 'proc-1',
    entryType: 'issuer_brief',
    agent: 'issuer',
    content: 'Test content',
    filesTouched: ['src/foo.ts'],
    iteration: 0,
    ...overrides,
  };
}

// ── InMemoryIssueContextRepository ──────────────────────────────────────────

describe('InMemoryIssueContextRepository', () => {
  let repo: InMemoryIssueContextRepository;

  beforeEach(() => {
    repo = new InMemoryIssueContextRepository();
  });

  describe('addEntry + getEntriesForProcess', () => {
    it('stores and retrieves entries by processId', async () => {
      await repo.addEntry(makeEntry({ processId: 'proc-1' }));
      await repo.addEntry(makeEntry({ processId: 'proc-2' }));

      const entries = await repo.getEntriesForProcess('proc-1');
      expect(entries).toHaveLength(1);
      expect(entries[0].processId).toBe('proc-1');
    });

    it('assigns sequential IDs', async () => {
      const e1 = await repo.addEntry(makeEntry());
      const e2 = await repo.addEntry(makeEntry());
      expect(e1.id).toBe(1);
      expect(e2.id).toBe(2);
    });

    it('defaults filesTouched to empty array', async () => {
      const entry = await repo.addEntry({
        repoId: 1,
        issueNumber: 42,
        entryType: 'outcome',
        agent: 'architect',
        content: 'Done',
      });
      expect(entry.filesTouched).toEqual([]);
    });

    it('defaults iteration to 0', async () => {
      const entry = await repo.addEntry(makeEntry());
      expect(entry.iteration).toBe(0);
    });
  });

  describe('getEntriesForIssue', () => {
    it('retrieves all entries for a repo/issue', async () => {
      await repo.addEntry(makeEntry({ repoId: 1, issueNumber: 42 }));
      await repo.addEntry(makeEntry({ repoId: 1, issueNumber: 42, entryType: 'coder_plan' }));
      await repo.addEntry(makeEntry({ repoId: 1, issueNumber: 99 }));

      const entries = await repo.getEntriesForIssue(1, 42);
      expect(entries).toHaveLength(2);
    });

    it('filters by repoId', async () => {
      await repo.addEntry(makeEntry({ repoId: 1, issueNumber: 42 }));
      await repo.addEntry(makeEntry({ repoId: 2, issueNumber: 42 }));

      const entries = await repo.getEntriesForIssue(1, 42);
      expect(entries).toHaveLength(1);
    });
  });

  describe('getEntriesByType', () => {
    it('filters by entry type', async () => {
      await repo.addEntry(makeEntry({ entryType: 'issuer_brief' }));
      await repo.addEntry(makeEntry({ entryType: 'coder_plan' }));
      await repo.addEntry(makeEntry({ entryType: 'issuer_brief' }));

      const entries = await repo.getEntriesByType(1, 42, 'issuer_brief');
      expect(entries).toHaveLength(2);
    });
  });

  describe('searchByFiles', () => {
    it('finds entries with overlapping files', async () => {
      await repo.addEntry(makeEntry({ issueNumber: 10, filesTouched: ['src/foo.ts', 'src/bar.ts'] }));
      await repo.addEntry(makeEntry({ issueNumber: 11, filesTouched: ['src/baz.ts'] }));

      const results = await repo.searchByFiles(1, ['src/foo.ts']);
      expect(results).toHaveLength(1);
      expect(results[0].issueNumber).toBe(10);
    });

    it('excludes current issue', async () => {
      await repo.addEntry(makeEntry({ issueNumber: 42, filesTouched: ['src/foo.ts'] }));
      await repo.addEntry(makeEntry({ issueNumber: 10, filesTouched: ['src/foo.ts'] }));

      const results = await repo.searchByFiles(1, ['src/foo.ts'], { excludeIssueNumber: 42 });
      expect(results).toHaveLength(1);
      expect(results[0].issueNumber).toBe(10);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.addEntry(makeEntry({ issueNumber: i + 100, filesTouched: ['src/shared.ts'] }));
      }

      const results = await repo.searchByFiles(1, ['src/shared.ts'], { limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('returns empty when no overlap', async () => {
      await repo.addEntry(makeEntry({ filesTouched: ['src/other.ts'] }));
      const results = await repo.searchByFiles(1, ['src/foo.ts']);
      expect(results).toHaveLength(0);
    });
  });

  describe('searchRecent', () => {
    it('returns recent outcome entries', async () => {
      await repo.addEntry(makeEntry({ issueNumber: 10, entryType: 'outcome' }));
      await repo.addEntry(makeEntry({ issueNumber: 10, entryType: 'issuer_brief' }));
      await repo.addEntry(makeEntry({ issueNumber: 11, entryType: 'outcome' }));

      const results = await repo.searchRecent(1);
      expect(results).toHaveLength(2);
      // Most recent first
      expect(results[0].issueNumber).toBe(11);
    });

    it('excludes current issue', async () => {
      await repo.addEntry(makeEntry({ issueNumber: 42, entryType: 'outcome' }));
      await repo.addEntry(makeEntry({ issueNumber: 10, entryType: 'outcome' }));

      const results = await repo.searchRecent(1, { excludeIssueNumber: 42 });
      expect(results).toHaveLength(1);
      expect(results[0].issueNumber).toBe(10);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 15; i++) {
        await repo.addEntry(makeEntry({ issueNumber: i + 100, entryType: 'outcome' }));
      }

      const results = await repo.searchRecent(1, { limit: 5 });
      expect(results).toHaveLength(5);
    });
  });
});

// ── Context Tools ───────────────────────────────────────────────────────────

describe('Context Tools', () => {
  let repo: InMemoryIssueContextRepository;

  beforeEach(() => {
    repo = new InMemoryIssueContextRepository();
  });

  describe('save_issue_context', () => {
    it('saves an entry and returns confirmation', async () => {
      const saveTool = createSaveContextTool(repo, 1, 42, 'proc-1', 'issuer');

      const result = await saveTool.invoke({
        entry_type: 'issuer_brief',
        content: 'This issue is about adding auth',
        files_touched: ['src/auth.ts'],
      });

      const parsed = JSON.parse(result);
      expect(parsed.saved).toBe(true);
      expect(parsed.id).toBe(1);

      const entries = await repo.getEntriesForProcess('proc-1');
      expect(entries).toHaveLength(1);
      expect(entries[0].agent).toBe('issuer');
      expect(entries[0].content).toBe('This issue is about adding auth');
      expect(entries[0].filesTouched).toEqual(['src/auth.ts']);
    });

    it('saves with optional fields omitted', async () => {
      const saveTool = createSaveContextTool(repo, 1, 42, 'proc-1', 'coder');

      const result = await saveTool.invoke({
        entry_type: 'coder_plan',
        content: 'My plan is...',
      });

      const parsed = JSON.parse(result);
      expect(parsed.saved).toBe(true);

      const entries = await repo.getEntriesForProcess('proc-1');
      expect(entries[0].filesTouched).toEqual([]);
      expect(entries[0].iteration).toBe(0);
    });
  });

  describe('get_issue_context', () => {
    it('retrieves all entries for the process', async () => {
      await repo.addEntry(makeEntry({ processId: 'proc-1', entryType: 'issuer_brief' }));
      await repo.addEntry(makeEntry({ processId: 'proc-1', entryType: 'coder_plan' }));
      await repo.addEntry(makeEntry({ processId: 'proc-2', entryType: 'outcome' }));

      const getTool = createGetContextTool(repo, 'proc-1');
      const result = await getTool.invoke({});

      const parsed = JSON.parse(result);
      expect(parsed.entries).toHaveLength(2);
    });

    it('filters by entry_type', async () => {
      await repo.addEntry(makeEntry({ processId: 'proc-1', entryType: 'issuer_brief' }));
      await repo.addEntry(makeEntry({ processId: 'proc-1', entryType: 'coder_plan' }));

      const getTool = createGetContextTool(repo, 'proc-1');
      const result = await getTool.invoke({ entry_type: 'issuer_brief' });

      const parsed = JSON.parse(result);
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].entry_type).toBe('issuer_brief');
    });

    it('returns message when no entries found', async () => {
      const getTool = createGetContextTool(repo, 'proc-nonexistent');
      const result = await getTool.invoke({});

      const parsed = JSON.parse(result);
      expect(parsed.entries).toHaveLength(0);
      expect(parsed.message).toContain('No context entries');
    });
  });

  describe('search_past_issues', () => {
    it('finds past issues by file overlap', async () => {
      await repo.addEntry(makeEntry({
        issueNumber: 10,
        filesTouched: ['src/auth.ts', 'src/middleware.ts'],
        entryType: 'outcome',
      }));
      await repo.addEntry(makeEntry({
        issueNumber: 11,
        filesTouched: ['src/other.ts'],
        entryType: 'outcome',
      }));

      const searchTool = createSearchPastIssuesTool(repo, 1, 42);
      const result = await searchTool.invoke({ files: ['src/auth.ts'] });

      const parsed = JSON.parse(result);
      expect(parsed.past_issues).toHaveLength(1);
      expect(parsed.past_issues[0].issue_number).toBe(10);
    });

    it('excludes current issue from results', async () => {
      await repo.addEntry(makeEntry({
        issueNumber: 42,
        filesTouched: ['src/auth.ts'],
        entryType: 'outcome',
      }));
      await repo.addEntry(makeEntry({
        issueNumber: 10,
        filesTouched: ['src/auth.ts'],
        entryType: 'outcome',
      }));

      const searchTool = createSearchPastIssuesTool(repo, 1, 42);
      const result = await searchTool.invoke({ files: ['src/auth.ts'] });

      const parsed = JSON.parse(result);
      expect(parsed.past_issues).toHaveLength(1);
      expect(parsed.past_issues[0].issue_number).toBe(10);
    });

    it('returns recent outcomes when no files specified', async () => {
      await repo.addEntry(makeEntry({ issueNumber: 10, entryType: 'outcome' }));
      await repo.addEntry(makeEntry({ issueNumber: 11, entryType: 'outcome' }));
      await repo.addEntry(makeEntry({ issueNumber: 12, entryType: 'issuer_brief' }));

      const searchTool = createSearchPastIssuesTool(repo, 1, 42);
      const result = await searchTool.invoke({});

      const parsed = JSON.parse(result);
      expect(parsed.past_issues).toHaveLength(2);
    });

    it('groups results by issue number', async () => {
      await repo.addEntry(makeEntry({
        issueNumber: 10,
        filesTouched: ['src/shared.ts'],
        entryType: 'issuer_brief',
      }));
      await repo.addEntry(makeEntry({
        issueNumber: 10,
        filesTouched: ['src/shared.ts'],
        entryType: 'outcome',
      }));

      const searchTool = createSearchPastIssuesTool(repo, 1, 42);
      const result = await searchTool.invoke({ files: ['src/shared.ts'] });

      const parsed = JSON.parse(result);
      expect(parsed.past_issues).toHaveLength(1);
      expect(parsed.past_issues[0].issue_number).toBe(10);
      expect(parsed.past_issues[0].entries).toHaveLength(2);
    });

    it('returns message when no past issues found', async () => {
      const searchTool = createSearchPastIssuesTool(repo, 1, 42);
      const result = await searchTool.invoke({ files: ['src/nonexistent.ts'] });

      const parsed = JSON.parse(result);
      expect(parsed.past_issues).toHaveLength(0);
      expect(parsed.message).toContain('No past issues');
    });
  });
});
