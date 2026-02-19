# Changelog

> **Versioning plan:** Patch bumps per issue, minor bumps at phase milestones.
> See LEARNING_LOG.md Entry 8 for the full dependency map and version targets.
>
> v0.2.0 = Phase 1 (Code Awareness) | v0.3.0 = Phase 2 + 3 (Safety + CLI/Tests)
> v0.4.0 = Phase 4 (Intelligence) | v0.5.0 = Phase 5 (Resilience) | v0.6.0 = Phase 6 (Webhooks)
> v0.7.0 = Phase 7 (Deployment) | v1.0.0 = Phase 8 (Reviewer Bot)

---

## v2.7.0 — 2026-02-19

**Bitrix24 notifications & app settings.** Agents now send real-time notifications to a Bitrix24 chat when they create PRs or sub-issues. Configuration is managed through a new Settings tab in the dashboard (on/off toggle, base URL, user ID, webhook ID, dialog ID) and persisted to a `settings` key-value table in PostgreSQL. The notification hooks use a tool-wrapping pattern — the `create_pull_request` and `create_sub_issue` tools are wrapped to fire notifications on success without changing the tool interface.

### Added
- **Bitrix24 notification handler** (`src/bitrix-notification.ts`) — sends BB-code messages to a Bitrix24 chat via REST API on PR or issue creation
- **Tool wrappers** `wrapPrToolWithNotification` / `wrapIssueToolWithNotification` — monkey-patch tool `invoke()` to fire notifications after successful creation (same pattern as `wrapWithOutputCap`)
- **Settings repository** (`src/settings-repository.ts`) — generic key-value store interface with `get`/`set`/`getAll`/`delete`; in-memory + PostgreSQL implementations
- **DB migration** `004_settings.sql` — `settings` table (TEXT primary key + JSONB value)
- **Settings API** — `GET /api/settings`, `GET /api/settings/:key`, `PUT /api/settings/:key`, `DELETE /api/settings/:key`
- **Dashboard Settings tab** — Bitrix24 configuration panel with on/off switch, text fields for all connection params, save button
- **Workspace branch fetch** — after unshallow, runs `git remote set-branches origin "*"` + `git fetch --all` so non-default branches are available for base branch checkout

### Changed
- Coder prompt now includes `git fetch origin <base_branch>` before `git checkout` to ensure remote branches are available
- `ProcessManager` constructor accepts optional `settingsRepo` parameter, threaded through to `runArchitect` → `createArchitect` → `createCoderSubagent`
- `DashboardOptions` extended with `settingsRepository`
- New process dialog requires repo selection (searchable Autocomplete, always visible)

---

## v2.6.0 — 2026-02-16

**Lean agent middleware & pricing CRUD.** Two major changes: (1) Switched all 4 agent entry points from `createDeepAgent` (deepagents library) to `createAgent` (langchain) with manually selected middleware — eliminating ~1,980 tokens/call of unused overhead from `todoListMiddleware`, `createFilesystemMiddleware` (duplicate tools), and `BASE_PROMPT`. Combined with lowered caps, estimated 30-45% reduction in input token usage. (2) Added a pricing management system with CRUD API, DB persistence, dashboard UI, and GPT-5.2 support. (3) Retroactive cost recalculation — old records with $0 cost now show correct costs based on current pricing.

### Added
- **Pricing CRUD API** — 5 new endpoints in `src/dashboard.ts`:
  - `GET /api/pricing/defaults` — returns built-in pricing table
  - `GET /api/pricing` — list DB pricing overrides
  - `POST /api/pricing` — create a model pricing record (409 on duplicate)
  - `PUT /api/pricing/:id` — update pricing record
  - `DELETE /api/pricing/:id` — delete pricing record
- **`PricingRepository`** interface (`src/pricing-repository.ts`) + PostgreSQL implementation (`src/db/pg-pricing-repository.ts`)
- **DB migration** `003_pricing.sql` — `pricing` table with `model_prefix`, `input_cost_per_million`, `output_cost_per_million`
- **`setPricingLookup` / `buildPricingLookup`** in `src/usage-pricing.ts` — DB pricing overrides built-in table via longest-prefix matching; refreshed on every pricing mutation
- **GPT-5.2 pricing** added to built-in table ($1.75/$14 per 1M tokens)
- **Dashboard Pricing tab** — view defaults + DB overrides, add/edit/delete pricing records; built-in defaults rows are clickable to create overrides
- **Retroactive cost recalculation** in `UsageService` — `query()`, `summarize()`, and `groupBy()` recalculate `estimatedCost` at query time using current pricing, so old records created before a model was added to the pricing table now show correct costs

### Changed
- **`src/architect.ts`** — replaced `createDeepAgent` with `createAgent` + `createSubAgentMiddleware`, `summarizationMiddleware` (50K threshold), `anthropicPromptCachingMiddleware`, `createPatchToolCallsMiddleware`; subagent `defaultMiddleware` now excludes `todoListMiddleware` and `createFilesystemMiddleware`, adds `createContextCompactionMiddleware`
- **`src/single-agent.ts`** — replaced `createDeepAgent` with `createAgent` + selective middleware; summarization threshold lowered to 50K tokens
- **`src/reviewer-agent.ts`** — replaced `createDeepAgent` with `createAgent` + selective middleware
- **`src/chat-agent.ts`** — replaced `createDeepAgent` with `createAgent` + selective middleware
- **Tool output cap** lowered from 10K → 6K chars (`src/tool-output-cap.ts`)
- **Context compaction threshold** lowered from 80K → 40K chars (`src/context-compaction.ts`)
- **PR diff cap** lowered from 50K → 15K chars (`src/github-tools.ts`)
- **Subagents** in multi-agent mode now get context compaction middleware (previously only single-agent had it)
- `calculateCost()` now checks DB pricing lookup before falling back to built-in table
- `UsageService` recalculates cost at query time (not just at record creation)
- **Dashboard UI** — removed Actions columns from Processes and Pricing panels; processes show cancel button inline with status chip; built-in defaults rows are clickable to open override dialog

### Tests
- Updated diff truncation assertion in `tests/reviewer-agent.test.ts` (50000 → 15000)
- Added pricing repository tests (`tests/pricing-repository.test.ts`)
- Added pricing-related tests in `tests/usage-pricing.test.ts` and `tests/dashboard.test.ts`
- **726 tests across 23 test files — all passing**

---

## v2.5.0 — 2026-02-16

**Multi-Repo CRUD.** The dashboard now supports managing multiple GitHub repositories. While the database schema already supported multi-repo (all tables FK to `repos.id`), there was no way to add or manage repos — only the env-var repo was auto-upserted on startup. This release adds a full CRUD interface for repos, a Repos tab in the dashboard, and per-process repo selection so any process can target a non-default repo.

### Added
- **Repo CRUD API** — 4 new endpoints in `src/dashboard.ts`:
  - `GET /api/repos` — list repos (with `?activeOnly=true/false` filter)
  - `POST /api/repos` — create a repo (409 on duplicate via PG unique violation `23505`)
  - `PATCH /api/repos/:id` — update repo `configJson`
  - `DELETE /api/repos/:id` — soft-deactivate a repo (`is_active = FALSE`)
  - All routes return 501 when no database is configured
- **`create`, `update`, `deactivate` methods** on `RepoRepository` interface (`src/repo-repository.ts`)
- **PostgreSQL implementations** in `src/db/pg-repo-repository.ts` — INSERT, UPDATE config_json, soft-delete
- **`StaticRepoRepository` stubs** — throw descriptive errors (no DB = no write support)
- **`resolveRepoConfig()` helper** in `ProcessManager` — looks up a repo by id, clones the config with overridden `owner`/`repo`, shares the same token/LLM settings
- **Repos tab** in dashboard (`static/dashboard.html`) — table with Owner/Repo, Active/Inactive chip, Added date, Deactivate button
- **`AddRepoDialog`** component — owner + repository text fields with duplicate detection
- **Repo selector** in `NewProcessDialog` — `Select` dropdown populated from active repos, passes `repoId` to process creation
- **AppBar repo count** — shows `owner/repo (+N more)` when multiple repos exist
- 12 new tests in `tests/dashboard.test.ts` — `MockRepoRepository` (in-memory with duplicate detection), GET/POST/PATCH/DELETE routes, 409/400/404 edge cases, 501 without database, process routes with `repoId` — **702 tests total**

