# Deep Agents GitHub Issue Poller

A learning project for understanding Deep Agents / LangGraph patterns. An AI agent polls a GitHub repo for open issues, analyzes them, comments findings, writes detailed analysis files, and opens draft PRs.

## What It Does

```
                    ┌─────────────────────────┐
                    │       ARCHITECT          │
                    │   (Supervisor Agent)     │
                    │                          │
                    │  LLM decides:            │
                    │  - Who works next        │
                    │  - What instructions     │
                    │  - When to iterate       │
                    │  - When to stop          │
                    └──────┬──────┬──────┬─────┘
                           │      │      │
              task("issuer") task("coder") task("reviewer")
                           │      │      │
                    ┌──────┴──┐ ┌─┴────┐ ┌┴─────────┐
                    │ ISSUER  │ │CODER │ │REVIEWER  │
                    │         │ │      │ │          │
                    │Read-only│ │Read+ │ │Diff+     │
                    │tools    │ │Write │ │Review    │
                    └─────────┘ └──────┘ └──────────┘
```

**Two modes:**
- **Multi-agent** (default, `AGENT_MODE=multi`): Architect supervisor delegates to 3 specialist subagents
- **Single-agent** (`AGENT_MODE=single`): One agent handles everything in a single context window with automatic context compaction

When an issue is opened, the **Architect** supervisor coordinates three specialist subagents:
1. **Issuer** — explores the repo and produces a brief (issue type, complexity, relevant files, approach)
2. **Coder** — comments on issue, creates branch, commits files, opens draft PR
3. **Reviewer** — fetches PR diff, reads source for context, posts review (COMMENT only)

All agents share a persistent **issue context** (like a Jira ticket) — each agent reads from and writes to it, so the Coder sees the Issuer's raw brief, the Reviewer sees the Coder's plan, and past issues can be searched for cross-run learning.

The Architect makes all orchestration decisions via LLM reasoning — non-deterministic workflow. It can skip steps, reorder, or iterate (reviewer finds issues → coder fixes → re-review).

The agent never merges PRs. It only proposes fixes as drafts. The reviewer agent posts a COMMENT review -- it never approves or requests changes.

Trigger via webhook (real-time) or poll (cron):
```
GitHub  --webhook-->  deepagents webhook  -->  issues.opened  --> Architect
                                          -->  pull_request.opened --> Reviewer Agent
```

## Prerequisites

**Required:**

