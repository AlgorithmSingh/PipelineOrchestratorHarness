# Execution Pipeline Visibility and Summary — Technical Specification

## Summary

Add structured, human-scannable execution summaries to the pipeline so operators can tell what each ticket did without inspecting git history. All observability flows through a harness-owned normalized event schema (`AgentEvent`) that both runtimes emit into, consumed by two outputs: a compact terminal renderer (pino one-liners) and a durable per-ticket artifact bundle under `.harness/logs/<ticketId>/`. A per-run rollup is emitted when the orchestrator stops or when all tickets in a polling cycle are exhausted. Idle polling noise is suppressed with backoff.

### Design Principles

1. If the harness merges autonomously, the operator should be able to reconstruct what happened and why from the log and artifacts alone, without running `git log` or `git diff` after the fact.
2. The harness owns the event model. Claude-shaped logs and Codex-shaped logs are normalized into one schema. One renderer, one artifact writer, one test surface.
3. Default to redaction. Full prompt and command output capture is opt-in.

---

## Terminal Output (Compact One-Liners)

These are pino `INFO`-level structured log entries emitted at existing pipeline stage boundaries in `execution.ts`. The data for each is already in scope at the injection point — no new I/O is required except the `git diff --stat` after coder completion.

### Injection points

#### 1. After claim — log what the ticket is

Injection: immediately after successful `exec:claim → exec:generate_contract` transition.

Data in scope: `context.ticketId`, `context.contractJson` (from ticket description or title).

Terminal output:
```
[18:46:35] INFO: execution todolist11-26r contract | Add due-date field to Todo items
```

Structured fields:
```json
{
  "pipeline": "execution",
  "ticketId": "todolist11-26r",
  "event": "contract",
  "title": "Add due-date field to Todo items",
  "contractSummary": "First 200 chars of contract body or full title if short"
}
```

Implementation: extract title from `contractJson`. If contract is a JSON object with a `title` field, use it. Otherwise use the first line of the contract text, truncated to 200 chars.

#### 2. After planner — log the plan decisions

Injection: immediately after `planner_done` log entry, before the `generate_contract → execute_code` transition.

Data in scope: `context.plannerOutput` (the raw planner result stored after planner execution).

Terminal output:
```
[18:48:31] INFO: execution todolist11-26r plan_summary | files: src/types.ts, src/store.ts, src/cli.ts | approach: Add dueDate to TodoItem, update CRUD and CLI
```

Structured fields:
```json
{
  "pipeline": "execution",
  "ticketId": "todolist11-26r",
  "event": "plan_summary",
  "targetFiles": ["src/types.ts", "src/store.ts", "src/cli.ts"],
  "approach": "Condensed approach string"
}
```

Implementation: The planner output is agent-generated free text. To extract structured summary data, use a lightweight parse:
- Look for file paths (strings matching common source extensions) in the planner output and collect up to 10 as `targetFiles`.
- Take the first sentence or first 200 characters of the planner output as `approach`.
- If the planner output is JSON (some prompts request structured output), extract directly from known fields.

Do NOT call the agent again to summarize. This is a best-effort extraction from text already in memory.

#### 3. After coder — log what changed

Injection: immediately after `coder_done` log entry, before the `execute_code → deterministic_checks` transition.

Data in scope: `context.worktreePath` (the worktree directory).

New I/O required: run `git diff --stat HEAD` in the worktree directory. This is a local git operation, sub-second.

Terminal output:
```
[18:49:29] INFO: execution todolist11-26r coder_changes | 3 files | src/store.ts (+15 -3), src/types.ts (+2 -1), src/cli.ts (+8 -2)
```

Structured fields:
```json
{
  "pipeline": "execution",
  "ticketId": "todolist11-26r",
  "event": "coder_changes",
  "filesChanged": 3,
  "insertions": 25,
  "deletions": 6,
  "diffStat": "src/store.ts (+15 -3), src/types.ts (+2 -1), src/cli.ts (+8 -2)",
  "changedFiles": ["src/store.ts", "src/types.ts", "src/cli.ts"]
}
```

Implementation:
- Execute `git diff --stat HEAD` via `execa` in worktree cwd.
- Parse the summary line for total files/insertions/deletions.
- Parse per-file lines for the compact `diffStat` string.
- If the worktree has no diff (e.g. coder made no changes), log `coder_changes | no changes detected`. The existing no-changes path in the pipeline already handles this for commit; this just makes it visible earlier.

