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

  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
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

/** Cache key for read_repo_file: `file:${path}:${branch}` */
export function readFileKey(input: any): string {
  return `file:${input.path}:${input.branch ?? 'main'}`;
}

/** Cache key for list_repo_files: `tree:${path}:${branch}` */
export function listFilesKey(input: any): string {
  return `tree:${input.path ?? ''}:${input.branch ?? 'main'}`;
}

/** Cache key for get_pr_diff: `diff:${pull_number}` */
export function prDiffKey(input: any): string {
  return `diff:${input.pull_number}`;
}
