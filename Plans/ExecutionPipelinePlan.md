# Execution Pipeline Visibility & Summary — Consolidated Implementation Plan

## Architecture Decisions (Locked)

These were resolved during planning and are not open for reinterpretation:

- **Pipeline-only normalization** — no cross-runtime `AgentEvent` abstraction this iteration
- **Token-usage cost** — use `estimateCost` from `cost.ts` with `AgentResult.tokenUsage`; if usage is zero/missing, emit zero cost (not fabricated)
- **Nullable optional fields** — unknown metadata (model, turns) is `null`, never fabricated
- **Execution pipeline + flush hook** — run accumulators live in `ExecutionPipeline`, orchestrator calls `flushRunSummary()` on shutdown
- **Summary path** — fixed at `.harness/summaries/` under project root, not configurable this iteration

---

## File Structure

### New files

**`src/pipelines/execution-types.ts`** — all observability types in one module:

```ts
export interface DiffStatResult {
  filesChanged: number;
  insertions: number;
  deletions: number;
  diffStat: string;           // "src/store.ts (+15 -3), ..."
  changedFiles: string[];
}

export interface PlanSummary {
  targetFiles: string[];      // up to 10 file paths
  approach: string;           // first 200 chars
}

export interface StageCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number | null;
}

export interface TicketSummary {
  ticketId: string;
  title: string;
  outcome: "merged" | "failed" | "no_changes";
  sha: string | null;
  branch: string | null;
  startedAt: string;          // ISO 8601
  completedAt: string;
  totalDurationMs: number;
  retryCount: number;
  cost: {
    planner: StageCost | null;
    coder: StageCost | null;
    reviewer: StageCost | null;
    totalUsd: number;
  };
  stages: {
    planner: {
      runtime: string | null;
      model: string | null;
      durationMs: number | null;
      turns: number | null;
      approach: string;
      targetFiles: string[];
    } | null;
    coder: {
      runtime: string | null;
      model: string | null;
      durationMs: number | null;
      turns: number | null;
      exitReason: string | null;
      passed: boolean | null;
      filesChanged: number;
      insertions: number;
      deletions: number;
      diffStat: string;
      changedFiles: string[];
    } | null;
    checks: {
      allPassed: boolean;
      results: CheckResult[];
    } | null;
    reviewer: {
      runtime: string | null;
      model: string | null;
      durationMs: number | null;
      turns: number | null;
      verdict: string | null;
      reasoning: string;
    } | null;
  };
  contract: string;
  failureType?: string;
  failureReason?: string;
}

export interface RunSummary {
  ticketsCompleted: number;
  ticketsFailed: number;
  ticketIds: string[];
  totalCostUsd: number;
  totalDurationMs: number;
  averageCostPerTicket: number;
  averageDurationPerTicket: number;
}
```

### Modified files

| File | Scope |
|---|---|
| `src/pipelines/execution.ts` | Major — helpers, 6 log injections, cost accumulation, summary writer, run rollup, idle suppression, `flushRunSummary()` public method |
| `src/config.ts` | Minor — add `.harness/summaries/` to directory creation block |
| `src/orchestrator.ts` | Minor — call `flushRunSummary("shutdown")` in SIGINT/SIGTERM handler |

### Files NOT modified

- `src/state/machine.ts` — no state model changes
- `src/state/transitions.ts` — no transition changes
- `src/runtime/claude-code.ts` — no runtime adapter changes
- `src/runtime/codex.ts` — no runtime adapter changes
- `src/beads/client.ts` — no Beads changes
- `src/util/cost.ts` — used as-is

---

## Phase 1 — Types and Pure Helpers

**No I/O. Fully unit-testable.**

### Types (`src/pipelines/execution-types.ts`)

Create all types listed above.

### Helpers (add to `src/pipelines/execution.ts`)

**`extractContractTitle(contractJson: string): string`**
- Try JSON parse → look for `title` field → return it
- On parse failure or missing title → take first line of raw text, truncate to 200 chars
- On empty input → return `"(no title)"`

**`extractPlanSummary(plannerOutput: string): PlanSummary`**
- Regex scan for file paths matching common source extensions (`.ts`, `.js`, `.py`, `.tsx`, `.jsx`, `.json`, `.yaml`, `.yml`, `.css`, `.html`, `.md`)
- Collect up to 10 unique paths as `targetFiles`
- If planner output parses as JSON with known fields (e.g. `files`, `plan`, `approach`), extract directly
- Take first 200 characters of output (or structured `approach` field) as `approach`
- Never call an agent to summarize

