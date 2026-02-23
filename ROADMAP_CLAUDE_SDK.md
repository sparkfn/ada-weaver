# Roadmap — Claude Agent SDK Integration

A phased plan for adding the Claude Agent SDK as a third execution mode (`claude-sdk`) alongside the existing `multi` and `single` modes.

---

## Vision

A new `AGENT_MODE=claude-sdk` that leverages Anthropic's official Agent SDK — the same engine that powers Claude Code — for autonomous issue analysis, code generation, and PR review. Users select the engine from the dashboard and the system routes to the right execution path. Existing modes remain untouched.

---

## Important: Provider Compatibility

The Claude Agent SDK **only supports Claude models** (via Anthropic API, AWS Bedrock, Google Vertex AI, or Azure AI Foundry). It cannot use Ollama or OpenAI.

The three-mode architecture gives full flexibility:

| Mode | Providers | Best for |
|------|-----------|----------|
| `multi` | Any (Anthropic, OpenAI, Ollama, etc.) | Multi-agent orchestration with any LLM |
| `single` | Any | Lightweight single-agent with any LLM |
| `claude-sdk` | Claude only (Anthropic/Bedrock/Vertex/Azure) | Premium Claude experience with built-in tools |

For Ollama users, the existing `multi` and `single` modes continue to work. The dashboard will show/hide the `claude-sdk` option based on whether a valid Claude provider is configured.

---

## Phase 1 — Foundation & Config

> Install the SDK, extend config, and add the mode routing.

- [ ] Install `@anthropic-ai/claude-agent-sdk` as a dependency
- [ ] Extend `AGENT_MODE` type in `config.ts` to accept `'multi' | 'single' | 'claude-sdk'`
- [ ] Add SDK-specific env vars to `.env.example`:
  - `CLAUDE_SDK_PERMISSION_MODE` (`acceptEdits` | `bypassPermissions`)
  - `CLAUDE_SDK_MAX_TURNS` (circuit breaker equivalent)
  - `CLAUDE_SDK_MAX_BUDGET_USD` (cost cap per run)
  - `CLAUDE_SDK_MODEL` (optional override, e.g. `claude-sonnet-4-6`)
- [ ] Add Bedrock/Vertex/Azure toggle support:
  - `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials
  - `CLAUDE_CODE_USE_VERTEX=1` + GCP credentials
  - `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials
- [ ] Add mode routing in `architect.ts` (alongside existing `single` check):
  ```
  if (config.agentMode === 'claude-sdk') → import('./claude-sdk-agent.js')
  ```
- [ ] Update `.env.example` with new variables and inline documentation
- [ ] Add config validation: error if `claude-sdk` mode selected without Anthropic-compatible provider

**Milestone:** `AGENT_MODE=claude-sdk` is a recognized mode that routes to a new module. No functionality yet — just plumbing.

---

## Phase 2 — GitHub Tools as Custom MCP Tools

> Wrap existing GitHub tools so the Claude Agent SDK agent can use them.

The SDK provides built-in file tools (Read, Edit, Bash, Glob, Grep) but has no GitHub tools. We need to expose our `github-tools.ts` functions as custom MCP tools via `createSdkMcpServer`.

- [ ] Create `src/claude-sdk-tools.ts` with a `createGitHubMcpServer()` factory
- [ ] Wrap each GitHub tool using the SDK's `tool()` helper + Zod schemas (schemas already exist):
  - [ ] `fetch_github_issues`
  - [ ] `read_repo_file`
  - [ ] `comment_on_issue`
  - [ ] `create_pull_request`
  - [ ] `get_pr_diff`
  - [ ] `submit_pr_review`
  - [ ] `check_ci_status`
  - [ ] `fetch_sub_issues` / `get_parent_issue` / `create_sub_issue`
- [ ] Wrap context tools (`save_context`, `get_context`, `search_past_issues`)
- [ ] Register as MCP server: `createSdkMcpServer({ name: 'github', tools: [...] })`
- [ ] Verify tools appear as `mcp__github__fetch_github_issues` etc. in the SDK
- [ ] Write unit tests for tool wrapping (input/output schema fidelity)

**Milestone:** All project-specific tools are available as MCP tools the SDK agent can invoke.

---

## Phase 3 — Single SDK Agent (MVP)

> A working `claude-sdk` mode that processes issues end-to-end with one SDK agent.