### Changed
- `DashboardOptions` interface gains `repoRepository?: RepoRepository`
- `ProcessManager` constructor accepts 6th param `repoRepo?: RepoRepository`; `startAnalysis`, `startReview`, `continueAnalysis` accept optional `repoId`
- `runAnalysis`/`runReview` resolve repo config before calling agents; only emit `process_updated` when repo actually changes
- Process creation routes (`POST /api/processes/analyze`, `/review`, `/continue`) accept optional `repoId` in request body
- `src/cli.ts` passes `repoRepository` to `startUnifiedServer`/`startDashboardServer` (only when `config.database` is set)
- Dashboard frontend adds `Select`, `MenuItem`, `FormControl`, `InputLabel` MUI imports

---

## v2.4.0 — 2026-02-16

**Tool Output Context Management.** Two-layer defense against oversized tool outputs blowing the LLM context window. Tool-level caps truncate the 4 worst offenders (bash, grep, issue bodies, CI summaries) before output leaves the handler. A universal safety-net wrapper (`wrapWithOutputCap`) is applied at all tool assembly points as the outermost layer.

### Added
- **`src/tool-output-cap.ts`** — universal output cap wrapper (`wrapWithOutputCap`). Wraps any LangChain tool's `invoke()` to truncate string results exceeding a configurable char limit (default 10K). Non-string results pass through unchanged. Same mutate-in-place pattern as `wrapWithCircuitBreaker` and `wrapWithLogging`.
- 16 new tests — **9** in `tests/tool-output-cap.test.ts` (cap behavior, composition, non-string passthrough), **3** in `tests/local-tools.test.ts` (bash/grep truncation), **4** in `tests/github-tools.test.ts` (body/summary truncation) — **689 tests total**

### Changed
- **`src/local-tools.ts`** — bash output capped at 8K chars (both success and error paths); grep output capped at 8K chars
- **`src/github-tools.ts`** — issue bodies capped at 2K chars (`fetch_github_issues`, `fetch_sub_issues`, `get_parent_issue`); CI output summaries capped at 1K chars (`check_ci_status`)
- **`src/architect.ts`** — `wrapWithOutputCap()` applied at all 4 tool assembly points (issuer, coder, reviewer, architect)
- **`src/single-agent.ts`** — `wrapWithOutputCap()` applied in `buildSingleAgentTools()`

---

## v2.3.0 — 2026-02-16

**Token-Efficient Agent Prompts & Reduced Read Default.** Five changes to reduce file-reading token waste by ~40% across multi-iteration runs. Agents now reuse prior context instead of re-exploring, use targeted partial reads instead of full files, and skip re-exploration on fix iterations.

### Changed
- **Coder planning phase** (`architect.ts`) — now requires `get_issue_context` first to reuse the Issuer's brief instead of re-exploring files; `list_files` used only for files not already covered
- **Coder fix iterations** (`architect.ts`) — now explicitly skips re-exploration; reads only lines mentioned in reviewer feedback via grep + `start_line`/`end_line`
- **Reviewer local tools section** (`architect.ts`) — added TOKEN-EFFICIENT READING guidance: read only diff files, use `start_line`/`end_line` for ±30 lines around changes, grep first for large files
- **Reviewer base workflow** (`reviewer-agent.ts`) — updated step 2 to target only files touched in the diff with partial reads instead of full file reads
- **`read_file` tool** (`local-tools.ts`) — default truncation reduced from 500 → 200 lines; description now encourages grep-first workflow for files >100 lines
- **673 tests** — all passing (no test changes needed)

---

## v2.2.0 — 2026-02-16

**Single-Agent Mode & Context Compaction.** Adds an alternative execution mode where one agent handles the entire issue lifecycle (analysis, planning, implementation, self-review, fix iterations) in a single context window, retaining full working memory across phases. When context grows too large, a compaction middleware automatically truncates old messages. Usage tracking records the LLM model name as the agent identifier instead of a generic role.

### Added
- **`src/single-agent.ts`** — single-agent mode module with:
  - `buildSingleAgentTools()` — assembles all 15 tools from all subagent roles into one flat array
  - `buildSingleAgentSystemPrompt()` — comprehensive 5-phase prompt (analysis → planning → implementation → self-review → fix iteration)
  - `createSingleAgent()` — factory matching `createArchitect()` return shape
  - `runSingleAgent()` — runner with phase detection from tool names, same `ArchitectResult` return type
- **`src/context-compaction.ts`** — middleware that compacts old messages when total context chars exceed 80K:
  - Preserves seed HumanMessage (index 0) and last 10 messages
  - Truncates ToolMessage content and long AIMessage text/args in between
  - Idempotent — detects already-compacted content and skips re-truncation
  - Configurable: `maxTotalChars`, `maxToolResultChars`, `preserveRecentCount`
- **`AGENT_MODE` env var** — `'multi'` (default) or `'single'`; documented in `.env.example`
- **`agentMode`** field in config (`src/config.ts`)
- 34 new tests — **15** in `tests/single-agent.test.ts` (system prompt, tool assembly, dry-run, context tools), **19** in `tests/context-compaction.test.ts` (threshold gating, truncation, preservation, idempotency) — **673 tests total**

### Changed
- `runArchitect()` branches on `config.agentMode === 'single'` — dynamic import of `runSingleAgent()` keeps the module from loading when not needed
- `AgentRole` type widened to `(string & {})` to accept model names as agent identifiers in usage tracking
- Single-agent usage records show the LLM model name (e.g., `claude-sonnet-4-20250514`) instead of `'single-agent'`

---

## v2.1.0 — 2026-02-16

**Targeted File Reading & Diff Context Reduction.** Two efficiency improvements to reduce token waste during agent runs. The `read_repo_file` tool now accepts optional `startLine`/`endLine` parameters so agents can request just the lines they need instead of always fetching the first 500. The reviewer's diff tool now computes deltas — after the first review, subsequent reviews see only new/changed file sections instead of the full PR diff, saving significant tokens during multi-iteration review-fix cycles.

### Added
- **`startLine`/`endLine` params** on `read_repo_file` — 1-indexed, inclusive range; response includes `startLine`, `endLine`, `total_lines` metadata
- **`parseDiffIntoFiles()`** in `src/tool-cache.ts` — splits a unified diff into per-file sections keyed by filename
- **`computeDiffDelta()`** in `src/tool-cache.ts` — compares two diffs and returns only NEW or CHANGED file sections with a summary header
- **`wrapDiffWithDelta()`** in `src/tool-cache.ts` — wraps the diff tool with delta computation; first call returns full diff, subsequent calls after cache invalidation return only the delta
- **`previousDiffs`** map on `ToolCache` — auto-saves diff values before `invalidateByPrefix` deletes them, enabling delta computation
- **`getPreviousDiff()`** method on `ToolCache` — retrieves the pre-invalidation diff for a key
- 30 new tests — **586 tests total** (9 in github-tools.test.ts, 21 in tool-cache.test.ts)

### Changed
- `readFileKey()` returns `undefined` for line-range reads (not cacheable — different ranges for same file)
- `wrapWithCache()` accepts `string | undefined` from `extractKey` — skips caching when `undefined`
- Reviewer's diff tool uses `wrapDiffWithDelta` instead of `wrapWithCache` in `createReviewerSubagent()`
- Truncation note on large files now mentions `startLine/endLine` instead of `list_repo_files`

---

## v2.0.0 — 2026-02-16