**`extractReviewerReasoning(rawOutput: string): string`**
- Try JSON parse of raw output
- Look for fields in priority order: `reasoning`, `notes`, `comments`, `explanation`
- Return first found, truncated to 300 chars
- On parse failure or no matching field → return `""`

**`parseDiffStat(gitOutput: string): DiffStatResult`**
- Parse `git diff --stat` output format:
  - Per-file lines: `<path> | <N> <+/-symbols>`
  - Summary line: `N files changed, N insertions(+), N deletions(-)`
- Handle: no changes (empty output → zeros), binary files (skip from line counts), no summary line
- Return structured `DiffStatResult`

### Tests

```
extractContractTitle:
  - JSON with title field → extracts title
  - JSON without title → first line of stringified input, truncated
  - Plain text → first line, truncated to 200 chars
  - Empty string → "(no title)"
  - Malformed JSON → first line of raw text

extractPlanSummary:
  - Output with "src/store.ts" and "src/cli.ts" → both in targetFiles
  - Output with 15 file paths → only first 10
  - Output with no recognizable paths → empty targetFiles
  - Approach truncation at 200 chars
  - JSON output with approach field → uses it directly

extractReviewerReasoning:
  - JSON with reasoning field → extracts it
  - JSON with notes (no reasoning) → uses notes
  - JSON with comments (no reasoning/notes) → uses comments
  - JSON with no matching field → ""
  - Non-JSON output → ""
  - Reasoning longer than 300 chars → truncated

parseDiffStat:
  - Normal output with 3 files → correct counts and per-file stat
  - Empty output → filesChanged: 0, empty string, empty array
  - Binary file lines → excluded from insertions/deletions
  - Single file change → correct
```

---

## Phase 2 — Diff Stat I/O Helper

**Single new subprocess call.**

### Implementation (`src/pipelines/execution.ts`)

**`getDiffStat(worktreePath: string): Promise<DiffStatResult>`**
- Run `git diff --stat HEAD` via `execa` with `cwd: worktreePath`
- Pass stdout to `parseDiffStat()`
- On `execa` failure (e.g. not a git repo) → return zero-valued `DiffStatResult` and log warning

### Tests

- Mock `execa` with realistic `git diff --stat` output → verify parsed result
- Mock `execa` returning empty stdout → verify zero result
- Mock `execa` throwing → verify graceful fallback

---

## Phase 3 — Stage Boundary Log Injections

**Six injection points in `driveStateMachine()` or equivalent execution flow in `src/pipelines/execution.ts`.**

Each injection is a pino structured log call at `INFO` level (except failure at `WARN`). All data is already in scope at the injection point.

### Injection 1: After claim → generate_contract

```ts
logger.info({
  pipeline: "execution",
  ticketId,
  event: "contract",
  title: extractContractTitle(context.contractJson),
  contractSummary: context.contractJson?.slice(0, 200)
}, `${ticketId} contract | ${title}`);
```

### Injection 2: After planner completes, before generate_contract → execute_code

```ts
const plan = extractPlanSummary(context.plannerOutput);
logger.info({
  pipeline: "execution",
  ticketId,
  event: "plan_summary",
  targetFiles: plan.targetFiles,
  approach: plan.approach
}, `${ticketId} plan_summary | files: ${plan.targetFiles.join(", ")} | approach: ${plan.approach}`);
```

Store `plan` in execution metadata for summary file.

### Injection 3: After coder completes, before execute_code → deterministic_checks

```ts
const diff = await getDiffStat(context.worktreePath);
logger.info({
  pipeline: "execution",
  ticketId,
  event: "coder_changes",
  filesChanged: diff.filesChanged,
  insertions: diff.insertions,
  deletions: diff.deletions,
  diffStat: diff.diffStat,
  changedFiles: diff.changedFiles
}, `${ticketId} coder_changes | ${diff.filesChanged} files | ${diff.diffStat}`);
```

Store `diff` in execution metadata for summary file.

### Injection 4: After reviewer verdict parsing

```ts
const reasoning = extractReviewerReasoning(reviewerRawOutput);
logger.info({
  pipeline: "execution",
  ticketId,
  event: "reviewer_verdict",
  verdict,          // "pass", "fail", or "invalid"
  reasoning
}, `${ticketId} reviewer_verdict | ${verdict} | ${reasoning.slice(0, 100)}`);
```