#### 4. After reviewer — log the verdict and reasoning

Injection: immediately after `reviewer_done` log entry, before the `agent_review → commit` or cascade transition.

Data in scope: the reviewer raw output (already parsed or about to be parsed for verdict).

Terminal output (pass):
```
[18:49:54] INFO: execution todolist11-26r reviewer_verdict | pass | "changes match contract, types consistent"
```

Terminal output (fail):
```
[18:49:54] INFO: execution todolist11-26r reviewer_verdict | fail | "missing test coverage for edge case"
```

Terminal output (parse failure — relevant after v2 hardening):
```
[18:49:54] INFO: execution todolist11-26r reviewer_verdict | invalid | reviewer_output_invalid: no_json_found
```

Structured fields:
```json
{
  "pipeline": "execution",
  "ticketId": "todolist11-26r",
  "event": "reviewer_verdict",
  "verdict": "pass",
  "reasoning": "First 300 chars of reviewer reasoning or notes field"
}
```

Implementation:
- After verdict parsing (using the `parseReviewerVerdict` from v2 spec if implemented, or the current parse logic), extract `reasoning` from the parsed JSON (look for fields like `reasoning`, `notes`, `comments`, `explanation` — use the first one found).
- Truncate reasoning to 300 chars for the structured field. Terminal one-liner uses first 100 chars.

#### 5. After merge/completion — log the ticket summary line

Injection: immediately after `exec:close_ticket → exec:completed` transition.

Data in scope: all context fields accumulated during execution.

Terminal output:
```
[18:49:55] INFO: execution todolist11-26r ticket_summary | merged 3a9f6f7 | "Add due-date field" | 3 files | $0.65 | 3m20s
```

Structured fields:
```json
{
  "pipeline": "execution",
  "ticketId": "todolist11-26r",
  "event": "ticket_summary",
  "outcome": "merged",
  "sha": "3a9f6f7",
  "title": "Add due-date field to Todo items",
  "filesChanged": 3,
  "totalCost": 0.6489,
  "totalDurationMs": 200667,
  "plannerCost": 0.3396,
  "coderCost": 0.1587,
  "reviewerCost": 0.1506,
  "retryCount": 0
}
```

Implementation:
- Accumulate cost from each agent stage result's `tokenUsage` using the existing `cost.ts` utility (currently not wired — this is the integration point).
- Accumulate duration from each stage's `durationMs`.
- SHA comes from the merge result already in context.
- `outcome` is one of: `merged`, `failed`, `no_changes`.

#### 6. On failure — log failure summary

Injection: when ticket reaches `exec:failed` state.

Terminal output:
```
[18:49:55] WARN: execution todolist11-26r ticket_failed | "Add due-date field" | reason: reviewer_output_invalid | retries: 3 | $1.95
```

Structured fields:
```json
{
  "pipeline": "execution",
  "ticketId": "todolist11-26r",
  "event": "ticket_failed",
  "title": "Add due-date field to Todo items",
  "failureType": "reviewer_output_invalid",
  "retryCount": 3,
  "totalCost": 1.95,
  "totalDurationMs": 542000
}
```

---

## Per-Ticket Summary File

On completion or failure, write a JSON summary to `.harness/summaries/<ticketId>.json`.

This file contains the full structured record — everything an operator or dashboard would need to understand what happened without parsing logs.

### Schema