**Issue Context System — Shared Memory for Agents.** Adds a shared `issue_context` table that acts like a Jira ticket: all agents read from and write to it, eliminating the "telephone game" where the Architect paraphrases each agent's output. Sub-agents can now read each other's raw analysis, plans, and feedback directly. Enables cross-run learning from past issues via file overlap search. Also restricts parallel coder delegation to prevent duplicate PRs and wasted tokens.

### Added
- **`src/db/migrations/002_issue_context.sql`** — new table with GIN index on `files_touched`
- **`src/issue-context-repository.ts`** — `IssueContextRepository` interface, types, and `InMemoryIssueContextRepository`
- **`src/db/pg-issue-context-repository.ts`** — `PostgresIssueContextRepository` with `&&` array overlap search
- **`src/context-tools.ts`** — three LangChain tools: `save_issue_context`, `get_issue_context`, `search_past_issues`
- Auto-capture backstop: subagent outputs saved as context entries automatically
- 24 new tests — **564 tests total**

### Changed
- `createArchitect()` builds per-agent context tools; all sub-agent prompts include "SHARED CONTEXT" instructions
- Parallel delegation restricted to issues with explicit sub-issues only
- Architect must always pass exact issue number when delegating to coder
- `Repositories`, `ProcessManager`, `DashboardOptions`, CLI all forward `contextRepo`

---

## v1.10.0 — 2026-02-16

**Unified Process Tracking.** All code paths that call `runArchitect()` — dashboard UI, poll cycle, and webhook — now create `AgentProcess` records in the database. The Processes tab becomes the single source of truth for all runs. The History tab (which only showed poll-cycle data from `last_poll.json`) is removed.

### Added
- **Poll cycle process tracking** in `src/core.ts` — `runPollCycle()` accepts optional `processRepository` and saves an `AgentProcess` record after each `runArchitect()` call (both success and failure)
- **Standalone webhook process tracking** in `src/listener.ts` — `handleIssuesEvent()` accepts optional `processRepository` and saves `AgentProcess` records; `handleWebhookEvent()` threads the repository through
- **Unified webhook routing** in `src/dashboard.ts` — `issues.opened` events in unified server mode are routed through `processManager.startAnalysis()` instead of `handleWebhookEvent()`, giving full process tracking + SSE live updates

### Removed
- **`/api/history` endpoint** from `src/dashboard.ts` — no longer needed
- **`getHistory()` method** from `ProcessManager` — no longer needed
- **`loadPollState` import** from `src/process-manager.ts` — no longer needed
- **History tab** from `static/dashboard.html` — `HistoryPanel` and `HistoryDetailContent` components removed; tabs reduced from Processes/History/Usage to Processes/Usage
- **History-related state** from dashboard `App` component — `selectedHistoryIssue`, `selectedHistoryActions`, `handleHistorySelect`, history fetch call all removed
- **`GET /api/history` test** from `tests/dashboard.test.ts`
- **`getHistory` tests** and `loadPollState` mock from `tests/process-manager.test.ts`

### Changed
- `src/cli.ts` passes `processRepository` to `runPollCycle()` options
- Dashboard tabs reduced from 3 (Processes, History, Usage) to 2 (Processes, Usage)
- **561 tests** across 17 test files (was 563 — removed 2 history tests)

---

## v1.9.0 — 2026-02-16

**Conversation Pruning at Iteration Boundaries.** Adds middleware that compresses old review-fix cycle messages before each model call, reducing context bloat during multi-iteration Architect runs. After 2+ completed reviewer round-trips, previous iterations' task responses are truncated and non-task tool results are cleared, keeping critical facts (PR numbers, verdicts, branch names) while shedding verbosity.

### Added
- **`src/context-pruning.ts`** — new module with `createIterationPruningMiddleware()` factory
  - Uses `createMiddleware` from `langchain` with a `wrapModelCall` hook that mutates `request.messages` in-place before each model call
  - `findIterationBoundaries()`: detects completed review-fix cycles by finding reviewer task delegation + response pairs
  - `compressOldIterations()`: truncates old task ToolMessage content to 500 chars (configurable), truncates AIMessage `args.prompt` to 200 chars, replaces non-task ToolMessages with `[Previous iteration tool result cleared]`
  - Configurable via `maxCompressedLength` option
- 21 new tests in `tests/context-pruning.test.ts` — boundary detection, compression, preservation of latest iteration, interleaved verification tools, edge cases — **540 tests total**

### Changed
- `createArchitect()` in `src/architect.ts` passes `middleware: [createIterationPruningMiddleware()]` to `createDeepAgent`

---

## v1.8.0 — 2026-02-15

**Shared File Cache for the Architect Pipeline.** Adds an in-memory file cache shared across all subagents within a single `runArchitect()` call. File contents, directory listings, and PR diffs are cached so that when multiple subagents (issuer, coder, reviewer) read the same files, only the first call hits the GitHub API. Write operations automatically invalidate affected cache entries. Expected to cut input tokens by 30-40% on typical runs.

### Added
- **`src/tool-cache.ts`** — new module with `ToolCache` class, `wrapWithCache()` wrapper, `wrapWriteWithInvalidation()` wrapper, and cache key extractors (`readFileKey`, `listFilesKey`, `prDiffKey`)
  - `ToolCache`: `Map<string, string>`-based cache with hit/miss/invalidation stats tracking, prefix and prefix+suffix invalidation
  - `wrapWithCache()`: wraps a LangChain tool to check cache before invoking, following the existing `wrapWithCircuitBreaker`/`wrapWithLogging` pattern
  - `wrapWriteWithInvalidation()`: wraps `create_or_update_file` to invalidate stale file, tree, and diff entries after writes
- **Cache stats** logged at the end of every `runArchitect()` run (hits, misses, hit rate, invalidations, entries)
- **`cacheStats`** field on `ArchitectResult` — includes hits, misses, invalidations, size, hitRate
- 30 new tests: `tests/tool-cache.test.ts` (24 tests for ToolCache, wrapWithCache, wrapWriteWithInvalidation, cache+circuit breaker integration) + `tests/architect.test.ts` (6 tests for backward compat and cache flow) — **511 tests total**

### Changed
- `createArchitect()` creates a shared `ToolCache` instance and passes it to all subagent factories; returns `{ agent, cache }` instead of just `agent`
- `createIssuerSubagent()` accepts optional `cache` param — wraps `list_repo_files` and `read_repo_file`
- `createCoderSubagent()` accepts optional `cache` param — wraps reads + write invalidation on `create_or_update_file`
- `createReviewerSubagent()` accepts optional `cache` param — wraps `get_pr_diff`, `list_repo_files`, `read_repo_file`
- `createReviewerAgent()` in `reviewer-agent.ts` accepts optional `cache` param; cache is applied BEFORE circuit breaker so cache hits don't count toward the tool call limit
- Architect's own read-only tools (`list_repo_files`, `read_repo_file`) are also wrapped with the shared cache

---

## v1.7.0 — 2026-02-15

**PostgreSQL Persistence & Multi-Repo Schema.** Adds PostgreSQL as an optional persistence layer, replacing file-based poll state (`last_poll.json`) and in-memory storage for LLM usage metrics and agent process history. Poll state, issue actions, agent processes, and usage records all survive restarts when a database is configured. The schema supports multiple repositories via a `repos` table. Without `DATABASE_URL`, the system falls back to file/in-memory storage (existing behavior unchanged).

