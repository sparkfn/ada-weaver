import { tool } from 'langchain';

// ── ToolCache ────────────────────────────────────────────────────────────────

export interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  size: number;
}

/**
 * Simple in-memory cache shared across all subagents within a single
 * runArchitect() call. Tracks hits/misses/invalidations for observability.
 */
export class ToolCache {
  private store = new Map<string, string>();
  private previousDiffs = new Map<string, string>();
  private _hits = 0;
  private _misses = 0;
  private _invalidations = 0;

  get(key: string): string | undefined {
    const value = this.store.get(key);
    if (value !== undefined) {
      this._hits++;
    } else {
      this._misses++;
    }
    return value;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  invalidate(key: string): boolean {
    const deleted = this.store.delete(key);
    if (deleted) this._invalidations++;
    return deleted;
  }

  /** Get the previous diff value (before last invalidation) */
  getPreviousDiff(key: string): string | undefined {
    return this.previousDiffs.get(key);
  }

  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        // Save diff values before invalidation for delta computation
        if (key.startsWith('diff:')) {
          this.previousDiffs.set(key, this.store.get(key)!);
        }
        this.store.delete(key);
        count++;
      }
    }
    this._invalidations += count;
    return count;
  }

  invalidateByPrefixAndSuffix(prefix: string, suffix: string): number {
    let count = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this.store.delete(key);
        count++;
      }
    }
    this._invalidations += count;
    return count;
  }

  clear(): void {
    this.store.clear();
  }

  getStats(): CacheStats {
    return {
      hits: this._hits,
      misses: this._misses,
      invalidations: this._invalidations,
      size: this.store.size,
    };
  }
}

// ── wrapWithCache ────────────────────────────────────────────────────────────

/**
 * Wrap a LangChain tool with cache-on-invoke behavior.
 *
 * Wraps the tool's internal `func` property (the user-provided handler) rather
 * than `invoke`. This is critical because `invoke` manages LangChain's Runnable
 * callback lifecycle (handleChainStart/handleChainEnd, ToolCall id propagation).
 * Bypassing `invoke` on a cache hit corrupts LangGraph's message graph.
 *
 * By wrapping `func`, the full Runnable infrastructure still runs on every call.
 * On a cache hit, only the actual API call inside `func` is skipped.
 *
 * The `func` receives already-parsed args (after zod schema processing), so
 * the `extractKey` callback receives clean args like `{ path, branch }`.
 */
export function wrapWithCache<T extends ReturnType<typeof tool>>(
  wrappedTool: T,
  cache: ToolCache,
  opts: { extractKey: (input: any) => string | undefined },
): T {
  const toolAny = wrappedTool as any;
  const originalFunc = toolAny.func;

  toolAny.func = async (input: any, ...rest: any[]) => {
    const key = opts.extractKey(input);
    if (key === undefined) {
      // No caching for this call (e.g., line-range reads)
      return originalFunc(input, ...rest);
    }
    const cached = cache.get(key);
    if (cached !== undefined) {
      console.log(`[CACHE HIT] ${wrappedTool.name} | ${key}`);
      return cached;
    }

    const result = await originalFunc(input, ...rest);
    cache.set(key, result);
    return result;
  };

  return wrappedTool;
}

// ── wrapWriteWithInvalidation ────────────────────────────────────────────────

/**
 * Wrap the coder's `create_or_update_file` tool with cache invalidation.
 *
 * Wraps `func` (not `invoke`) for the same reason as wrapWithCache.
 *
 * After a successful write to (path, branch):
 * - Invalidate `file:${path}:${branch}` (stale file content)
 * - Invalidate all `tree:*:${branch}` entries (file list changed)
 * - Invalidate all `diff:*` entries (PR diff changed)
 */
export function wrapWriteWithInvalidation<T extends ReturnType<typeof tool>>(
  wrappedTool: T,
  cache: ToolCache,
): T {
  const toolAny = wrappedTool as any;
  const originalFunc = toolAny.func;

  toolAny.func = async (input: any, ...rest: any[]) => {
    const result = await originalFunc(input, ...rest);

    // Invalidate on successful write — input is already-parsed args
    const path = input?.path;
    const branch = input?.branch;
    if (path && branch) {
      cache.invalidate(`file:${path}:${branch}`);
      cache.invalidateByPrefixAndSuffix('tree:', `:${branch}`);
      cache.invalidateByPrefix('diff:');
    }

    return result;
  };

  return wrappedTool;
}