### Injection 5: After close_ticket → completed

```ts
logger.info({
  pipeline: "execution",
  ticketId,
  event: "ticket_summary",
  outcome: "merged",
  sha: mergeSha?.slice(0, 7),
  title,
  filesChanged: diff.filesChanged,
  totalCost: ticketCosts.totalUsd,
  totalDurationMs,
  retryCount: context.retryCount
}, `${ticketId} ticket_summary | merged ${sha} | "${title}" | ${filesChanged} files | $${totalCost} | ${duration}`);
```

### Injection 6: On exec:failed

```ts
logger.warn({
  pipeline: "execution",
  ticketId,
  event: "ticket_failed",
  title,
  failureType: context.failureType ?? "unknown",
  retryCount: context.retryCount,
  totalCost: ticketCosts.totalUsd,
  totalDurationMs
}, `${ticketId} ticket_failed | "${title}" | reason: ${failureType} | retries: ${retryCount} | $${totalCost}`);
```

### Execution metadata accumulation

Add a per-ticket metadata object (local to the ticket processing scope, not persisted in state machine):

```ts
interface TicketExecutionMeta {
  startedAt: Date;
  title: string;
  plan: PlanSummary | null;
  diff: DiffStatResult | null;
  reviewerVerdict: string | null;
  reviewerReasoning: string;
  costs: { planner: StageCost | null; coder: StageCost | null; reviewer: StageCost | null };
  checkResults: CheckResult[];
}
```

This is populated as each stage completes and consumed by the summary writer and ticket_summary/ticket_failed logs.

---

## Phase 4 — Cost Accumulation

**Wire existing `estimateCost` from `src/util/cost.ts` into stage completions.**

After each `executeWithHeartbeat()` call (planner, coder, reviewer):

```ts
const stageCost: StageCost = {
  inputTokens: agentResult.tokenUsage.inputTokens,
  outputTokens: agentResult.tokenUsage.outputTokens,
  cacheReadTokens: agentResult.tokenUsage.cacheReadTokens,
  cacheWriteTokens: agentResult.tokenUsage.cacheWriteTokens,
  costUsd: estimateCost(agentResult.tokenUsage, rateConfig)
};
meta.costs.planner = stageCost; // (or coder/reviewer as appropriate)
```

Compute `totalUsd` as sum of non-null stage costs.

**Note:** `estimateCost` takes rate parameters. If rate config is not already in `HarnessConfig`, add a `costRates` section with sensible defaults for Claude Sonnet 4.6 pricing. If token usage is zero/missing, `costUsd` is `0` — not fabricated.

### Tests

- `estimateCost` with known token counts → expected cost (existing test if any, or add)
- Zero token usage → zero cost
- Cost accumulation across 3 stages → correct total

---

## Phase 5 — Summary File Writer

### Directory creation (`src/config.ts`)

Add `.harness/summaries/` to the existing `mkdirSync` block that creates `worktrees/`, `state/`, and `logs/`.

### Writer (`src/pipelines/execution.ts`)

**`writeTicketSummary(config: HarnessConfig, summary: TicketSummary): Promise<void>`**

- Resolve path: `<project.root>/.harness/summaries/<ticketId>.json`
- Write to `<ticketId>.tmp.json`
- Rename to `<ticketId>.json` (atomic)
- Wrap entire operation in try/catch — on failure, `logger.warn()` and return (never block pipeline)

### Call sites

- After `exec:close_ticket → exec:completed` transition: build `TicketSummary` from `TicketExecutionMeta` + state context, write
- After ticket reaches `exec:failed`: same build + write

### Assembly

Build `TicketSummary` from:
- `TicketExecutionMeta` (plan, diff, costs, check results, verdict, reasoning)
- State context (ticketId, retryCount, worktree branch, merge SHA)
- Timestamps from `meta.startedAt` and `new Date()` at completion

Fields that are unavailable (model, turns) → `null`.

### Tests

- Happy path: writes valid JSON, file exists, content parses to expected shape
- Atomic rename: tmp file is cleaned up
- Write failure (e.g. read-only dir): warning logged, no throw
- Failure-path summary: outcome is "failed", failureType populated

---

## Phase 6 — Run-Level Rollup

### Instance state (add to `ExecutionPipeline`)

```ts
private runTicketIds: string[] = [];
private runStartedAt: Date | null = null;
private runTotalCost: number = 0;
private runTicketsCompleted: number = 0;
private runTicketsFailed: number = 0;
```

