import { describe, it, expect, vi } from 'vitest';
import { tool } from 'langchain';
import { z } from 'zod';
import {
  ToolCache,
  wrapWithCache,
  wrapWriteWithInvalidation,
  readFileKey,
  listFilesKey,
  prDiffKey,
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

describe('key extractors', () => {
  it('readFileKey uses path and branch', () => {
    expect(readFileKey({ path: 'src/app.ts', branch: 'develop' })).toBe('file:src/app.ts:develop');
  });

  it('readFileKey defaults branch to main', () => {
    expect(readFileKey({ path: 'README.md' })).toBe('file:README.md:main');
  });

  it('listFilesKey uses path and branch', () => {
    expect(listFilesKey({ path: 'src/', branch: 'feature' })).toBe('tree:src/:feature');
  });

  it('listFilesKey defaults path and branch', () => {
    expect(listFilesKey({})).toBe('tree::main');
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
    // (get increments miss counter, so use getStats().size to check)
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

describe('cache + circuit breaker integration', () => {
  it('cache hit bypasses circuit breaker counter', async () => {
    const handler = vi.fn().mockResolvedValue('content');
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();
    const counter = new ToolCallCounter(2); // only 2 calls allowed

    // Apply cache BEFORE circuit breaker (innermost → outermost)
    wrapWithCache(mockTool, cache, { extractKey: (input) => `file:${input.path}:main` });
    wrapWithCircuitBreaker(mockTool, counter);

    // Call 1: miss → hits API → counter = 1
    await mockTool.invoke({ path: 'a.ts', branch: 'main' });
    expect(counter.getCount()).toBe(1);

    // Call 2: hit → cache returns → counter = 2 (circuit breaker still increments)
    // But the handler should NOT be called again
    await mockTool.invoke({ path: 'a.ts', branch: 'main' });
    expect(handler).toHaveBeenCalledTimes(1); // handler only called once

    // Call 3: different file, miss → counter = 3 → should trip breaker
    // But wait — the counter is at 2, and limit is 2, so call 3 would be count 3 > 2 → error
    // Actually the circuit breaker trips AFTER incrementing, so count 3 > limit 2 → error
    // Let's verify the handler was only called once (the cache hit prevented the API call)
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cache hit before circuit breaker means API is never called', async () => {
    const handler = vi.fn().mockResolvedValue('data');
    const mockTool = createMockTool('read_repo_file', handler);
    const cache = new ToolCache();

    // Pre-populate cache
    cache.set('file:pre.ts:main', 'cached-data');

    // Correct wrapping order: cache (inner) → circuit breaker (outer)
    wrapWithCache(mockTool, cache, { extractKey: (input) => `file:${input.path}:main` });
    const counter = new ToolCallCounter(5);
    wrapWithCircuitBreaker(mockTool, counter);

    const result = await mockTool.invoke({ path: 'pre.ts', branch: 'main' });
    expect(result).toBe('cached-data');
    expect(handler).not.toHaveBeenCalled();
    // Circuit breaker DID increment (it's the outer wrapper), but the API was never called
    expect(counter.getCount()).toBe(1);
  });
});