```json
{
  "ticketId": "todolist11-26r",
  "title": "Add due-date field to Todo items",
  "outcome": "merged",
  "sha": "3a9f6f732eb9c500e3ccb668e574370db308c16c",
  "branch": "agent/todolist11-26r",
  "startedAt": "2026-03-10T17:46:35.000Z",
  "completedAt": "2026-03-10T17:49:55.000Z",
  "totalDurationMs": 200667,
  "retryCount": 0,
  "cost": {
    "planner": { "inputTokens": 12000, "outputTokens": 3400, "costUsd": 0.3396 },
    "coder": { "inputTokens": 8500, "outputTokens": 2100, "costUsd": 0.1587 },
    "reviewer": { "inputTokens": 9200, "outputTokens": 1800, "costUsd": 0.1506 },
    "totalUsd": 0.6489
  },
  "stages": {
    "planner": {
      "runtime": "claude-code",
      "model": "claude-sonnet-4-6",
      "durationMs": 115171,
      "turns": 4,
      "approach": "Add dueDate to TodoItem type, update store CRUD, add CLI flag",
      "targetFiles": ["src/types.ts", "src/store.ts", "src/cli.ts"]
    },
    "coder": {
      "runtime": "claude-code",
      "model": "claude-sonnet-4-6",
      "durationMs": 58862,
      "turns": 8,
      "exitReason": "completed",
      "passed": true,
      "filesChanged": 3,
      "insertions": 25,
      "deletions": 6,
      "diffStat": "src/store.ts (+15 -3), src/types.ts (+2 -1), src/cli.ts (+8 -2)",
      "changedFiles": ["src/store.ts", "src/types.ts", "src/cli.ts"]
    },
    "checks": {
      "all_passed": true,
      "results": [
        { "name": "Typecheck", "passed": true },
        { "name": "Lint", "passed": true },
        { "name": "Tests", "passed": true }
      ]
    },
    "reviewer": {
      "runtime": "claude-code",
      "model": "claude-sonnet-4-6",
      "durationMs": 23634,
      "turns": 8,
      "verdict": "pass",
      "reasoning": "Changes match contract scope. Types are consistent. Test coverage adequate."
    }
  },
  "contract": "Full contract JSON or text as stored in context"
}
```

### Directory management

- `loadConfig()` already creates `.harness/state/` and `.harness/logs/` — add `.harness/summaries/` to the same directory creation block in `config.ts`.
- Summary is written atomically: write to `.harness/summaries/<ticketId>.tmp.json`, then rename.
- If write fails, log a warning but do not block pipeline completion.

### When to write

- After `exec:close_ticket → exec:completed` (success path)
- After ticket reaches `exec:failed` (failure path)
- On either path, the summary is the last thing written before the ticket state machine is done.

---

## Per-Run Cost and Time Rollup

When the orchestrator completes a polling cycle where it processed one or more tickets (i.e., transitioning from "had work" to "no more work"), emit a rollup summary.

### Trigger

Track in `ExecutionPipeline` state:
- `runTicketIds: string[]` — tickets processed in the current orchestrator session
- `runStartedAt: Date` — set on first ticket claim
- `runTotalCost: number` — accumulated from ticket summaries

Emit rollup when:
- A polling cycle returns 0 tickets AND `runTicketIds.length > 0`
- OR the orchestrator receives SIGINT/SIGTERM

### Terminal output

```
[18:56:55] INFO: execution  run_summary | 3 tickets completed | 0 failed | $1.55 total | 10m20s
    tickets: todolist11-26r, todolist11-k5a, todolist11-kek
```

### Structured fields

```json
{
  "pipeline": "execution",
  "event": "run_summary",
  "ticketsCompleted": 3,
  "ticketsFailed": 0,
  "ticketIds": ["todolist11-26r", "todolist11-k5a", "todolist11-kek"],
  "totalCostUsd": 1.55,
  "totalDurationMs": 620000,
  "averageCostPerTicket": 0.5167,
  "averageDurationPerTicket": 206667
}
```

---

## Idle Polling Noise Suppression

### Current behavior

The log currently emits this every 30 seconds indefinitely:
```
[17:56:55] INFO: execution  tickets_polled | polled execution tickets
    count: 0
[17:56:55] INFO: execution  no_tickets | no ready tickets
```

This is 2 log lines every 30 seconds, visible in the terminal, adding no information after the first occurrence.

### New behavior

- First empty poll after processing tickets: emit `no_tickets` at `INFO` level (keep visible).
- Subsequent consecutive empty polls: emit at `DEBUG` level (hidden in default terminal, visible in JSON mode or when `LOG_LEVEL=debug`).
- Every 10th consecutive empty poll (5 minutes at default interval): emit at `INFO` level as a heartbeat so operators know the process is alive:

```
[18:01:55] INFO: execution  idle_heartbeat | no tickets for 5m | polling continues
    pipeline: "execution"
    event: "idle_heartbeat"
    idleSinceMs: 300000
    consecutiveEmptyPolls: 10
```

Implementation: add a `consecutiveEmptyPolls` counter in `ExecutionPipeline`. Reset to 0 when tickets are found. Use the counter to select log level.