### Added
- **Database schema** (`src/db/migrations/001_initial_schema.sql`) — 6 tables: `repos`, `poll_state`, `issue_actions`, `agent_processes`, `llm_usage`, `schema_migrations` with appropriate indexes
- **Connection pool** (`src/db/connection.ts`) — singleton `initPool()`/`getPool()` from `DATABASE_URL` or individual `PG_*` env vars
- **Migration runner** (`src/db/migrate.ts`) — discovers SQL files in `src/db/migrations/`, runs unapplied ones in transactions, tracks applied versions in `schema_migrations`
- **Repository interfaces** — `PollRepository` (`src/poll-repository.ts`), `ProcessRepository` (`src/process-repository.ts`), `RepoRepository` (`src/repo-repository.ts`)
- **File/in-memory implementations** — `FilePollRepository`, `InMemoryProcessRepository`, `StaticRepoRepository` (wrap existing logic, zero behavior change)
- **PostgreSQL implementations** — `PostgresRepoRepository` (`src/db/pg-repo-repository.ts`), `PostgresPollRepository` (`src/db/pg-poll-repository.ts`), `PostgresUsageRepository` (`src/db/pg-usage-repository.ts`), `PostgresProcessRepository` (`src/db/pg-process-repository.ts`)
- **Repository factory** (`src/db/repositories.ts`) — `createRepositories(config)` returns PG or file/in-memory repos based on whether `config.database` is set; auto-runs migrations and seeds the `repos` table on startup
- **`migrate` CLI command** — `deepagents migrate` runs database migrations standalone; also available as `pnpm migrate`
- **Database config** in `src/config.ts` — reads `DATABASE_URL` or `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USER`/`PG_PASSWORD`
- **`repoId` field** on `LLMUsageRecord` and `UsageQuery` in `src/usage-types.ts` — supports multi-repo filtering
- **PostgreSQL Docker service** in `docker-compose.yml` — `postgres:17-alpine` with health check, `pgdata` volume, `DATABASE_URL` wired to bot

### Changed
- `runPollCycle()`, `showStatus()`, `retractIssue()` in `src/core.ts` accept optional `PollRepository` parameter (backward-compatible default: `FilePollRepository`); all poll repo calls are now `await`-ed for async PG support
- `ProcessManager` accepts optional `ProcessRepository`; persists process state on start/complete/fail/cancel; `listProcesses()` and `getProcess()` now merge in-memory (running) with DB (historical) so completed processes survive restarts
- `UsageRepository` interface returns `T | Promise<T>` to support both sync (in-memory) and async (PG) implementations
- `UsageService` methods (`query`, `summarize`, `groupBy`, `count`, `getById`) are now `async`; `record()` uses fire-and-forget for async repos
- `PollRepository` interface returns `T | Promise<T>` for the same reason
- `formatUsageSummaryComment()` in `architect.ts` is now `async`
- `createDashboardApp()`, `createUnifiedApp()`, `startDashboardServer()`, `startUnifiedServer()` accept optional `DashboardOptions` with injected `UsageRepository` and `ProcessRepository`
- Dashboard API handlers (`/api/status`, `/api/processes`, `/api/usage/*`) are now `async` with `await`
- `serve`, `dashboard`, `poll` CLI commands initialize repositories via `createRepositories()` factory
- `docker-compose.yml`: added `postgres` service, bot `depends_on: postgres`, `DATABASE_URL` env var, removed `last_poll.json` volume mount
- `InMemoryUsageRepository.matchesFilter()` now supports `repoId` filter
- `.env.example` updated with database config section

### Fixed
- **PostgreSQL usage insert crash** — `durationMs` (a float from `performance.now()`) was being inserted into an `INTEGER` column; now rounded with `Math.round()`
- **Migration regex for multiline SQL** — `schema_migrations` table regex changed from `[^)]+` to `[\s\S]*?` to match multiline `CREATE TABLE` statements

### Dependencies
- Added `pg` (production), `@types/pg` (dev)

---

## v1.6.0 — 2026-02-15

**LLM Usage Metrics, Human-in-the-Loop Feedback, Unified Server, and Permission Testing.** Adds full LLM observability (token usage, cost estimation, per-agent breakdown), a `/prompt` command for humans to give feedback on bot PRs via webhook, a unified `serve` command, and a `test-access` CLI command for verifying GitHub permissions.

### Added
- **LLM usage metrics** (`src/usage-types.ts`, `src/usage-pricing.ts`, `src/usage-repository.ts`, `src/usage-service.ts`) — in-memory token/cost/latency tracking per agent per process
  - Per-model pricing data for Anthropic (Claude Sonnet, Haiku, Opus) and OpenAI (GPT-4, GPT-4o, GPT-3.5-turbo)
  - `UsageRepository` with in-memory storage, filtering by processId/agent/provider/model, and summary aggregation
  - `UsageService` with `record()`, `summarize()`, `groupBy()` methods
  - REST API: `GET /api/usage/summary`, `GET /api/usage/records`, `GET /api/usage/by-agent`, `GET /api/usage/by-model`
  - **Usage tab** in web dashboard — summary cards, per-agent breakdown table, per-model breakdown table
  - SSE streaming of usage events to dashboard
  - Usage recording wired into `runArchitect()`, `runReviewSingle()`, and `createChatAgent()`
- **`/prompt` command** for human-in-the-loop PR feedback — when a human comments `/prompt <instructions>` on a bot-created PR, the webhook listener triggers the Architect's review→fix cycle with the human's feedback as context for the coder
  - `handlePrCommentEvent()` in `listener.ts` — parses `/prompt` from `issue_comment.created` events on PRs
  - Extracts issue number from PR body (`Closes #N`), validates bot ownership, then runs `runArchitect()` with `continueContext`
  - Dashboard process created for tracking
- **`test-access` CLI command** — quickly verifies GitHub API permissions without running the full pipeline
  - `deepagents test-access --issue N` — reads issue, posts a test comment, deletes it
  - `deepagents test-access --pr N` — reads PR metadata + diff, posts a test review, removes it
  - Supports `--issue N --pr N` for combined check
- **`serve` CLI command** — unified server combining dashboard + webhook + dialog on a single port
  - `deepagents serve --port 3000` replaces running separate `webhook`, `dashboard`, and `dialog` commands
  - Dialog routes mounted under `/dialog` and `/chat`
  - `PORT` env var as default
- **`extractTextContent()`** helper in `logger.ts` — extracts text from LLM array-style content blocks (handles both string and `{ type: 'text', text: '...' }` formats)
- **`logAgentDetail()`** in `logger.ts` — verbose agent I/O logging for debugging
- **Architect reasoning logs** — when no subagent is active, the Architect's own reasoning is logged for observability
- **`formatUsageSummaryComment()`** in `architect.ts` — formats a Markdown usage summary (tokens, cost, per-agent breakdown) for posting to GitHub issues
- **Dashboard process deduplication** — prevents duplicate processes for the same issue
- 73 new tests: usage-pricing (7), usage-repository (14), usage-service (10), dashboard usage API (8), listener /prompt (17), architect extractTaskInput (9), logger extractTextContent/logAgentDetail (8) — **481 tests total**

### Fixed
- **UNKNOWN agent name in streamEvents** — `extractTaskInput()` now tries 6 strategies to extract subagent type from LangGraph's various event formats (direct object, JSON string, nested args/input/tool_input, full stringify-regex fallback); includes diagnostic warning when all strategies fail
- **Webhook HMAC verification crash** (`ERR_INVALID_ARG_TYPE`) — `express.json()` global middleware was parsing the body before route-level `express.raw()` could preserve it as a Buffer; fixed by skipping JSON parsing for `/webhook` path

### Changed
- `runArchitect()` accepts `usageService` and `processId` options for usage tracking and summary comment posting
- CLI help text updated with `test-access` and `serve` commands
- `.env.example` updated with `PORT` env var

---

## v1.5.0 — 2026-02-13

**Parallel Subagent Support.** The Architect supervisor can now spawn concurrent subagents for independent tasks. When an issue has multiple independent sub-tasks, the Architect can delegate to multiple coders or reviewers in parallel instead of running them sequentially.

