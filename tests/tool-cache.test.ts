import { describe, it, expect, vi } from 'vitest';
import { tool } from 'langchain';
import { z } from 'zod';
import {
  ToolCache,
  wrapWithCache,
  wrapWriteWithInvalidation,
  wrapDiffWithDelta,
  readFileKey,
  listFilesKey,
  prDiffKey,
  parseDiffIntoFiles,
  computeDiffDelta,
} from '../src/tool-cache.js';
import { ToolCallCounter, wrapWithCircuitBreaker } from '../src/github-tools.js';

// ── Helper: create a mock LangChain tool ─────────────────────────────────────

function createMockTool(name: string, handler: (input: any) => Promise<string>) {
  return tool(handler, {
    name,
    description: `Mock ${name} tool`,
    schema: z.object({
      path: z.string().optional(),
      branch: z.string().optional(),
      pull_number: z.number().optional(),
      content: z.string().optional(),
      message: z.string().optional(),
    }),
  });
}

// ── ToolCache ────────────────────────────────────────────────────────────────

describe('ToolCache', () => {
  it('returns undefined for missing key and counts as miss', () => {
    const cache = new ToolCache();
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().hits).toBe(0);
  });

  it('stores and retrieves values, counting as hit', () => {
    const cache = new ToolCache();
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');
    expect(cache.getStats().hits).toBe(1);
  });

  it('overwrites existing value', () => {
    const cache = new ToolCache();
    cache.set('key', 'v1');
    cache.set('key', 'v2');
    expect(cache.get('key')).toBe('v2');
  });

  it('invalidate removes entry and tracks invalidation count', () => {
    const cache = new ToolCache();
    cache.set('key', 'value');
    expect(cache.invalidate('key')).toBe(true);
    expect(cache.get('key')).toBeUndefined();
    expect(cache.getStats().invalidations).toBe(1);
  });

  it('invalidate returns false for missing key', () => {
    const cache = new ToolCache();
    expect(cache.invalidate('nope')).toBe(false);
    expect(cache.getStats().invalidations).toBe(0);
  });

  it('invalidateByPrefix removes all matching entries', () => {
    const cache = new ToolCache();
    cache.set('tree:src:main', 'a');
    cache.set('tree::main', 'b');
    cache.set('file:x:main', 'c');
    const count = cache.invalidateByPrefix('tree:');
    expect(count).toBe(2);
    expect(cache.get('tree:src:main')).toBeUndefined();
    expect(cache.get('tree::main')).toBeUndefined();
    expect(cache.get('file:x:main')).toBe('c');
    expect(cache.getStats().invalidations).toBe(2);
  });

  it('invalidateByPrefix returns 0 when no matches', () => {
    const cache = new ToolCache();
    cache.set('file:a:main', 'x');
    expect(cache.invalidateByPrefix('diff:')).toBe(0);
  });

  it('invalidateByPrefixAndSuffix removes precise matches', () => {
    const cache = new ToolCache();
    cache.set('tree:src:main', 'a');
    cache.set('tree:src:develop', 'b');
    cache.set('tree::main', 'c');
    cache.set('file:x:main', 'd');
    const count = cache.invalidateByPrefixAndSuffix('tree:', ':main');
    expect(count).toBe(2);
    expect(cache.get('tree:src:main')).toBeUndefined();
    expect(cache.get('tree::main')).toBeUndefined();
    // These should remain
    expect(cache.get('tree:src:develop')).toBe('b');
    expect(cache.get('file:x:main')).toBe('d');
  });

  it('clear empties the cache', () => {
    const cache = new ToolCache();
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.getStats().size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('getStats returns correct snapshot', () => {
    const cache = new ToolCache();
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a');          // hit
    cache.get('missing');    // miss
    cache.invalidate('b');   // invalidation
    const stats = cache.getStats();
    expect(stats).toEqual({ hits: 1, misses: 1, invalidations: 1, size: 1 });
  });
});

// ── Key extractors ───────────────────────────────────────────────────────────
// Key extractors receive already-parsed args from the tool's func (after zod).

describe('key extractors', () => {
  it('readFileKey uses path and branch', () => {
    expect(readFileKey({ path: 'src/app.ts', branch: 'develop' })).toBe('file:src/app.ts:develop');
  });

  it('readFileKey defaults branch to main', () => {
    expect(readFileKey({ path: 'README.md' })).toBe('file:README.md:main');
  });

  it('listFilesKey uses path and branch with depth', () => {
    expect(listFilesKey({ path: 'src/', branch: 'feature' })).toBe('tree:src/:feature:dall');
  });

  it('listFilesKey defaults path and branch with default depth', () => {
    expect(listFilesKey({})).toBe('tree::main:d2');
  });

  it('listFilesKey includes explicit depth', () => {
    expect(listFilesKey({ path: '', depth: 5 })).toBe('tree::main:d5');
  });

  it('prDiffKey uses pull_number', () => {
    expect(prDiffKey({ pull_number: 42 })).toBe('diff:42');
  });
});

// ── wrapWithCache ────────────────────────────────────────────────────────────

describe('wrapWithCache', () => {
  it('calls original on cache miss and stores result', async () => {
    const handler = vi.fn().mockResolvedValue('file-content');
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();

    wrapWithCache(mockTool, cache, { extractKey: (input) => `file:${input.path}:${input.branch}` });

    const result = await mockTool.invoke({ path: 'src/a.ts', branch: 'main' });
    expect(result).toBe('file-content');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().hits).toBe(0);
  });

  it('returns cached value on hit and skips original', async () => {
    const handler = vi.fn().mockResolvedValue('fresh-content');
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();

    wrapWithCache(mockTool, cache, { extractKey: (input) => `file:${input.path}:${input.branch}` });

    // First call — miss
    await mockTool.invoke({ path: 'src/a.ts', branch: 'main' });
    // Second call — hit
    const result = await mockTool.invoke({ path: 'src/a.ts', branch: 'main' });
    expect(result).toBe('fresh-content');
    expect(handler).toHaveBeenCalledTimes(1); // NOT called again
    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(1);
  });

  it('different keys produce different cache entries', async () => {
    let callCount = 0;
    const handler = vi.fn().mockImplementation(async () => `content-${++callCount}`);
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();

    wrapWithCache(mockTool, cache, { extractKey: (input) => `file:${input.path}:${input.branch}` });

    const r1 = await mockTool.invoke({ path: 'a.ts', branch: 'main' });
    const r2 = await mockTool.invoke({ path: 'b.ts', branch: 'main' });
    expect(r1).toBe('content-1');
    expect(r2).toBe('content-2');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('returns the same tool reference (mutates in place)', () => {
    const mockTool = createMockTool('test', async () => 'ok');
    const cache = new ToolCache();
    const wrapped = wrapWithCache(mockTool, cache, { extractKey: () => 'k' });
    expect(wrapped).toBe(mockTool);
  });
});

// ── wrapWriteWithInvalidation ────────────────────────────────────────────────

describe('wrapWriteWithInvalidation', () => {
  it('invalidates file, tree, and diff entries after write', async () => {
    const handler = vi.fn().mockResolvedValue('{"sha":"abc"}');
    const mockTool = createMockTool('create_or_update_file', handler);
    const cache = new ToolCache();

    // Pre-populate cache entries
    cache.set('file:src/app.ts:feature', 'old-content');
    cache.set('tree:src:feature', 'old-tree');
    cache.set('tree::feature', 'old-root-tree');
    cache.set('tree:src:main', 'other-branch-tree'); // different branch — should survive
    cache.set('diff:42', 'old-diff');
    cache.set('diff:99', 'other-diff');

    wrapWriteWithInvalidation(mockTool, cache);

    await mockTool.invoke({ path: 'src/app.ts', branch: 'feature', content: 'new', message: 'update' });

    expect(handler).toHaveBeenCalledTimes(1);

    // file entry for this path+branch should be gone
    expect(cache.get('file:src/app.ts:feature')).toBeUndefined();

    // tree entries for this branch should be gone
    expect(cache.get('tree:src:feature')).toBeUndefined();
    expect(cache.get('tree::feature')).toBeUndefined();

    // tree on different branch should survive
    expect(cache.get('tree:src:main')).toBe('other-branch-tree');

    // ALL diff entries should be gone (any PR might be affected)
    expect(cache.get('diff:42')).toBeUndefined();
    expect(cache.get('diff:99')).toBeUndefined();
  });

  it('still returns the original tool result', async () => {
    const handler = vi.fn().mockResolvedValue('write-result');
    const mockTool = createMockTool('create_or_update_file', handler);
    const cache = new ToolCache();

    wrapWriteWithInvalidation(mockTool, cache);

    const result = await mockTool.invoke({ path: 'a.ts', branch: 'main', content: 'x', message: 'y' });
    expect(result).toBe('write-result');
  });

  it('returns the same tool reference', () => {
    const mockTool = createMockTool('test', async () => 'ok');
    const cache = new ToolCache();
    const wrapped = wrapWriteWithInvalidation(mockTool, cache);
    expect(wrapped).toBe(mockTool);
  });
});

// ── Integration: cache hit does NOT increment circuit breaker ────────────────
// Cache wraps func (innermost), circuit breaker wraps invoke (outermost).
// A cache hit still goes through invoke → circuit breaker increments → but
// the API handler inside func is never called.

describe('cache + circuit breaker integration', () => {
  it('cache hit skips the handler but circuit breaker still counts', async () => {
    const handler = vi.fn().mockResolvedValue('content');
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();
    const counter = new ToolCallCounter(5);

    // Apply cache on func, circuit breaker on invoke
    wrapWithCache(mockTool, cache, { extractKey: (input) => `file:${input.path}:main` });
    wrapWithCircuitBreaker(mockTool, counter);

    // Call 1: miss → hits API → counter = 1
    await mockTool.invoke({ path: 'a.ts', branch: 'main' });
    expect(counter.getCount()).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);

    // Call 2: hit → cache returns from func → counter = 2
    // But the handler should NOT be called again
    await mockTool.invoke({ path: 'a.ts', branch: 'main' });
    expect(counter.getCount()).toBe(2);
    expect(handler).toHaveBeenCalledTimes(1); // handler only called once
  });

  it('pre-populated cache hit means API handler is never called', async () => {
    const handler = vi.fn().mockResolvedValue('data');
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();

    // Pre-populate cache
    cache.set('file:pre.ts:main', 'cached-data');

    wrapWithCache(mockTool, cache, { extractKey: (input) => `file:${input.path}:main` });
    const counter = new ToolCallCounter(5);
    wrapWithCircuitBreaker(mockTool, counter);

    const result = await mockTool.invoke({ path: 'pre.ts', branch: 'main' });
    expect(result).toBe('cached-data');
    expect(handler).not.toHaveBeenCalled();
    expect(counter.getCount()).toBe(1); // circuit breaker did count
  });
});

// ── readFileKey with line ranges ──────────────────────────────────────────────

describe('readFileKey with line ranges', () => {
  it('returns undefined when startLine is set', () => {
    expect(readFileKey({ path: 'src/a.ts', startLine: 10 })).toBeUndefined();
  });

  it('returns undefined when endLine is set', () => {
    expect(readFileKey({ path: 'src/a.ts', endLine: 50 })).toBeUndefined();
  });

  it('returns undefined when both startLine and endLine are set', () => {
    expect(readFileKey({ path: 'src/a.ts', startLine: 10, endLine: 50 })).toBeUndefined();
  });

  it('returns normal key when no range params', () => {
    expect(readFileKey({ path: 'src/a.ts', branch: 'main' })).toBe('file:src/a.ts:main');
  });
});

// ── wrapWithCache with undefined keys ─────────────────────────────────────────

describe('wrapWithCache with undefined keys', () => {
  it('skips cache when extractKey returns undefined', async () => {
    const handler = vi.fn().mockResolvedValue('result');
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();

    wrapWithCache(mockTool, cache, { extractKey: () => undefined });

    const result = await mockTool.invoke({ path: 'a.ts' });
    expect(result).toBe('result');
    expect(handler).toHaveBeenCalledTimes(1);
    // Should not count as hit or miss since cache was bypassed
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(0);
  });

  it('does not store result when extractKey returns undefined', async () => {
    const handler = vi.fn().mockResolvedValue('result');
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();

    wrapWithCache(mockTool, cache, { extractKey: () => undefined });

    await mockTool.invoke({ path: 'a.ts' });
    expect(cache.getStats().size).toBe(0);
  });
});

// ── parseDiffIntoFiles ────────────────────────────────────────────────────────

describe('parseDiffIntoFiles', () => {
  it('parses multi-file diff into per-file map', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old2
+new2`;

    const files = parseDiffIntoFiles(diff);
    expect(files.size).toBe(2);
    expect(files.has('src/a.ts')).toBe(true);
    expect(files.has('src/b.ts')).toBe(true);
    expect(files.get('src/a.ts')).toContain('-old');
    expect(files.get('src/b.ts')).toContain('-old2');
  });

  it('returns empty map for empty string', () => {
    const files = parseDiffIntoFiles('');
    expect(files.size).toBe(0);
  });

  it('handles single-file diff', () => {
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new`;

    const files = parseDiffIntoFiles(diff);
    expect(files.size).toBe(1);
    expect(files.has('README.md')).toBe(true);
  });
});