---

## Implementation Changes

### Files to modify

**`src/pipelines/execution.ts`** — primary changes:
- Add `extractContractTitle(contractJson: string): string` helper
- Add `extractPlanSummary(plannerOutput: string): { targetFiles: string[], approach: string }` helper
- Add `getDiffStat(worktreePath: string): Promise<DiffStatResult>` helper using `execa`
- Add `extractReviewerReasoning(rawOutput: string): string` helper
- Add cost accumulator: `ticketCosts: { planner: number, coder: number, reviewer: number }`
- Add run-level accumulators: `runTicketIds`, `runStartedAt`, `runTotalCost`
- Add `consecutiveEmptyPolls` counter
- Inject log calls at the 6 stage boundaries defined above
- Write summary file on completion/failure
- Emit `run_summary` on transition to idle or shutdown

**`src/config.ts`**:
- Add `.harness/summaries/` to directory creation

**`src/util/cost.ts`** — wire into execution:
- The `estimateCost` function already exists. The execution pipeline needs to call it with `tokenUsage` from each `AgentResult` and accumulate per-stage costs in the ticket context. No changes to `cost.ts` itself — just the call sites in `execution.ts`.

**`src/types.ts`** or new `src/pipelines/execution-types.ts`:
- Add `TicketSummary` type matching the summary file schema
- Add `DiffStatResult` type
- Add `PlanSummary` type

### Files NOT modified

- `src/state/machine.ts` — no state model changes
- `src/state/transitions.ts` — no new states or transitions
- `src/runtime/claude-code.ts` — no runtime changes
- `src/beads/client.ts` — no Beads changes

---

## Test Plan

### Contract title extraction
- JSON contract with `title` field → extracts title
- Plain text contract → uses first line, truncated to 200 chars
- Empty contract → returns `"(no title)"`

### Plan summary extraction
- Planner output containing file paths → extracts up to 10 paths
- Planner output with no recognizable paths → returns empty `targetFiles`
- Approach truncation at 200 chars

### Diff stat parsing
- Normal `git diff --stat` output → correct file count, insertions, deletions, per-file breakdown
- No changes → `filesChanged: 0`, empty `diffStat`
- Binary files in diff → handled gracefully (excluded from line counts)

### Reviewer reasoning extraction
- JSON with `reasoning` field → extracts it
- JSON with `notes` field (no `reasoning`) → uses `notes`
- JSON with no reasoning-like field → returns empty string
- Truncation at 300 chars

### Idle polling suppression
- First empty poll → `INFO` level
- Second through ninth empty polls → `DEBUG` level
- Tenth empty poll → `INFO` level heartbeat
- Tickets found after idle → counter resets, next empty poll is `INFO`

### Summary file writing
- Successful ticket → summary file created with all fields populated
- Failed ticket → summary file created with failure fields
- Summary write failure → warning logged, pipeline continues
- Summary directory missing → created on startup

### Run rollup
- 3 tickets completed, then idle → rollup emitted with correct totals
- SIGINT during processing → rollup emitted in shutdown handler
- No tickets processed in session → no rollup emitted

---

## Implementation Order

1. **Types and helpers** — `DiffStatResult`, `TicketSummary`, extraction functions. All pure/testable.
2. **Diff stat helper + tests** — the only new I/O (git subprocess).
3. **Stage boundary log injections** — wire the 6 log points in `execution.ts`.
4. **Cost accumulation** — wire `estimateCost` calls into agent stage completions.
5. **Summary file writer + tests** — atomic write, directory creation.
6. **Run rollup** — session-level accumulators and idle/shutdown emission.
7. **Idle polling suppression** — counter and log level logic.

---

## Interaction with v2 Hardening Spec

This spec is designed to layer cleanly on top of the v2 hardening changes:

- The `reviewer_verdict` log point (injection #4) uses `parseReviewerVerdict` output directly if v2 is implemented. If not yet implemented, it uses the current parse result.
- The `coder_changes` log point (injection #3) fires before the early runtime gate from v2. If the coder fails, the diff stat may show partial changes — this is useful diagnostic context.
- The `ticket_failed` log point (injection #6) uses `failureType` from v2's enriched cascade context if available.
- Implementation order is independent — this spec can land before, after, or alongside v2.