### Added
- **Parallel execution prompt section** in Architect system prompt — describes when and how to use parallel task delegation, with rules for branch naming and independence
- **`findAllPrsForIssue()`** in `src/core.ts` — discovers ALL matching PRs for an issue (not just the first)
- **`SubagentRun` interface** in `src/architect.ts` — tracks individual subagent executions by run ID
- **`prNumbers` field** on `ArchitectResult` — array of all PR numbers found (backward compat: `prNumber` still populated with first match)
- **`prNumbers` field** on `AgentProcess` — propagated from architect result
- **`activePhases` field** on `AgentProcess` — currently active subagent phases (supports duplicates for parallel same-type runs)
- **`runId` field** on `ProgressUpdate` — unique identifier for each subagent execution
- **Concurrent phase display** in dashboard — shows side-by-side chips with spinners when multiple phases are active simultaneously
- **Multi-PR display** in CLI (`analyze` and `continue` commands) and dashboard detail view
- 9 new tests: `findAllPrsForIssue` (3), parallel prompt (2), concurrent phase tracking (2), dashboard parallel fields (2) — **408 tests total**

### Changed
- `runArchitect()` event tracking refactored from single variables (`activeSubagent`, `activeStartTime`, `activeLabel`) to a `Map<string, SubagentRun>` keyed by `ev.run_id` — supports concurrent tool executions
- `runArchitect()` uses `findAllPrsForIssue()` for PR discovery at end of run
- `on_chat_model_end` usage tracking resolves agent role from active runs map (falls back to 'architect' when 0 or 2+ runs active)
- `ProcessManager.onProgress` tracks phases by run ID using a `Map<string, string>` instead of a Set
- Dashboard `PhaseTimeline` component accepts `activePhases` prop for concurrent display
- Dashboard `ProcessesTable` phase column shows multiple chips when concurrent
- Listener logs multiple PRs when present

---

## v1.4.0 — 2026-02-13

**Web Dashboard, Continue Command, and Coder Planning Phase.** Adds a visual web dashboard for managing agent processes, the ability to resume review/fix cycles on existing PRs, and a mandatory planning phase for the coder subagent.

### Added
- **Web dashboard** (`src/dashboard.ts`, `static/dashboard.html`) — React 18 + MUI 6 SPA at `localhost:3000` with dark theme
- Process table with status chips, phase indicators, live elapsed timers
- Detail view (side drawer or full-page) with phase timeline, live streaming logs, cancel button
- History panel reading from `last_poll.json`
- SSE `/api/events` endpoint for real-time process updates with heartbeat
- REST API: `/api/status`, `/api/processes`, `/api/processes/:id`, `/api/history`
- **ProcessManager** (`src/process-manager.ts`) — `EventEmitter`-based process lifecycle manager
- Console interception for log capture during process execution
- `AbortController` per process for cancellation
- Typed events: `process_started`, `process_updated`, `process_completed`, `process_failed`, `process_cancelled`, `process_log`
- **`continue` CLI command** — `deepagents continue --issue N --pr N --branch NAME`
- Resumes review→fix cycle on existing PR without re-running issuer/coder from scratch
- Dashboard "Continue" tab in new process dialog
- `POST /api/processes/continue` endpoint
- **Coder planning phase** — mandatory Phase 1 (read files, produce execution plan) before Phase 2 (execute)
- Plan included in issue comment and PR body
- Applies to both new issues and fix iterations
- **`logDiff()`** in `logger.ts` — ANSI-colored terminal diff output (green additions, red deletions, cyan file headers, yellow hunk headers) displayed automatically after the coder subagent completes
- `pnpm run dashboard` and `pnpm run continue` script shorthands
- 9 new tests for `logDiff` in `tests/logger.test.ts` (colors, truncation, edge cases)
- 18 tests in `tests/process-manager.test.ts`, 19 tests in `tests/dashboard.test.ts`

### Fixed
- **UNKNOWN agent name in pipeline logs** — `streamEvents` v2 may deliver tool input as a serialised JSON string instead of a parsed object; input parsing now handles both formats so logs show `ISSUER`, `CODER`, `REVIEWER` instead of `UNKNOWN`

### Changed
- `runArchitect()` accepts `onProgress`, `signal`, and `continueContext` options (backward-compatible)
- `runArchitect()` fetches and displays the PR diff after the coder subagent completes (extracted from tool output, `continueContext`, or `findPrForIssue` fallback)
- `runReviewSingle()` accepts `signal` option (backward-compatible)
- CLI: added `dashboard` and `continue` commands with `--port` and `--branch` flags
- Coder subagent system prompt restructured into Planning + Execution phases

---

## v1.3.0 — 2026-02-12

**Architect Supervisor — Multi-Agent Team with LLM-Driven Orchestration.** Replaces the deterministic pipeline (Triage → Analysis → Review → Fix loop) with a non-deterministic Architect agent that coordinates specialist subagents via LLM reasoning.

### Architecture

The Architect is a supervisor agent with three subagents:
- **Issuer** — understands issues (replaces triage agent). Read-only tools. Produces a natural language brief.
- **Coder** — implements changes (replaces analysis agent). Read + write tools. Creates branches, commits, PRs.
- **Reviewer** — reviews PRs. Reads diff, posts COMMENT review.

The Architect makes all orchestration decisions: who works next, what instructions to give, when to iterate, when to stop. This is non-deterministic — the LLM decides the workflow.

### Added
- **`src/architect.ts`** — supervisor agent with `createArchitect()`, `runArchitect()`, and subagent factories
- `createIssuerSubagent()` — 5 read-only tools for issue understanding
- `createCoderSubagent()` — 7 tools (read + write), respects dry-run mode
- `createReviewerSubagent()` — 4 tools (diff, read, review)
- `buildArchitectSystemPrompt()` — instructs the supervisor on workflow
- `getMaxIterations()` — configurable review→fix iteration limit
- `issuerLlm` config section (env vars: `ISSUER_LLM_*`, backward compat: `TRIAGE_LLM_*`)
- `coderLlm` config section (env vars: `CODER_LLM_*`)
- `MAX_ITERATIONS` env var (backward compat: `MAX_FEEDBACK_ITERATIONS`)
- 34 new tests in `tests/architect.test.ts`

### Changed
- `runPollCycle()` simplified: fetch → deduplicate → `runArchitect()` per issue (was: separate triage + analysis + message parsing phases)
- `deepagents analyze --issue N` now runs the full Architect pipeline (was: feedback loop)
- `deepagents analyze --issue N --dry-run` supported
- Webhook `issues.opened` handler calls `runArchitect()` instead of `runAnalyzeWithFeedbackLoop()`
- `buildReviewerSystemPrompt()` exported from `reviewer-agent.ts` (shared with Reviewer subagent)
- Poll state migration strips legacy `triageResults` field

### Removed
- `src/agent.ts` — absorbed into Coder subagent
- `src/triage-agent.ts` — absorbed into Issuer subagent
- `tests/triage-agent.test.ts` — replaced by `tests/architect.test.ts`
- `tests/feedback-loop.test.ts` — feedback loop no longer exists
- `deepagents triage` CLI command — triage is now internal to the Architect
- Deterministic orchestration functions: `runAnalyzeWithFeedbackLoop`, `buildUserMessage`, `buildAnalyzeMessage`, `buildFixMessage`, `extractProcessedIssues`, `extractIssueActions`, `runTriageSingle`, `fetchSingleIssue`

---

## v1.2.1 — 2026-02-10

