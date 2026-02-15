-- 001_initial_schema.sql
-- PostgreSQL persistence for Deep Agents: repos, poll state, issue actions,
-- agent processes, and LLM usage tracking.

-- ── repos ────────────────────────────────────────────────────────────────────
CREATE TABLE repos (
  id          SERIAL PRIMARY KEY,
  owner       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  config_json JSONB,
  UNIQUE(owner, repo)
);

-- ── poll_state ───────────────────────────────────────────────────────────────
CREATE TABLE poll_state (
  id                      SERIAL PRIMARY KEY,
  repo_id                 INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  last_poll_timestamp     TIMESTAMPTZ NOT NULL,
  last_poll_issue_numbers INTEGER[] NOT NULL DEFAULT '{}',
  UNIQUE(repo_id)
);

-- ── issue_actions ────────────────────────────────────────────────────────────
CREATE TABLE issue_actions (
  id           SERIAL PRIMARY KEY,
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  comment_id   INTEGER,
  comment_url  TEXT,
  branch_name  TEXT,
  branch_sha   TEXT,
  commits      JSONB NOT NULL DEFAULT '[]',
  pr_number    INTEGER,
  pr_url       TEXT,
  UNIQUE(repo_id, issue_number)
);

-- ── agent_processes ──────────────────────────────────────────────────────────
CREATE TABLE agent_processes (
  id             TEXT PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('analyze', 'review')),
  status         TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  issue_number   INTEGER,
  pr_number      INTEGER,
  pr_numbers     INTEGER[],
  started_at     TIMESTAMPTZ NOT NULL,
  completed_at   TIMESTAMPTZ,
  current_phase  TEXT,
  active_phases  TEXT[],
  iteration      INTEGER,
  max_iterations INTEGER,
  outcome        TEXT,
  error          TEXT,
  logs           JSONB NOT NULL DEFAULT '[]'
);

-- ── llm_usage ────────────────────────────────────────────────────────────────
CREATE TABLE llm_usage (
  id             TEXT PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  timestamp      TIMESTAMPTZ NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  agent          TEXT NOT NULL,
  process_id     TEXT REFERENCES agent_processes(id) ON DELETE SET NULL,
  issue_number   INTEGER,
  pr_number      INTEGER,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  total_tokens   INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  estimated_cost NUMERIC(12, 6) NOT NULL
);

-- ── schema_migrations ────────────────────────────────────────────────────────
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_poll_state_repo_id ON poll_state(repo_id);
CREATE INDEX idx_issue_actions_repo_id ON issue_actions(repo_id);
CREATE INDEX idx_agent_processes_repo_id ON agent_processes(repo_id);
CREATE INDEX idx_agent_processes_status ON agent_processes(status);
CREATE INDEX idx_llm_usage_repo_id ON llm_usage(repo_id);
CREATE INDEX idx_llm_usage_timestamp ON llm_usage(timestamp);
CREATE INDEX idx_llm_usage_agent ON llm_usage(agent);
CREATE INDEX idx_llm_usage_model ON llm_usage(model);
CREATE INDEX idx_llm_usage_process_id ON llm_usage(process_id);
