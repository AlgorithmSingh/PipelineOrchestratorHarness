### Interactive Pipeline Progress Tree + Expandable Agent Output

#### Summary
- Implement an interactive terminal dashboard (TUI) as the primary live view, with expandable/collapsible tree nodes and explicit pending/completed progress.
- Cover all pipelines in v1:
  - `execution`: full stage-level progress per ticket + queue counters.
  - `plan` and `adversarial`: pipeline-level status cards now (they are currently placeholder pipelines), with stage hooks ready for future expansion.
- Keep terminal clean in dashboard mode by showing dashboard + warn/error logs only; write full info/debug logs to a session log file.

#### Key Implementation Changes
1. Add a dashboard mode selector for `harness start`: `--ui auto|dashboard|logs` (default `auto`).
2. Introduce a UI event model and event bus:
- `pipeline events`: poll started/finished, queue counts, transition updates, terminal outcome.
- `agent events`: normalized Claude events (task/tool/progress/result), already filtered/compressed.
3. Build an interactive tree renderer (TTY-only):
- Node hierarchy:
  - `Pipeline`
  - `Queue` (`ready`, `running`, `completed`, `failed`, `pending`)
  - `Tickets` (per ticket)
  - `Stages` checklist
  - `Agent Activity` (expandable, collapsed by default)
- Keyboard controls:
  - `↑/↓` move selection
  - `Enter` toggle expand/collapse
  - `→` expand, `←` collapse
  - `e` expand all, `c` collapse all
4. Define deterministic stage mappings for progress percentages and pending logic:
- Execution checklist:
  - `claim`, `plan contract`, `code`, `checks`, `review`, `commit`, `merge`, `close`
- Status values:
  - `pending`, `active`, `completed`, `skipped`, `failed`
- Branch handling:
  - mark unchosen branch nodes as `skipped` (e.g., `create_pr` path when direct merge is used)
  - cascade/reinject/hitl reflected as additional stage markers and retry count
5. Agent-output compression and expandable detail policy:
- Suppress noisy low-value deltas (`content_block_delta`, massive tool results, repeated progress).
- Keep high-signal events (`task_started`, throttled `task_progress`, `tool_use`, `result`).
- Store full event text in node details; render truncated summaries in collapsed view.
6. Logging policy in dashboard mode:
- Terminal: dashboard + `warn/error` log entries only.
- File: full NDJSON logs for the run in `.harness/logs/harness-<timestamp>.ndjson`.
- Non-TTY fallback:
  - `auto` -> plain logs mode
  - `dashboard` on non-TTY -> warning then fallback to logs mode

#### Public API / Interface Changes
- CLI:
  - `harness start --ui <auto|dashboard|logs>`
- Runtime callback surface:
  - add optional observer hooks in runtime execution config for normalized agent events.
- Internal UI contracts:
  - typed `PipelineProgressSnapshot` and `AgentEvent` payloads used by pipelines/runtimes to update the dashboard.

#### Test Plan
1. Unit tests: stage-mapping engine
- transitions update `pending/active/completed/skipped/failed` correctly across success and cascade/retry paths.
2. Unit tests: agent event normalization/compression
- noisy Claude stream lines are filtered; high-signal events remain; final result extraction remains intact.
3. Unit tests: tree renderer behavior
- collapse/expand state, keyboard actions, truncation behavior, and deterministic node ordering.
4. Integration tests: UI mode selection
- `--ui auto` uses dashboard on TTY and logs mode on non-TTY.
- `--ui dashboard` fallback behavior on non-TTY is correct.
5. Regression tests:
- existing runtime output parsing still supports reviewer JSON parsing and pipeline pass/fail logic.

#### Assumptions and Defaults
- Chosen defaults from this discussion:
  - UI mode preference: **Interactive TUI**
  - Progress scope: **Per-ticket + queue**
  - Logs policy: **Dashboard primary** (warn/error in terminal, full logs in file)
  - Coverage: **All pipelines now**
- `plan` and `adversarial` currently have placeholder run logic; v1 shows pipeline-level pending/running/completed for them and is structured to absorb future stage-level transitions without redesign.