**SSE streaming with thinking display and token usage (Issue #51).** The dialog UI now shows agent reasoning in real-time.

### Added
- **`chatStream()` async generator** in `chat-agent.ts` — streams `tool_start`, `tool_end`, `response`, `usage`, and `error` events via LangGraph `streamEvents()` API
- **Collapsible "Thinking" block** in dialog UI — shows each tool call name, args, and result as they happen
- **Token usage badge** — displays input/output/total token counts after each response
- **Pulsing status indicator** — shows what the agent is currently doing (e.g., "Calling list_repo_files...")
- 1 new test for tool call streaming events (267 total)

### Changed
- `/chat` endpoint switched from single JSON response to SSE (`text/event-stream`) format
- Dialog UI reads SSE stream via fetch + ReadableStream instead of awaiting JSON
- Thinking block auto-collapses after response arrives

---

## v1.2.0 — 2026-02-10

**Agent-human interactive dialog (Issues #48, #49).** Humans can now chat directly with the agent via a web UI or API endpoint.

### Added
- **Chat agent** (`src/chat-agent.ts`) — conversational agent using the same LLM and read-only GitHub tools, with LangGraph `MemorySaver` checkpointer for multi-turn conversation state
- **`/chat` POST endpoint** (Issue #48) — accepts `{ message, sessionId }`, returns agent response with conversation continuity per session
- **`dialog.html`** (Issue #49) — vanilla HTML/CSS/JS chat UI served at `GET /`, dark theme, auto-resizing input, session management
- **`createDialogApp()`** and **`startDialogServer()`** factories in `listener.ts`
- **`deepagents dialog`** CLI subcommand with `--port N` option (default: 3001)
- `pnpm dialog` script shorthand
- `@langchain/langgraph` added as direct dependency (was transitive via deepagents)
- 7 new tests in `tests/listener.test.ts`: health check, HTML serving, chat endpoint, validation, error handling

### Changed
- `listener.ts` imports `chat-agent.js` for the dialog endpoint
- CLI help text updated with `dialog` command and examples

---

## v1.1.0 — 2026-02-09

**Consolidate configuration into `.env` as single source of truth (Issue #47).**

During a real setup session, multiple pain points were discovered: secrets scattered across `config.json`, `.env`, and `Caddyfile`; unclear `triageLlm`/`reviewerLlm` shape; `privateKeyPath` confusion between host/container; Ollama `https` vs `http` gotcha. This release replaces `config.json` entirely with `.env` as the single source of truth.

### Added
- **Environment variable configuration** — `.env` is now the only config method
- `readLlmFromEnv()`, `parseIntEnv()`, `warnLocalhostHttps()` helper functions in `config.ts`
- Localhost-HTTPS detection: warns when `baseUrl` uses `https://localhost` or `https://127.0.0.1` (common Ollama gotcha)
- Comprehensive `.env.example` template covering all config sections
- Config tests rewritten: env-var-only, no config.json mocking

### Changed
- `loadConfig()` reads entirely from `process.env` — no JSON file reading
- Error messages reference env var names (e.g., "Set GITHUB_OWNER and GITHUB_REPO in .env")
- `Caddyfile.example` uses `{$DOMAIN}` env var — now committable with no secrets
- `docker-compose.yml`: `env_file: .env` on both services, mounts `Caddyfile.example` directly

### Removed
- `config.json` support — no longer read or referenced
- `config.json.example` — deleted from repository
- `config.json` and `Caddyfile` removed from `.gitignore`

---

## v1.0.0 — 2026-02-09

**Milestone: Phase 8 (Reviewer Bot) complete. Project v1.0.0!** The agent can now review its own PRs. Bot-created PRs are automatically reviewed via webhook, or manually via `deepagents review --pr N`.

### Added
- **PR review agent** (Issue #15) -- autonomous code reviewer for bot-created PRs
- New `src/reviewer-agent.ts` with `createReviewerAgent()` factory and `runReviewSingle()` entry point
- Reviewer reads PR diff, examines source files for context, and posts a structured review
- System prompt instructs: evaluate approach, find bugs/risks, suggest improvements, never approve/merge
- `reviewerLlm` optional config field for using a different model for reviews (like `triageLlm`)
- Circuit breaker (15 tool calls) and structured logging on all reviewer tools
- **`submit_pr_review` tool** (Issue #16) -- post a review on a GitHub pull request
- Event HARDCODED to `COMMENT` -- the tool can never approve or request changes, even if the LLM tries
- `<!-- deep-agent-review -->` HTML marker for idempotency (skips if bot already reviewed)
- Automated footer: "This is an automated review by deep-agents. A human should verify before merging."
- Inline comment support: `comments` array with `{ path, line, body }` for line-level feedback
- **`get_pr_diff` tool** -- fetch unified diff for a PR via Octokit (truncated at 50k chars)
- **`deepagents review --pr N`** CLI subcommand for manual PR review
- 12 new tests in `tests/reviewer-agent.test.ts`: diff tool, review tool, idempotency, COMMENT enforcement, inline comments

### Changed
- `handlePullRequestEvent()` now triggers the reviewer agent (was a stub logging "not implemented")
- `handlePullRequestEvent()` is now async and accepts optional `Config` parameter
- `handleWebhookEvent()` passes config to PR handler (enables review on webhook delivery)
- Removed `PrReviewStub` interface (replaced by the real reviewer agent)
- Updated `listener.test.ts` with reviewer mock and async test patterns (2 new tests: config trigger, error handling)

---

## v0.7.0 — 2026-02-09

**Milestone: Phase 7 (Deployment) complete.** Docker stack with Caddy reverse proxy. GitHub App authentication support alongside PAT.

### Added
- **Docker + Caddy deployment** (Issue #21) — containerized deployment with automatic HTTPS
- `Dockerfile`: Node 24-slim base, pnpm via corepack, healthcheck against GET /health
- `docker-compose.yml`: two-service stack (bot + Caddy reverse proxy) with health-gated startup
- `Caddyfile`: reverse proxy with automatic TLS via Let's Encrypt (placeholder domain)
- `.dockerignore`: excludes node_modules, .git, credentials, tests, and generated files
- README "Docker Deployment" section with step-by-step setup instructions
- **GitHub App authentication** (Issue #19) — migrate from PAT-only to support both PAT and GitHub App auth
- `createGitHubClient()` now accepts either a PAT string or `GitHubAppAuth` object
- `getAuthFromConfig()` helper extracts the correct auth mode from config
- `GitHubAppAuth` interface exported for programmatic use
- `@octokit/auth-app` added as production dependency
- `*.pem` added to `.gitignore`
- `config.json.example` updated with GitHub App field placeholders

### Changed
- Config validation: `github.token` is no longer required when App auth fields (`appId`, `privateKeyPath`, `installationId`) are provided
- Partial App config (e.g., `appId` without `privateKeyPath`) is rejected with a clear error
- Private key file existence is validated at config load time
- All call sites (`agent.ts`, `triage-agent.ts`, `core.ts`) updated to use `getAuthFromConfig()`
- 8 new tests: config validation (7) + GitHub App client creation (1)

---
## v0.6.0 — 2026-02-09

**Milestone: Phase 6 (Webhook & Real-Time) partially complete.** The webhook listener now dispatches `issues.opened` and `pull_request.opened` events. Issue #18 (persistent job queue) deferred — not needed for learning goals.

### Added
- **Handle `issues.opened` webhook event** (Issue #13) — triggers analysis pipeline on new issues
- `handleIssuesEvent()` extracts issue number, calls `runAnalyzeSingle()` for triage + analysis
- `createWebhookApp()` and `startWebhookServer()` accept optional full `Config` for analysis dispatch
- Fire-and-forget pattern: webhook responds 200 immediately, analysis runs async
- **Handle `pull_request.opened` webhook event** (Issue #14) — dispatches PR events from the webhook listener
- `handlePullRequestEvent()` extracts PR metadata (number, title, body, head/base ref, draft status)
- **Loop prevention**: `isBotPr()` checks for `<!-- deep-agent-pr -->` HTML marker in PR body OR `issue-N-*` branch naming pattern
- Bot-created PRs are logged as "queued for review" (stub — actual reviewer bot deferred to Issue #15)
- Non-bot PRs are ignored (logged and skipped)
- `handleWebhookEvent()` dispatcher routes events to the correct handler
- `PrReviewStub` interface exported for Issue #15 to wire into
- 23 new tests: handleIssuesEvent (6), isBotPr (5), handlePullRequestEvent (9), handleWebhookEvent dispatcher (3)

---

## v0.5.0 — 2026-02-08

**Milestone: Phase 5 (Resilience) complete.** Transient API failures are retried. Container stops don't lose work. Agent actions can be retracted by humans via CLI. Tool calls are logged with arguments and timing.

### Added
- **Retract command** (Issue #32) — `deepagents retract --issue N` undoes all agent actions on an issue
- `retractIssue()` function in `src/core.ts`: closes PR, deletes branch, deletes comment (in that order)
- Uses enriched metadata from v0.3.7 (#31) to find PR numbers, branch names, and comment IDs
- Partial retraction: if one step fails, the remaining steps still execute
- Skips actions with zero/empty IDs (safe for migrated old-format state)
- Poll state updated after retraction: issue cleared from `issues` map and `lastPollIssueNumbers`
- `deepagents retract --issue N` CLI subcommand with summary output
- `RetractResult` interface exported for programmatic use
- 7 new unit tests covering: full retraction, missing state, missing issue, partial retraction, error handling, migrated-format safety

---

## v0.4.0 — 2026-02-08

**Milestone: Phase 4 (Intelligence) complete.** Issues go through triage (cheap/fast) then deep analysis (thorough) with triage context passed through.

### Changed
- **Triage-to-analysis handoff** (Issue #4) — triage results are now passed to the analysis agent as context
- `buildUserMessage()` accepts optional `triageResults` parameter (5th argument)
- When triage context is available, the user message includes issue type, complexity, relevant files, and summary
- `PollState` gains optional `triageResults` field to persist triage data across runs
- `runPollCycle()` collects triage results and passes them to `buildUserMessage()`, also saves them in poll state
- System prompt in `agent.ts` updated to instruct the agent to use triage context (skip `list_repo_files` when triage already identified relevant files)
- 13 new tests for triage-to-analysis handoff in `tests/core.test.ts`

---

## v0.3.7 — 2026-02-08

### Changed
- **Enriched action tracking metadata** (Issue #31) — `IssueActions` now stores full API response metadata instead of simple booleans
- `comment` field: `{ id, html_url }` (was `commented: boolean`)
- `branch` field: `{ name, sha }` (was `branch: string | null`)
- `commits` field: `Array<{ path, sha, commit_sha }>` (new)
- `pr` field: `{ number, html_url }` (was `pr: number | null`)
- `extractIssueActions()` now correlates tool calls with responses using pending-state tracking
- `migratePollState()` handles 3 format generations: pre-v0.2.10, v0.2.10 boolean, v0.3.7+ enriched
- `buildUserMessage()` and `showStatus()` updated to use enriched field names
- 12 new enriched metadata tests + existing tests updated

---

## v0.3.6 — 2026-02-08

### Added
- **Graceful shutdown** (Issue #22) — SIGTERM/SIGINT handlers save poll state before exiting
- `requestShutdown()`, `isShuttingDown()`, `resetShutdown()` exported from `src/core.ts`
- Signal handlers registered in both `src/index.ts` and `src/cli.ts`
- Shutdown checks at three points in `runPollCycle()`: between triage iterations, after triage phase, before analysis phase
- 4 new unit tests in `tests/core.test.ts` (`describe('graceful shutdown', ...)`)

### Changed
- `process.exit(1)` replaced with `process.exitCode = 1` in entry point error handlers (allows pending I/O to flush)
- `process.exit(2)` replaced with `process.exitCode = 2` for circuit breaker exit (same rationale)

---

## v0.3.5 — 2026-02-08

### Added
- **HTTP webhook listener** (Issue #12) — Express server to receive GitHub webhook events
- New `src/listener.ts` with `createWebhookApp()` and `startWebhookServer()` factories
- POST `/webhook` endpoint with HMAC-SHA256 signature verification (`X-Hub-Signature-256`)
- GET `/health` health check endpoint
- Event type parsing from `X-GitHub-Event` header with delivery ID tracking
- `webhook` config section: `{ port, secret }` with validation in `config.ts`
- `deepagents webhook` CLI subcommand to start the listener
- `pnpm webhook` script shorthand
- 20 new unit tests (15 listener + 5 config) covering signature verification, endpoint behavior, config validation
- `express` added as production dependency, `@types/express` as dev dependency

### Changed
- `config.json.example` updated with `webhook` section placeholder

---

## v0.3.4 — 2026-02-08

### Added
- **Retry with exponential backoff** (Issue #17) — all GitHub API calls now retry on transient failures
- New `src/utils.ts` with `withRetry()` utility, `isRetryableError()` classifier, `getRetryAfterMs()` helper
- Retries on: HTTP 5xx, 429 (rate limit with Retry-After header), network errors (ECONNRESET, ETIMEDOUT, etc.)
- Does NOT retry 4xx client errors (except 429)
- Default: 3 retries with exponential backoff (1s, 2s, 4s)
- All Octokit API calls in `github-tools.ts` wrapped with `withRetry()`
- 18 new tests in `tests/utils.test.ts`

### Changed
- `tests/github-tools.test.ts` branch error test uses 403 (non-retryable) instead of 500

---

## v0.3.3 — 2026-02-08

### Added
- **Structured logging for tool calls** (Issue #33) — every tool invocation logs name, arguments, timing, and circuit breaker headroom
- New `src/logger.ts` with `wrapWithLogging()` composable wrapper function
- Log format: `[HH:MM:SS] TOOL #N/M | tool_name | { args } | Xms`
- Errors logged to stderr with context before re-throwing
- 9 new unit tests in `tests/logger.test.ts`

### Changed
- `src/agent.ts` applies logging wrapper as outermost layer on all 7 tools
- `src/triage-agent.ts` applies logging wrapper on all 3 read-only tools

---

## v0.3.2 — 2026-02-08

### Added
- **Triage agent** (Issue #3) — first phase of the two-phase agent pipeline
- New `src/triage-agent.ts` with `createTriageAgent()` factory, read-only tools only
- `TriageOutput` interface: issueType, complexity, relevantFiles, shouldAnalyze, skipReason, summary
- `parseTriageOutput()` parses LLM JSON response with validation and fallback
- `triageLlm` optional config field for using a cheaper model for triage
- `deepagents triage --issue N` CLI subcommand for standalone triage
- Triage pre-filter wired into `runPollCycle()` — issues are triaged before full analysis
- `fetchSingleIssue()` and `runTriageSingle()` exported from core for reuse
- 24 new unit tests (19 triage + 5 config) — total 113

### Changed
- `runPollCycle()` now fetches issues and runs triage before invoking the analysis agent
- `config.json.example` updated with `triageLlm` field placeholder

---

## v0.3.1 — 2026-02-08

### Added
- **`create_or_update_file` tool** (Issue #25) — commits files to branches via GitHub Contents API
- Agent can now push proposed code changes to feature branches, producing PRs with actual diffs
- Dry-run stub for the new tool
- Circuit breaker wraps the new tool
- **Self-review step** (Issue #27) — agent reads back committed files and sanity-checks before opening PR
- Agent workflow expanded from 5 to 7 steps: analyze → comment → document → branch → commit → self-review → PR

### Changed
- System prompt updated with code quality guidelines (soft, not hard constraints)
- Agent now produces PRs with real file changes instead of empty branches

---

## v0.3.0 — 2026-02-08

**Milestone: Phase 2 (Safety & Idempotency) + Phase 3 (CLI & Testing) complete.**

The bot is now safe for unattended operation. All write operations are idempotent, resource usage is bounded, and there's a CLI for development and debugging with 67 unit tests.

### Phase 2 — Safety & Idempotency (Issues #5, #6, #7, #8, #9, #10, #11)
- Max issues per run — code-enforced in tool constructor
- Duplicate comment prevention via HTML marker detection
- Duplicate branch prevention via getRef check
- Duplicate PR prevention via pulls.list check
- Circuit breaker — kills run after N tool calls
- True --dry-run mode — swaps write tools with logging stubs
- Per-issue action tracking in poll state with migration
- Cron lock file in poll.sh

### Phase 3 — CLI & Testing (Issues #23, #24)
- CLI wrapper with subcommands: poll, analyze, status, dry-run, help
- Core logic extracted to src/core.ts
- 67 unit tests across 4 files (vitest)

---

## v0.2.10 — 2026-02-08

### Added
- **Per-issue action tracking** (Issue #11) — poll state now records which workflow steps completed per issue
- `IssueActions` interface: `{ commented, branch, pr }` per issue number
- `extractIssueActions()` scans agent tool calls to build action records
- `migratePollState()` upgrades old poll state format (no `issues` field) to new format
- Agent message includes partially-processed issue status so it can resume incomplete work
- `deepagents status` now shows per-issue action breakdown

### Changed
- `PollState` interface adds optional `issues` field (backwards-compatible)
- `buildUserMessage()` accepts optional `issueActions` parameter
- `showStatus()` displays per-issue action details and maxToolCallsPerRun

## v0.2.9 — 2026-02-08

### Added
- **Circuit breaker** (Issue #6) — caps total tool calls per agent run to prevent runaway loops
- `maxToolCallsPerRun` config option (default: 30)
- `--max-tool-calls N` CLI flag to override at runtime
- `ToolCallCounter` class with shared counter across all tools
- `wrapWithCircuitBreaker()` utility wraps any LangChain tool with counting
- `CircuitBreakerError` custom error class with `callCount` and `callLimit` properties
- Agent saves poll state before exiting on circuit break (partially-processed issues are preserved)
- Process exits with code 2 when circuit breaker trips (distinguishable from normal errors)

## v0.2.8 — 2026-02-08

### Added
- **True dry-run mode** (Issue #7) — `--dry-run` flag skips all GitHub write operations
- Dry-run tool wrappers for `comment_on_issue`, `create_branch`, `create_pull_request`
- Write tools log what they WOULD do and return fake success (`{ dry_run: true }`)
- Read tools (`fetch_github_issues`, `list_repo_files`, `read_repo_file`) still execute normally
- Local file writes (`write_file` for `./issues/`) still execute normally
- Poll state is NOT saved in dry-run mode

### Changed
- `--no-save` and `--dry-run` are now separate flags (`--dry-run` implies `--no-save`)
- `runPollCycle` options split into `noSave` (skip state save) and `dryRun` (skip GitHub writes + state save)

## v0.2.7 — 2026-02-08

### Changed
- **Cron lock file** — `poll.sh` now uses `mkdir`-based lock to prevent overlapping cron runs
- **maxIssuesPerRun enforced in tool** — `fetch_github_issues` now clamps the `limit` parameter to `maxIssuesPerRun` at the code level, not just in the prompt

## v0.2.6 — 2026-02-08

### Added
- **Test infrastructure** (Issue #23) — vitest setup with unit tests for all modules
- `vitest` added as dev dependency with `vitest.config.ts`
- `pnpm test` runs all tests, `pnpm run test:watch` for watch mode
- 4 test files covering: `core.ts`, `github-tools.ts`, `model.ts`, `config.ts`
- Mock patterns: Octokit mock factory, `vi.mock` for LLM constructors, `fs` spies, `process.exit` interception
- Tests cover: idempotency logic (comment/branch/PR), config validation, provider routing, pure functions, file truncation

## v0.2.5 — 2026-02-08

### Added
- **CLI wrapper** (Issue #24) — proper subcommand interface for all agent operations
- New `src/cli.ts` entry point with subcommands: `poll`, `analyze`, `status`, `help`
- New `src/core.ts` extracts reusable functions from `index.ts` (shared by both entry points)
- `--dry-run` flag for poll command (no poll state written)
- `--max-issues N` flag to override config at runtime
- `--issue N` flag for single-issue analysis (`deepagents analyze --issue 42`)
- `dry-run` shorthand command (equivalent to `poll --dry-run`)
- `bin` field in package.json for CLI usage
- `pnpm run cli` script for development

### Changed
- `src/index.ts` is now a thin backwards-compatible wrapper that delegates to `core.ts`
- `maxIssuesPerRun` validated with type check and positivity guard (addresses Critic Finding #7)

## v0.2.4 — 2026-02-08

### Changed
- **Prevent duplicate PRs** (Issue #10) — `create_pull_request` is now idempotent
- Checks for existing open PR on the same head branch before creating
- Returns `{ skipped: true }` with existing PR URL if one already exists

## v0.2.3 — 2026-02-08

### Changed
- **Prevent duplicate branches** (Issue #9) — `create_branch` is now idempotent
- Checks if branch already exists before creating (uses `getRef` with 404 detection)
- Returns `{ skipped: true }` with branch URL if branch already exists

## v0.2.2 — 2026-02-08

### Changed
- **Prevent duplicate comments** (Issue #8) — `comment_on_issue` is now idempotent
- Checks for existing bot comment (hidden HTML marker) before posting
- Returns `{ skipped: true }` if analysis comment already exists
- Uses `<!-- deep-agent-analysis -->` marker pattern (standard in GitHub bots)

## v0.2.1 — 2026-02-08

### Added
- **Max issues per run** (Issue #5) — caps how many issues the agent processes per invocation
- `maxIssuesPerRun` config option in `config.json` (default: 5)
- Limit displayed at startup for operator visibility

### Changed
- User message to the agent now includes the issue limit explicitly

## v0.2.0 — 2026-02-08 — Phase 1 Complete: Code Awareness

**Milestone:** The agent can now read actual source code, not just issue descriptions. Analysis quality jumps from guessing to code-aware.

### Phase 1 Summary
- Two new read-only tools give the agent full codebase visibility
- `list_repo_files` traverses Git's object model (ref -> commit -> tree) to enumerate all files
- `read_repo_file` uses the Content API to fetch and decode individual file contents
- Together they enable the **browse-then-read** pattern: list files, identify relevant ones, read them
- See LEARNING_LOG Entries 9-11 for the full teaching narrative and Critic review

### Added (v0.1.2)
- **`list_repo_files` tool** (Issue #1) — lists all files in the repository with path and size info
- Path prefix filtering (e.g., `"src/"` to list only source files)
- Branch parameter for listing files on non-default branches
- Truncation warning when GitHub API truncates large repos

### Added (v0.1.3)
- **`read_repo_file` tool** (Issue #2) — reads a single file's contents from the repository
- Decodes base64 content from GitHub API to UTF-8 text
- Returns file path, size, SHA, and full content
- Files over 500 lines are truncated with metadata (prevents LLM context flooding)
- Handles edge cases: directories, symlinks, files over 1MB

### Changed
- System prompt updated to guide the agent to list and read relevant source files during analysis
- Agent now has 6 custom GitHub tools (was 4)

## v0.1.1 — 2026-02-08

### Added
- **Multi-provider LLM support** via new `src/model.ts` — supports Anthropic, OpenAI, Ollama, and any OpenAI-compatible API
- `baseUrl` config field for custom API endpoints (LM Studio, Together, Groq, etc.)
- Ollama shorthand provider — defaults to `localhost:11434/v1`
- API key validation skips local providers (ollama, openai-compatible)

### Changed
- Extracted model creation from `agent.ts` into dedicated `model.ts`
- Updated `config.json.example` with `baseUrl` field

## v0.1.0 — 2026-02-08

Initial release: cron-based GitHub issue poller with AI analysis.

### Features
- **Poll GitHub issues** via cron (`poll.sh`) with state tracking (`last_poll.json`)
- **Analyze issues** using a Deep Agent (LangChain + Anthropic Claude)
- **Comment on issues** with high-level findings summary
- **Write detailed analysis** to `./issues/issue_<number>.md`
- **Create feature branches** (`issue-<number>-<description>`)
- **Open draft PRs** linked to issues via `Closes #N`

### Tools
- `fetch_github_issues` — fetch open issues with `since` polling support
- `comment_on_issue` — post analysis comment on GitHub issue
- `create_branch` — create feature branch from default branch
- `create_pull_request` — open draft PR (never auto-merges)

### Documentation
- `LEARNING_LOG.md` — 7-entry learning narrative covering architecture, implementation, and review
- `README.md` — setup guide, testing instructions, troubleshooting
- `CLAUDE.md` — project objectives and conventions
