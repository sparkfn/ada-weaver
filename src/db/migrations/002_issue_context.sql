-- 002_issue_context.sql
-- Shared memory for agents: stores context entries that all agents can
-- read/write during a pipeline run, plus cross-run learning from past issues.

CREATE TABLE IF NOT EXISTS issue_context (
  id            SERIAL PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_number  INTEGER NOT NULL,
  process_id    TEXT REFERENCES agent_processes(id) ON DELETE SET NULL,
  entry_type    TEXT NOT NULL CHECK (entry_type IN (
    'issuer_brief','architect_plan','coder_plan','review_feedback','ci_result','outcome'
  )),
  agent         TEXT NOT NULL,
  content       TEXT NOT NULL,
  files_touched TEXT[] NOT NULL DEFAULT '{}',
  iteration     INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_issue_context_process    ON issue_context(process_id);
CREATE INDEX idx_issue_context_repo_issue ON issue_context(repo_id, issue_number);
CREATE INDEX idx_issue_context_files      ON issue_context USING GIN(files_touched);
CREATE INDEX idx_issue_context_entry_type ON issue_context(repo_id, entry_type);