// ── computeDiffDelta ──────────────────────────────────────────────────────────

describe('computeDiffDelta', () => {
  const fileASection = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new`;

  const fileBSection = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old2
+new2`;

  const fileCSection = `diff --git a/src/c.ts b/src/c.ts
--- /dev/null
+++ b/src/c.ts
@@ -0,0 +1 @@
+brand new file`;

  it('returns only new files when a file was added', () => {
    const prev = fileASection;
    const curr = `${fileASection}\n${fileCSection}`;
    const delta = computeDiffDelta(prev, curr);

    expect(delta).toContain('[DELTA DIFF');
    expect(delta).toContain('// NEW FILE');
    expect(delta).toContain('src/c.ts');
    expect(delta).toContain('Unchanged files (omitted): src/a.ts');
  });

  it('returns only changed files when content differs', () => {
    const prevA = fileASection;
    const currAModified = fileASection.replace('-old', '-modified');
    const delta = computeDiffDelta(prevA, currAModified);

    expect(delta).toContain('// CHANGED');
    expect(delta).toContain('src/a.ts');
  });

  it('omits unchanged files and lists them in header', () => {
    const prev = `${fileASection}\n${fileBSection}`;
    const curr = `${fileASection}\n${fileBSection}\n${fileCSection}`;
    const delta = computeDiffDelta(prev, curr);

    expect(delta).toContain('Unchanged files (omitted): src/a.ts, src/b.ts');
    expect(delta).toContain('// NEW FILE');
    expect(delta).toContain('src/c.ts');
    // Should NOT contain the full diff for unchanged files
    expect(delta).not.toContain('-old2');
  });

  it('returns "No changes" when diffs are identical', () => {
    const delta = computeDiffDelta(fileASection, fileASection);
    expect(delta).toContain('No changes since last review.');
  });
});