- Node.js 24+
- [pnpm](https://pnpm.io/) package manager
- A GitHub account with either a [Personal Access Token](https://github.com/settings/tokens) or a [GitHub App](#github-app) (see below)
- An LLM API key (e.g. [Anthropic](https://console.anthropic.com), OpenAI, or a local model via Ollama)

**Optional:**

- [PostgreSQL](https://www.postgresql.org/) 15+ (for persistent storage — without it, the system uses file/in-memory storage)
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (for containerized deployment — includes PostgreSQL automatically)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jaaacki/learning-deep-agents.git
cd learning-deep-agents
pnpm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` with your credentials. The file is self-documented with all available settings:

```bash
# Required
GITHUB_OWNER=your-github-username
GITHUB_REPO=your-repo-name
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-xxx
LLM_MODEL=claude-sonnet-4-20250514

# Optional: cheaper model for issue understanding (omit to use main LLM)
# ISSUER_LLM_PROVIDER=anthropic
# ISSUER_LLM_API_KEY=sk-ant-xxx
# ISSUER_LLM_MODEL=claude-haiku-4-5-20251001

# Optional: different model for code implementation
# CODER_LLM_PROVIDER=anthropic
# CODER_LLM_API_KEY=sk-ant-xxx
# CODER_LLM_MODEL=claude-sonnet-4-20250514

# Optional: different model for PR reviews
# REVIEWER_LLM_PROVIDER=anthropic
# REVIEWER_LLM_API_KEY=sk-ant-xxx
# REVIEWER_LLM_MODEL=claude-haiku-4-5-20251001

# Optional: webhook listener
# WEBHOOK_PORT=3000
# WEBHOOK_SECRET=your-secret   # generate with: openssl rand -hex 32
```

See `.env.example` for the full list including GitHub App auth, database, limits, and Docker/Caddy settings.

**Notes:**
- `ISSUER_LLM_*` / `CODER_LLM_*` / `REVIEWER_LLM_*` are optional — omit them to use the main LLM for everything. Set `_PROVIDER` to enable. Legacy `TRIAGE_LLM_*` env vars are also accepted for backward compat.
- `MAX_ISSUES_PER_RUN` caps how many issues the agent processes per invocation. Lower this for busy repos or higher LLM costs.
- `MAX_TOOL_CALLS_PER_RUN` is a circuit breaker that caps total tool calls per run. If the agent enters a loop, this stops it from burning unlimited API credits.

#### Other LLM providers

```bash
# OpenAI
LLM_PROVIDER=openai  LLM_API_KEY=sk-...  LLM_MODEL=gpt-4

# Ollama (local) — note: use http://, not https://
LLM_PROVIDER=ollama  LLM_MODEL=llama3

# OpenAI-compatible (LM Studio, Together, Groq, etc.)
LLM_PROVIDER=openai-compatible  LLM_API_KEY=key-or-empty  LLM_MODEL=my-model  LLM_BASE_URL=http://localhost:1234/v1
```

**Tip:** Point it at a repo you own that has a few open issues. If you don't have one, create a test repo with 2-3 dummy issues.

### 3. GitHub Authentication

You need **one** of the two methods below. A Personal Access Token is simpler for local use; a GitHub App is better for production and Docker deployments.

#### Personal Access Token (PAT)

1. Go to **GitHub.com** → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. Click **Generate new token (classic)**
3. Select the **`repo`** scope (full control of private repositories)
4. Click **Generate token** and copy it immediately (you won't see it again)
5. Paste the token into `.env` → `GITHUB_TOKEN`

```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

#### GitHub App

A GitHub App uses short-lived installation tokens and doesn't tie permissions to your personal account.

1. Go to **GitHub.com** → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
2. Fill in the required fields:
   - **App name**: e.g. `deep-agents-bot`
   - **Homepage URL**: your repo URL or any URL
   - **Webhook**: deactivate the checkbox (unless you want webhook delivery to this app)
3. Set **permissions**:
   - **Issues**: Read & Write
   - **Pull requests**: Read & Write
   - **Contents**: Read & Write
4. Click **Create GitHub App**
5. On the App's **General** page, note the **App ID** (a number near the top)
6. Scroll to **Private keys** → click **Generate a private key**
   - Save the `.pem` file somewhere safe outside the repo (e.g. `~/.config/deep-agents/app.pem`)
   - **Never commit this file**
7. Click **Install App** (left sidebar) → install it on the repo you want the bot to manage
8. After installation, the URL will look like `https://github.com/settings/installations/12345678` — the number at the end is your **Installation ID**
9. Fill in `.env` (comment out `GITHUB_TOKEN` if set):

```bash
# GITHUB_TOKEN=          # comment out PAT when using App auth
GITHUB_APP_ID=123456
GITHUB_APP_PEM_PATH=/home/you/.config/deep-agents/app.pem
GITHUB_APP_INSTALLATION_ID=12345678
```

### 4. Database setup (optional)

By default, the system uses `last_poll.json` for poll state and in-memory storage for usage metrics and process history — all lost on restart. For persistent storage, configure PostgreSQL:

**Option A: Connection URL (recommended for Docker/production)**

```bash
DATABASE_URL=postgresql://deepagents:password@localhost:5432/deepagents
```

**Option B: Individual fields (for local dev)**

```bash
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=deepagents
PG_USER=deepagents
PG_PASSWORD=password
```

Run migrations to create the schema:

```bash
pnpm migrate
```

When using Docker Compose, PostgreSQL is included automatically — no manual setup needed.

If no database config is set, the system falls back to file/in-memory storage (existing behavior, zero setup required).

### 5. Test a single run

```bash
pnpm start
```

You should see output like:

```
🤖 Deep Agents GitHub Issue Poller

✅ Config loaded: your-username/your-repo

🆕 First poll run -- no previous state found.

⚙️  Creating Deep Agent...
✅ Agent ready!

🚀 Running agent to analyze GitHub issues...

============================================================
📥 Fetching open issues from your-username/your-repo...
📂 Listing files in your-username/your-repo...
📖 Reading src/index.ts from your-username/your-repo (main)...
💬 Commenting on issue #1 in your-username/your-repo...
🌿 Creating branch 'issue-1-fix-something' from 'main'...
📝 Creating draft PR 'Fix #1: Fix something' in your-username/your-repo...
============================================================

✅ Agent completed!

💾 Poll state saved to /path/to/last_poll.json
   Processed issues: 1
```

After the run, check:
- **GitHub issue** — should have a new comment with the agent's analysis
- **`./issues/`** folder — should have `issue_1.md` with detailed findings
- **GitHub PRs** — should have a new draft PR titled "Fix #1: ..."
- **`last_poll.json`** — should exist with the timestamp and processed issue numbers

### 6. Test a second run (polling)

Run `pnpm start` again. This time the agent should skip already-processed issues:

```
📅 Last poll: 2026-02-08T07:30:00.000Z
📋 Previously processed issues: 1

🆕 No new issues to process.
```

## Running Modes

Choose the mode that fits your use case:

| Mode | Best for | How it works |
|------|----------|--------------|
| **Cron polling** | Simple, low-volume repos | Cron job runs `poll.sh` on a schedule |
| **Unified server** | Local dev / staging | `deepagents serve` runs dashboard + webhook + dialog on one port |
| **Webhook (local)** | Development / testing | `pnpm webhook` listens for GitHub events |
| **Dialog** | Interactive chat | `pnpm dialog` opens a web UI for human-agent conversation |
| **Docker + Caddy** | Production deployment | Containerized webhook listener with auto-HTTPS |

### Cron polling

Make `poll.sh` executable and edit the PATH line for your system:

```bash
chmod +x poll.sh
```

Open `poll.sh` and uncomment the right PATH line:
- Intel Mac: `export PATH="/usr/local/bin:$PATH"`
- Apple Silicon: `export PATH="/opt/homebrew/bin:$PATH"`
- nvm users: uncomment the nvm line

Test it:

```bash
./poll.sh
cat poll.log
```

Then add to crontab:

```bash
crontab -e
```

Add this line (polls every 15 minutes):

```
*/15 * * * * /Users/your-name/Dev/learning-deep-agents/poll.sh
```

### Webhook listener (local)

The webhook listener receives GitHub events in real-time instead of polling on a schedule. It processes `issues.opened` and `pull_request.opened` events.

**Prerequisites:** `WEBHOOK_PORT` and `WEBHOOK_SECRET` must be set in `.env` (see [config above](#2-configure-credentials)).

Generate a strong webhook secret:

```bash
openssl rand -hex 32
```

Paste the output into both:
1. `.env` → `WEBHOOK_SECRET`
2. Your GitHub repo's webhook settings (Settings → Webhooks → Add webhook):
   - **Payload URL:** `http://your-server:3000/webhook` (or use a tunnel like ngrok for local dev)
   - **Content type:** `application/json`
   - **Secret:** the value from `openssl rand -hex 32`
   - **Events:** select "Issues" and "Pull requests"

Start the listener:

```bash
pnpm webhook
```

The server exposes two endpoints:
- `POST /webhook` — receives GitHub events (verified with HMAC-SHA256)
- `GET /health` — returns `{ "status": "ok" }`

### Interactive dialog (chat)

Chat directly with the agent via a web UI. The agent has read-only access to the repository — it can browse files, list issues, and answer questions about the codebase.

```bash
pnpm dialog
```

Open http://localhost:3001/ in your browser. The chat UI supports multi-turn conversations with session state.

To use a different port:

```bash
pnpm run cli dialog --port 8080
```

The dialog server exposes three endpoints:
- `GET /` — serves the chat UI (`dialog.html`)
- `POST /chat` — accepts `{ message, sessionId }`, returns `{ response, sessionId }`
- `GET /health` — returns `{ "status": "ok" }`

### Docker deployment

Run the webhook listener in Docker. Two options: **local testing** (bot only) or **production** (bot + Caddy with automatic HTTPS).

#### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- `.env` with valid credentials including `WEBHOOK_PORT` and `WEBHOOK_SECRET`

#### Create runtime files

The bot needs `issues/` to exist before mounting:

```bash
mkdir -p issues
```

#### Option A: Local testing (bot + postgres)

Run the bot and postgres containers without Caddy — useful for testing or development:

```bash
docker compose up -d --build bot postgres
```

Verify it's working:

```bash
# Check container is healthy
docker compose ps

# View logs
docker compose logs -f bot

# Test health endpoint (from inside the container, since port 3000 is internal)
docker exec deepagents-bot node -e "fetch('http://localhost:3000/health').then(r=>r.json()).then(console.log)"
```

You should see:

```
{ status: 'ok', timestamp: '2026-02-09T...' }
```

#### Option B: Production (bot + Caddy with HTTPS)

For production, Caddy provides automatic TLS via Let's Encrypt using the Cloudflare DNS challenge. This means your server doesn't need port 80 open — Caddy proves domain ownership by creating a temporary DNS record via the Cloudflare API.

**Additional prerequisites:**
- A domain name with DNS managed by Cloudflare
- A Cloudflare API Token with **Zone / Zone / Read** and **Zone / DNS / Edit** permissions

**1. Create a Cloudflare API Token**

1. Go to [Cloudflare dashboard](https://dash.cloudflare.com) → your domain → **Overview** (note the Zone ID)
2. Go to **My Profile** → **API Tokens** → **Create Token**
3. Use the **Edit zone DNS** template, or create a custom token with:
   - **Zone / Zone / Read**
   - **Zone / DNS / Edit**
   - Scope it to your specific zone (domain)
4. Copy the token

**2. Configure your domain**

Set the `DOMAIN` variable in your `.env`:

```bash
DOMAIN=yourdomain.com
```

The `Caddyfile` uses `{$DOMAIN}` and is mounted directly by Docker Compose — no need to copy or edit it.

**3. Set the Cloudflare token**

Also in `.env`:

```bash
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
```

**4. Build and start**

```bash
docker compose up -d --build
```

The first build takes a bit longer as it compiles a custom Caddy binary with the Cloudflare DNS plugin.

This starts three containers:
- **postgres** -- PostgreSQL 17 database for persistent storage (poll state, usage metrics, process history)
- **bot** -- the webhook listener on port 3000 (internal only), auto-migrates database on startup
- **caddy** -- reverse proxy on ports 80/443 with automatic TLS via Cloudflare DNS challenge

**5. Verify**

```bash
# Check container health
docker compose ps

# View bot logs
docker compose logs -f bot

# Test health endpoint
curl https://yourdomain.com/health
```

**6. Point GitHub webhook**

In your GitHub repo settings, add a webhook:
- **Payload URL:** `https://yourdomain.com/webhook`
- **Content type:** `application/json`
- **Secret:** same value as `WEBHOOK_SECRET` in your `.env`
- **Events:** select "Issues" and "Pull requests"

#### Stopping

```bash
docker compose down
```

Caddy's TLS certificates persist in the `caddy_data` volume across restarts.

## CLI Reference

The project provides a CLI with subcommands:

```bash
# Run database migrations (requires DATABASE_URL or PG_* env vars)
pnpm migrate

# Run a poll cycle (fetch + analyze + comment + branch + PR)
pnpm run cli poll

# Dry run: skip GitHub writes (comments, branches, PRs) -- safe for testing
pnpm run cli poll --dry-run

# No-save: run normally but don't persist poll state
pnpm run cli poll --no-save

# Override max issues from config
pnpm run cli poll --max-issues 3

# Analyze a single issue (Architect: understand, implement, review)
pnpm run cli analyze --issue 42
pnpm run cli analyze --issue 42 --dry-run

# Review a pull request (fetch diff, analyze, post review comment)
pnpm run cli review --pr 10

# Retract all agent actions on an issue (close PR, delete branch, delete comment)
pnpm run cli retract --issue 42

# Start webhook listener (real-time, replaces cron)
pnpm run cli webhook

# Start the interactive dialog (chat with the agent)
pnpm run cli dialog
pnpm run cli dialog --port 8080

# Show current polling state
pnpm run cli status

# Start unified server (dashboard + webhook + dialog on one port)
pnpm run cli serve
pnpm run cli serve --port 8080

# Quick permission check (posts + deletes a test comment/review)
pnpm run cli test-access --issue 1
pnpm run cli test-access --pr 10
pnpm run cli test-access --issue 1 --pr 10

# Show help
pnpm run cli help
```

The original `pnpm start` still works and runs a single poll cycle.

## Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode (re-runs on file changes)
pnpm run test:watch
```

702 tests across 22 test files using [vitest](https://vitest.dev/) with mocked external dependencies (Octokit, LLM constructors, filesystem). No real API calls are made during testing.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing required config` | Set `GITHUB_OWNER` and `GITHUB_REPO` in `.env` |
| `Missing LLM_API_KEY` | Set `LLM_API_KEY` in `.env` (required for cloud providers, not needed for Ollama) |
| `Error fetching issues: HttpError` | Check your GitHub token has `repo` scope |
| `Error creating branch: Not Found` | Make sure the repo has a `main` branch (not `master`) |
| `Error creating pull request: Validation Failed` | Branch might already exist from a previous run |
| Agent doesn't comment/create PR | Check console output for API errors; token might lack permissions |
| `poll.sh: pnpm: command not found` | Uncomment the correct PATH line in `poll.sh` |
| `Incomplete GitHub App config` | All three required: `GITHUB_APP_ID`, `GITHUB_APP_PEM_PATH`, `GITHUB_APP_INSTALLATION_ID` |
| `GitHub App private key file not found` | Check `GITHUB_APP_PEM_PATH` points to a valid `.pem` file |
| Webhook returns 401 / signature mismatch | Ensure `WEBHOOK_SECRET` in `.env` matches the secret in GitHub webhook settings exactly |
| Webhook not firing | In GitHub repo → Settings → Webhooks, check that "Issues" and "Pull requests" events are selected |
| `EADDRINUSE` when starting webhook | Another process is using the port; change `WEBHOOK_PORT` in `.env` or stop the other process |
| `HTTPS for localhost` warning | You have `https://localhost` as a baseUrl — Ollama and local models use `http://`, not `https://` |
| `Database pool not initialized` | Set `DATABASE_URL` or `PG_HOST` in `.env` (or remove database config to use file/in-memory fallback) |
| Migration fails | Ensure PostgreSQL is running and the connection credentials are correct |
| Caddy fails to get TLS cert | Check `CLOUDFLARE_API_TOKEN` is set in `.env` and the token has Zone/DNS permissions |

## File Structure

```
learning-deep-agents/
  src/
    cli.ts            -- CLI entry point (subcommands: poll, analyze, review, webhook, dialog, serve, migrate, test-access, status)
    core.ts           -- Shared logic (poll cycle, state management, graceful shutdown)
    architect.ts      -- Architect supervisor agent with Issuer, Coder, Reviewer subagents
    context-pruning.ts -- Iteration pruning middleware (compresses old review-fix cycle messages)
    context-compaction.ts -- Context compaction middleware (truncates old messages when context exceeds threshold)
    single-agent.ts   -- Single-agent mode (one agent, all tools, full lifecycle in one context window)
    local-tools.ts    -- Local filesystem tools (read, list, grep, edit, write, bash) for workspace clones
    workspace.ts      -- Workspace lifecycle (clone repo, configure git, cleanup)
    index.ts          -- Original entry point (thin wrapper, backwards-compatible)
    config.ts         -- Loads config from .env (GitHub + LLM + webhook + database)
    model.ts          -- LLM provider factory (Anthropic, OpenAI, Ollama, etc.)
    github-tools.ts   -- GitHub API tools (fetch, list files, comment, branch, PR, commit, review)
    reviewer-agent.ts -- Standalone PR reviewer agent (diff reader, source context, review submitter)
    tool-cache.ts     -- Shared file cache (ToolCache, wrapWithCache, wrapWriteWithInvalidation)
    logger.ts         -- Structured logging (tool calls, agent events, colored diff output)
    utils.ts          -- Retry with exponential backoff for API calls
    chat-agent.ts     -- Chat agent for human-agent interaction (read-only tools + checkpointer)
    listener.ts       -- Express webhook server, dialog server, /prompt handler, HMAC-SHA256 verification
    process-manager.ts -- EventEmitter-based agent process lifecycle manager (per-process repo override)
    dashboard.ts      -- Express server for web dashboard (REST API + SSE + repo CRUD + unified serve mode)
    usage-types.ts    -- TypeScript interfaces for LLM usage tracking (LLMUsageRecord, AgentRole, etc.)
    usage-pricing.ts  -- Per-model token pricing data (Anthropic + OpenAI models)
    usage-repository.ts -- In-memory usage record storage with filtering and aggregation
    usage-service.ts  -- Usage recording, summarization, and groupBy service layer
    poll-repository.ts    -- PollRepository interface + FilePollRepository (file-based fallback)
    process-repository.ts -- ProcessRepository interface + InMemoryProcessRepository (in-memory fallback)
    repo-repository.ts    -- RepoRepository interface (CRUD) + StaticRepoRepository (env-var fallback)
    db/
      connection.ts       -- PostgreSQL pool singleton (from DATABASE_URL or PG_* env vars)
      migrate.ts          -- Migration runner (reads SQL files, applies in transactions)
      repositories.ts     -- Factory: createRepositories(config) returns PG or file/in-memory repos
      pg-repo-repository.ts    -- PostgresRepoRepository (manages repos table)
      pg-poll-repository.ts    -- PostgresPollRepository (poll_state + issue_actions)
      pg-usage-repository.ts   -- PostgresUsageRepository (llm_usage CRUD + aggregations)
      pg-process-repository.ts -- PostgresProcessRepository (agent_processes persistence)
      migrations/
        001_initial_schema.sql -- Full schema: repos, poll_state, issue_actions, agent_processes, llm_usage
  tests/
    architect.test.ts -- Architect supervisor, subagent factories, extractTaskInput, system prompt tests
    single-agent.test.ts -- Single-agent system prompt, tool assembly, dry-run, context tool tests
    context-pruning.test.ts -- Iteration pruning middleware tests (boundary detection, compression, edge cases)
    context-compaction.test.ts -- Context compaction middleware tests (threshold, truncation, preservation, idempotency)
    local-tools.test.ts -- Local filesystem tool tests (read, list, grep, edit, write, bash)
    workspace.test.ts -- Workspace cloning and cleanup tests
    tool-cache.test.ts -- ToolCache, wrapWithCache, wrapWriteWithInvalidation, cache+circuit breaker integration
    core.test.ts      -- Unit tests for core logic, state, graceful shutdown
    github-tools.test.ts -- Idempotency and tool tests (mocked Octokit)
    model.test.ts     -- Provider routing tests (mocked LLM constructors)
    config.test.ts    -- Config validation tests (mocked fs, process.exit)
    reviewer-agent.test.ts -- PR review tool and diff tool tests
    logger.test.ts    -- Structured logging, extractTextContent, logAgentDetail tests
    utils.test.ts     -- Retry logic and error classification tests
    listener.test.ts  -- Webhook endpoint, signature verification, /prompt handler tests
    process-manager.test.ts -- Process lifecycle, log capture, cancellation tests
    dashboard.test.ts -- Dashboard REST API, SSE, and usage endpoint tests
    usage-pricing.test.ts -- Per-model pricing lookup tests
    usage-repository.test.ts -- In-memory storage, filtering, summary aggregation tests
    usage-service.test.ts -- Usage recording, summarization, groupBy tests
  issues/             -- Generated: detailed analysis files
  static/
    dialog.html       -- Chat UI for testing agent-human interaction
    dashboard.html    -- React + MUI dashboard SPA for managing agent processes
  .env                -- Your credentials and settings (git-ignored, single source of truth)
  .env.example        -- Comprehensive template for .env
  last_poll.json      -- Generated: polling state (git-ignored, not needed with database)
  poll.sh             -- Cron wrapper script
  poll.log            -- Generated: cron run logs (git-ignored)
  LEARNING_LOG.md     -- Project learning narrative
  CLAUDE.md           -- Claude Code project instructions
  Dockerfile          -- Container image definition (bot)
  Dockerfile.caddy    -- Custom Caddy build with Cloudflare DNS plugin
  docker-compose.yml  -- Bot + PostgreSQL + Caddy reverse proxy stack
  Caddyfile   -- Caddy config (committable — uses {$DOMAIN} env var)
  .dockerignore       -- Files excluded from Docker build context
```

## How to Reset

To re-analyze all issues from scratch:

```bash
# File-based mode:
rm last_poll.json
pnpm start

# Database mode:
# Truncate the poll_state and issue_actions tables, then restart
```

To clean up generated files:

```bash
rm -rf issues/ last_poll.json poll.log
```

## Learning More

Read `LEARNING_LOG.md` for a step-by-step narrative of how this project was designed and built, including:
- Why each technology was chosen
- How tools work (schema + description + implementation)
- The ReAct agent loop explained
- Architecture decisions and trade-offs
- Edge cases and what could go wrong