- [ ] Create `src/claude-sdk-agent.ts` with `runClaudeSdkAgent()` function
- [ ] Implement the agent with SDK `query()`:
  - Built-in tools: `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`
  - Custom MCP tools: `github` server from Phase 2
  - System prompt adapted from `single-agent.ts` (all phases: analysis → plan → implement → review)
  - Working directory set to cloned workspace (`cwd` option)
- [ ] Wire up `ProgressUpdate` events via SDK hooks:
  - `PreToolUse` hook → emit phase detection (issuer/coder/reviewer based on tool patterns)
  - `PostToolUse` hook → log tool calls for process manager
  - `Stop` hook → capture final result/outcome
- [ ] Integrate with `ProcessManager`:
  - Create `AgentProcess` record on start
  - Stream logs via hook callbacks → `proc.logs`
  - Set outcome/error on completion
- [ ] Integrate with `UsageService`:
  - Capture token usage from SDK messages (`usage` field in result messages)
  - Record provider/model/agent/cost per call
- [ ] Wire up workspace lifecycle:
  - Clone repo → set as `cwd` → run agent → cleanup
- [ ] Handle cancellation via `AbortController` (map to existing cancel API)
- [ ] Add `maxTurns` and `maxBudgetUsd` from config (circuit breaker equivalents)
- [ ] Write integration tests with mocked SDK responses

**Milestone:** `AGENT_MODE=claude-sdk` processes a GitHub issue end-to-end. Appears in dashboard with live logs and usage tracking. Single agent, no subagents yet.

---

## Phase 4 — Multi-Agent via SDK Subagents

> Replace the single SDK agent with an architect pattern using SDK subagents.

- [ ] Define `AgentDefinition` objects for each role:
  - **Issuer**: read-only tools (`Read`, `Glob`, `Grep`, `mcp__github__fetch_github_issues`, `mcp__github__read_repo_file`, context tools). System prompt from `architect.ts` issuer prompt.
  - **Coder**: all tools (built-in + GitHub write tools + context tools). System prompt from architect coder prompt.
  - **Reviewer**: read + review tools (`Read`, `Grep`, `mcp__github__get_pr_diff`, `mcp__github__submit_pr_review`, context tools). System prompt from architect reviewer prompt.
- [ ] Create main agent (architect) with `Task` tool enabled + agent definitions
- [ ] Adapt the architect system prompt for SDK's subagent invocation pattern
  - SDK uses `Task` tool to spawn named subagents (matches existing pattern)
  - Include iteration logic in architect prompt (reviewer → coder fix → re-review)
- [ ] Map `parent_tool_use_id` from SDK messages to phase tracking:
  - Messages from issuer subagent → `phase: 'issuer'`
  - Messages from coder subagent → `phase: 'coder'`
  - Messages from reviewer subagent → `phase: 'reviewer'`
- [ ] Implement session management:
  - Capture `session_id` from init message
  - Store in `AgentProcess` record for potential resume
  - Use `resume` option for continue/re-review flows
- [ ] Support per-agent model selection:
  - Issuer → `model: "haiku"` (cheap/fast)
  - Coder → `model: "sonnet"` or `"opus"` (powerful)
  - Reviewer → `model: "haiku"` (fast reviews)
  - Map from existing `ISSUER_LLM_MODEL` / `CODER_LLM_MODEL` / `REVIEWER_LLM_MODEL` env vars
- [ ] Wire up the `continue` flow:
  - Resume session with `resume: sessionId`
  - Pass human feedback from `/prompt` command as next user message
- [ ] Write tests for multi-agent orchestration (mocked SDK)

**Milestone:** Full architect → issuer → coder → reviewer pipeline running on the Claude Agent SDK with subagent delegation, per-role model selection, and session-based context.

---

## Phase 5 — SDK Hooks & Observability

> Rich lifecycle hooks for logging, auditing, cost tracking, and safety.

- [ ] `PreToolUse` hooks:
  - [ ] Path validation: block file operations outside workspace directory
  - [ ] Dangerous command filter: block `rm -rf /`, `git push --force`, etc.
  - [ ] Log all tool invocations with arguments (redact secrets)
- [ ] `PostToolUse` hooks:
  - [ ] Capture tool output for process logs
  - [ ] Track file modifications for audit trail
  - [ ] Detect phase transitions (e.g., first `create_pull_request` call = coder phase complete)