// ── Cache key extractors ─────────────────────────────────────────────────────

// These receive already-parsed args from the tool's func (after zod processing).
// No need to handle ToolCall wrapping — that's resolved by invoke() before func().

/** Cache key for read_repo_file: `file:${path}:${branch}` — returns undefined for line-range reads (not cacheable) */
export function readFileKey(input: any): string | undefined {
  if (input.startLine !== undefined || input.endLine !== undefined) {
    return undefined;  // line-range reads bypass cache
  }
  return `file:${input.path}:${input.branch ?? 'main'}`;
}

/** Cache key for list_repo_files: `tree:${path}:${branch}:d${depth}` */
export function listFilesKey(input: any): string {
  const depth = input.depth != null ? input.depth : (input.path ? 'all' : '2');
  return `tree:${input.path ?? ''}:${input.branch ?? 'main'}:d${depth}`;
}

/** Cache key for get_pr_diff: `diff:${pull_number}` */
export function prDiffKey(input: any): string {
  return `diff:${input.pull_number}`;
}

// ── Diff delta utilities ──────────────────────────────────────────────────────

/** Parse a unified diff into per-file sections keyed by filename */
export function parseDiffIntoFiles(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  const sections = diff.split(/^(?=diff --git )/m);
  for (const section of sections) {
    const trimmed = section.trimEnd();
    const match = trimmed.match(/^diff --git a\/(.+?) b\//);
    if (match) {
      files.set(match[1], trimmed);
    }
  }
  return files;
}

/**
 * Compute a delta summary between a previous diff and a current diff.
 * Returns only NEW or CHANGED file sections, plus a summary header.
 */
export function computeDiffDelta(previousDiff: string, currentDiff: string): string {
  const prevFiles = parseDiffIntoFiles(previousDiff);
  const currFiles = parseDiffIntoFiles(currentDiff);

  const parts: string[] = [];
  const unchanged: string[] = [];

  for (const [file, section] of currFiles) {
    const prevSection = prevFiles.get(file);
    if (!prevSection) {
      parts.push(`// NEW FILE\n${section}`);
    } else if (prevSection !== section) {
      parts.push(`// CHANGED\n${section}`);
    } else {
      unchanged.push(file);
    }
  }

  // Build header
  let header = `[DELTA DIFF — showing only new/changed files since last review]\n`;
  if (unchanged.length > 0) {
    header += `Unchanged files (omitted): ${unchanged.join(', ')}\n`;
  }
  header += `---\n`;

  if (parts.length === 0) {
    return header + 'No changes since last review.';
  }

  return header + parts.join('\n');
}

// ── wrapDiffWithDelta ─────────────────────────────────────────────────────────

/**
 * Wrap the diff tool with delta computation.
 * On first call: behaves like wrapWithCache (returns full diff, caches it).
 * On subsequent calls (after cache was invalidated and re-fetched):
 *   compares with previousDiffs to return only the delta.
 */
export function wrapDiffWithDelta<T extends ReturnType<typeof tool>>(
  wrappedTool: T,
  cache: ToolCache,
  opts: { extractKey: (input: any) => string },
): T {
  const toolAny = wrappedTool as any;
  const originalFunc = toolAny.func;

  toolAny.func = async (input: any, ...rest: any[]) => {
    const key = opts.extractKey(input);
    const cached = cache.get(key);
    if (cached !== undefined) {
      console.log(`[CACHE HIT] ${wrappedTool.name} | ${key}`);
      return cached;
    }

    const result = await originalFunc(input, ...rest);

    // Check for previous diff to compute delta
    const previousDiff = cache.getPreviousDiff(key);
    if (previousDiff && !result.startsWith('Error')) {
      const delta = computeDiffDelta(previousDiff, result);
      cache.set(key, delta);  // Cache the delta for future hits
      return delta;
    }

    cache.set(key, result);
    return result;
  };

  return wrappedTool;
}