// ── ToolCache.getPreviousDiff ─────────────────────────────────────────────────

describe('ToolCache.getPreviousDiff', () => {
  it('returns undefined when no previous diff exists', () => {
    const cache = new ToolCache();
    expect(cache.getPreviousDiff('diff:42')).toBeUndefined();
  });

  it('returns saved value after invalidateByPrefix on diff key', () => {
    const cache = new ToolCache();
    cache.set('diff:42', 'original-diff');
    cache.invalidateByPrefix('diff:');

    expect(cache.get('diff:42')).toBeUndefined(); // gone from store
    expect(cache.getPreviousDiff('diff:42')).toBe('original-diff'); // saved
  });

  it('does not save non-diff keys as previous diffs', () => {
    const cache = new ToolCache();
    cache.set('file:a.ts:main', 'content');
    cache.invalidateByPrefix('file:');

    expect(cache.getPreviousDiff('file:a.ts:main')).toBeUndefined();
  });
});

// ── wrapDiffWithDelta ─────────────────────────────────────────────────────────

describe('wrapDiffWithDelta', () => {
  it('first call returns full diff (no previous)', async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new`;
    const handler = vi.fn().mockResolvedValue(diff);
    const mockTool = createMockTool('get_pr_diff', handler);
    const cache = new ToolCache();

    wrapDiffWithDelta(mockTool, cache, { extractKey: (input) => `diff:${input.pull_number}` });

    const result = await mockTool.invoke({ pull_number: 42 });
    expect(result).toBe(diff); // full diff on first call
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cache hit returns cached value', async () => {
    const handler = vi.fn().mockResolvedValue('fresh-diff');
    const mockTool = createMockTool('get_pr_diff', handler);
    const cache = new ToolCache();

    wrapDiffWithDelta(mockTool, cache, { extractKey: (input) => `diff:${input.pull_number}` });

    await mockTool.invoke({ pull_number: 42 }); // miss → cache
    const result = await mockTool.invoke({ pull_number: 42 }); // hit
    expect(result).toBe('fresh-diff');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('after invalidation + re-fetch, returns delta diff', async () => {
    const origDiff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new`;
    const newDiff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/b.ts b/src/b.ts\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+added`;

    let callCount = 0;
    const handler = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? origDiff : newDiff;
    });
    const mockTool = createMockTool('get_pr_diff', handler);
    const cache = new ToolCache();

    wrapDiffWithDelta(mockTool, cache, { extractKey: (input) => `diff:${input.pull_number}` });

    // First call: full diff
    const first = await mockTool.invoke({ pull_number: 42 });
    expect(first).toBe(origDiff);

    // Simulate write invalidation (what wrapWriteWithInvalidation does)
    cache.invalidateByPrefix('diff:');

    // Second call: should return delta
    const second = await mockTool.invoke({ pull_number: 42 });
    expect(second).toContain('[DELTA DIFF');
    expect(second).toContain('// NEW FILE');
    expect(second).toContain('src/b.ts');
  });

  it('error results are not delta-compared', async () => {
    const origDiff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new`;
    let callCount = 0;
    const handler = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? origDiff : 'Error fetching diff for PR #42: Not found';
    });
    const mockTool = createMockTool('get_pr_diff', handler);
    const cache = new ToolCache();

    wrapDiffWithDelta(mockTool, cache, { extractKey: (input) => `diff:${input.pull_number}` });

    await mockTool.invoke({ pull_number: 42 });
    cache.invalidateByPrefix('diff:');

    const second = await mockTool.invoke({ pull_number: 42 });
    expect(second).toContain('Error');
    expect(second).not.toContain('[DELTA DIFF');
  });
});