### Accumulation

- On first ticket claim in a session: set `runStartedAt = new Date()`
- On `exec:completed`: push ticketId, increment `runTicketsCompleted`, add ticket cost
- On `exec:failed`: push ticketId, increment `runTicketsFailed`, add ticket cost

### Emission

In `runOnce()`, after polling returns 0 tickets:
- If `runTicketIds.length > 0`: emit `run_summary` log, then reset all accumulators

```ts
logger.info({
  pipeline: "execution",
  event: "run_summary",
  ticketsCompleted: this.runTicketsCompleted,
  ticketsFailed: this.runTicketsFailed,
  ticketIds: this.runTicketIds,
  totalCostUsd: this.runTotalCost,
  totalDurationMs: Date.now() - this.runStartedAt.getTime(),
  averageCostPerTicket: this.runTotalCost / this.runTicketIds.length,
  averageDurationPerTicket: totalDurationMs / this.runTicketIds.length
}, `run_summary | ${completed} completed | ${failed} failed | $${cost} total | ${duration}`);
```

### Shutdown flush

**`flushRunSummary(reason: "idle" | "shutdown" | "once" = "idle"): void`**

- Public method on `ExecutionPipeline`
- If `runTicketIds.length === 0`: no-op
- Otherwise: emit the same `run_summary` log with an additional `reason` field
- Reset accumulators after emission

**Wiring in `src/orchestrator.ts`:**

In the existing SIGINT/SIGTERM handler, before process exit:
```ts
executionPipeline.flushRunSummary("shutdown");
```

### Tests

- 3 tickets completed then idle → rollup with correct totals
- Mix of completed and failed → both counts correct
- `flushRunSummary("shutdown")` emits rollup then resets (subsequent call is no-op)
- No tickets processed → no rollup emitted
- Averages computed correctly

---

## Phase 7 — Idle Polling Noise Suppression

### Instance state

```ts
private consecutiveEmptyPolls: number = 0;
```

### Logic in `runOnce()`

When tickets are found:
```ts
this.consecutiveEmptyPolls = 0;
```

When no tickets are found:
```ts
if (this.consecutiveEmptyPolls === 0) {
  logger.info({ ... event: "no_tickets" }, "no ready tickets");
} else if (this.consecutiveEmptyPolls % 10 === 9) {
  // Every 10th consecutive poll (0-indexed: 9, 19, 29...)
  logger.info({
    ...
    event: "idle_heartbeat",
    consecutiveEmptyPolls: this.consecutiveEmptyPolls + 1,
    idleSinceMs: (this.consecutiveEmptyPolls + 1) * pollIntervalMs
  }, `idle_heartbeat | no tickets for ${idleMinutes}m | polling continues`);
} else {
  logger.debug({ ... event: "no_tickets" }, "no ready tickets");
}
this.consecutiveEmptyPolls++;
```

### Tests

- First empty poll (counter=0) → INFO
- Polls 1–8 → DEBUG
- Poll 9 (10th total) → INFO idle_heartbeat
- Poll 10–18 → DEBUG
- Poll 19 (20th total) → INFO idle_heartbeat
- Tickets found → counter resets, next empty poll is INFO

---

## Dependency Graph

```
Phase 1 (types + helpers) ──┬──→ Phase 3 (log injections) ──→ Phase 5 (summary writer)
                            │                                         ↓
Phase 2 (diff stat I/O) ───┘                                  Phase 6 (run rollup)
                                                                      ↓
Phase 4 (cost accumulation) ──────────────────────────────→   Phase 7 (idle suppression)
```

- Phases 1 and 2 can run in parallel
- Phase 3 depends on 1 and 2
- Phase 4 is independent of 1/2/3 but feeds into 5 and 6
- Phase 5 depends on 3 and 4
- Phase 6 depends on 5 (uses the same cost totals)
- Phase 7 is standalone, no dependencies

---

## Acceptance Gates

After all phases, the following must pass:

1. `npm run typecheck` — no type errors from new types or modified signatures
2. `npm run lint` — no lint violations
3. `npm test` — all existing + new tests pass
4. Manual smoke test: run `harness start --project <path> --pipeline execution` against a project with ready tickets and verify:
   - All 6 log injection points emit visible output
   - `.harness/summaries/<ticketId>.json` files are written with valid content
   - Run summary emits on idle transition
   - Ctrl-C emits run summary
   - Idle polling suppresses noise after first empty poll