- [ ] `PostToolUseFailure` hooks:
  - [ ] Log failures with error details
  - [ ] Increment failure counter (circuit breaker enhancement)
- [ ] `SubagentStart` / `SubagentStop` hooks:
  - [ ] Track subagent lifecycle for dashboard phase stepper
  - [ ] Measure per-subagent duration and token usage
- [ ] `PreCompact` hook:
  - [ ] Log when context compaction occurs (SDK's built-in context management)
  - [ ] Emit event for dashboard notification
- [ ] `Stop` hook:
  - [ ] Capture final outcome text
  - [ ] Persist session ID for future resume
  - [ ] Trigger Bitrix24 notification (if enabled)
- [ ] Ensure all hook events flow through `ProcessManager` → SSE → dashboard

**Milestone:** Complete observability parity with existing modes. All tool calls logged, phases tracked, costs recorded, safety guardrails enforced via hooks.

---

## Phase 6 — Dashboard UI Integration

> Clean UI for selecting and monitoring the `claude-sdk` engine.

### New Process Dialog Changes

- [ ] Add **Engine** selector to `NewProcessDialog` (all tabs):
  - Dropdown/toggle: `Auto` | `Multi-Agent` | `Single Agent` | `Claude SDK`
  - `Auto` = use `AGENT_MODE` from config (default)
  - Show tooltip explaining each mode
- [ ] Conditionally show engine options:
  - [ ] If no Anthropic-compatible provider configured → disable `Claude SDK` option with explanatory text
  - [ ] If Ollama is the only provider → hide `Claude SDK` entirely
- [ ] Add optional **Model override** field when `Claude SDK` is selected:
  - Dropdown: `Default` | `Haiku` | `Sonnet` | `Opus`
- [ ] Add optional **Budget cap** field (USD) for `Claude SDK` mode
- [ ] Pass engine selection to API: `POST /api/processes/analyze { issueNumber, engine, model?, maxBudgetUsd? }`

### Process Detail Changes

- [ ] Show **Engine** badge on process cards/rows (`Multi` | `Single` | `SDK`)
- [ ] For SDK processes, show **Session ID** in detail view (for debugging/resume)
- [ ] Show **subagent timeline** using existing Stepper component:
  - Map `SubagentStart`/`SubagentStop` events to phase steps
  - Show per-subagent duration and model used
- [ ] Show **tool call trace** in expandable section:
  - Built-in tools (Read, Edit, Bash) + custom MCP tools (github.*)
  - Hook events (blocked commands, path violations)
- [ ] Show **budget usage** progress bar (spent / maxBudgetUsd)

### Settings Tab Changes

- [ ] Add **Claude SDK** section in Settings tab:
  - Default permission mode (acceptEdits / bypassPermissions)
  - Default max turns
  - Default budget cap
  - Default model
- [ ] Store settings in `app_settings` table (existing infrastructure)
- [ ] API endpoints: `GET/PUT /api/settings/claude-sdk-*`

### API Endpoint Changes

- [ ] Extend `POST /api/processes/analyze` to accept `{ engine?, model?, maxBudgetUsd? }`
- [ ] Extend `POST /api/processes/review` similarly
- [ ] Extend `POST /api/processes/continue` with `{ sessionId? }` for SDK resume
- [ ] Add `GET /api/engines` endpoint:
  - Returns available engines based on current config
  - `{ engines: [{ id, label, available, reason? }] }`
  - Used by dashboard to populate engine selector

**Milestone:** Dashboard users can select the Claude SDK engine, see SDK-specific metadata, and monitor SDK processes with the same fidelity as existing modes.

---

## Phase 7 — Provider Fallback & Ollama Coexistence

> Graceful handling when Claude SDK is unavailable, and clean Ollama coexistence.

- [ ] **Auto-detection logic** in `ProcessManager`:
  - If `engine=claude-sdk` requested but no Anthropic API key → fall back to `single` mode
  - Log warning: "Claude SDK unavailable, falling back to single-agent mode"
  - Dashboard shows fallback notification
- [ ] **Provider-aware engine suggestions**:
  - `GET /api/engines` returns `recommended: true` for best engine given current config
  - Ollama config → recommend `multi` or `single`
  - Anthropic config → recommend `claude-sdk`
  - Mixed config → show all options
- [ ] **Ollama + Claude SDK split** (advanced):
  - Allow per-process provider override from dashboard
  - Quick tasks (triage) → Ollama via `single` mode (free/fast)
  - Complex tasks (full analysis) → Claude SDK (premium)
  - Dashboard shows cost comparison hint
- [ ] **Health checks**:
  - Extend `/health` endpoint to report SDK availability
  - `{ status: "ok", engines: { multi: true, single: true, claudeSdk: true/false } }`
- [ ] Update `deepagents status` CLI to show available engines

**Milestone:** System gracefully handles mixed provider setups. Ollama users are never blocked. Claude SDK is offered when available. Dashboard communicates engine availability clearly.

---

## Phase 8 — Testing & Documentation

> Comprehensive test coverage and documentation for the new mode.

- [ ] **Unit tests** (`tests/claude-sdk-agent.test.ts`):
  - [ ] Config validation (mode routing, env var parsing)
  - [ ] MCP tool wrapping (schema fidelity, error handling)
  - [ ] Hook callbacks (phase detection, logging, safety filters)
  - [ ] Session management (capture, resume, fork)
  - [ ] Budget enforcement
- [ ] **Integration tests** (`tests/claude-sdk-integration.test.ts`):
  - [ ] Full issue analysis flow (mocked SDK)
  - [ ] Multi-agent subagent delegation
  - [ ] Continue/resume flow
  - [ ] Cancellation via AbortController
  - [ ] Fallback when SDK unavailable
- [ ] **Dashboard tests**:
  - [ ] Engine selector visibility logic
  - [ ] SDK-specific detail view rendering
  - [ ] Settings persistence
- [ ] **Documentation**:
  - [ ] Update `README.md` with Claude SDK mode setup instructions
  - [ ] Update `.env.example` with all new variables
  - [ ] Update `CHANGELOG.md` with new version entry
  - [ ] Add inline code comments in new modules

**Milestone:** Full test coverage for the new mode. Documentation complete. Ready for release.

---

## Phase 9 — Advanced SDK Features (Future)

> Optional enhancements to explore after the core integration is stable.

- [ ] **MCP server marketplace**: Connect additional MCP servers (Playwright for browser testing, Slack for notifications, Sentry for error context)
- [ ] **Session forking**: Fork a session to explore multiple fix approaches in parallel
- [ ] **File checkpointing**: Enable `enableFileCheckpointing` to rewind workspace to earlier states if a fix goes wrong
- [ ] **Structured output**: Use `outputFormat` for typed agent responses (JSON schema for issue briefs, code plans)
- [ ] **Skills & slash commands**: Define `.claude/skills/` for project-specific agent capabilities
- [ ] **CLAUDE.md integration**: Use `settingSources: ['project']` to load project context automatically
- [ ] **Streaming input**: Use async generator prompt for real-time human-agent dialog via SDK
- [ ] **Cost analytics**: SDK-specific cost breakdowns in Usage tab (per-subagent, per-tool, per-session)

---

## Summary

| Phase | What | Key Deliverable |
|-------|------|-----------------|
| 1 | Foundation & Config | Mode routing, env vars, validation |
| 2 | GitHub MCP Tools | Custom tools via `createSdkMcpServer` |
| 3 | Single SDK Agent (MVP) | End-to-end issue processing with SDK |
| 4 | Multi-Agent Subagents | Architect → Issuer/Coder/Reviewer via SDK |
| 5 | Hooks & Observability | Logging, safety, cost tracking via hooks |
| 6 | Dashboard UI | Engine selector, SDK metadata, settings |
| 7 | Provider Fallback | Ollama coexistence, auto-detection, health |
| 8 | Testing & Docs | Full coverage, README updates |
| 9 | Advanced Features | MCP marketplace, sessions, skills (future) |

---

## Guiding Principles

1. **Additive, not destructive** — existing `multi` and `single` modes are never modified or broken
2. **Provider flexibility** — Ollama and OpenAI users are never locked out; Claude SDK is an opt-in premium path
3. **Same dashboard, more options** — the UI adapts to show relevant options based on what's available
4. **Hooks over hacks** — use SDK hooks for observability instead of monkey-patching
5. **Reuse existing infrastructure** — ProcessManager, UsageService, SSE streaming, database layer all stay the same
