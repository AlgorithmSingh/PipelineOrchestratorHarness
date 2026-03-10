# Pipeline Orchestrator Harness - Technical Specification

Verified against repository state: 2026-03-10

Status: Current-state implementation spec

## Summary

Pipeline Orchestrator Harness is a TypeScript CLI that coordinates agent-driven software work over a target project that has Beads initialized. The current repository implements the execution pipeline end to end and includes scaffolded placeholders for the plan-generation and adversarial pipelines.

This document describes the repository as it exists today. Planned features remain documented, but they are explicitly marked as scaffolded or not yet wired.

## Status Legend

- `Implemented`: exercised by current code paths
- `Scaffolded`: types, config, or placeholder classes exist, but the behavior is not end to end
- `Not wired / future work`: mentioned by config or helper code, but not connected to the active pipeline flow

## Current Implementation Status

| Area | Status | Notes |
|---|---|---|
| CLI entrypoint and config loading | Implemented | `src/index.ts`, `src/config.ts` |
| Project initialization | Implemented | `harness init` sets up git, `.harness`, and Beads |
| Execution pipeline | Implemented | Planner -> coder -> checks -> reviewer -> commit -> merge/close |
| Plan-generation pipeline | Scaffolded | `runOnce()` logs a placeholder event |
| Adversarial pipeline | Scaffolded | `runOnce()` logs a placeholder event |
| State machine persistence | Implemented | State JSON persists on transitions and context replacement |
| Startup resume / crash recovery orchestration | Not wired / future work | `StateMachine.restore()` exists, but orchestrator startup does not scan and resume persisted tickets |
| Runtime router and fallback policy | Not wired / future work | `src/runtime/router.ts` exists, but execution flow uses direct runtime lookup |
| PR creation flow | Scaffolded | `exec:create_pr` currently falls through to merge without external PR creation |
| HITL terminal gate | Implemented | Terminal prompt with timeout |
| Webhook/Slack HITL notifications | Not wired / future work | Config enums exist; no adapter implementation |
| Metrics append utility | Not wired / future work | `src/util/metrics.ts` exists; metrics command is scaffolded |
| Steering file / file watching | Not wired / future work | No `STEERING.md` watcher implementation in this repo |

## Repository Layout

```text
PipelineOrchestratorHarness/
├── config/
│   └── harness.yaml
├── package.json
├── package-lock.json
├── README.md
├── TECHNICAL_SPEC.md
├── InteractivePipelineProgress.md
├── tsconfig.json
└── src/
    ├── beads/
    │   ├── client.ts
    │   └── types.ts
    ├── commands/
    │   └── init.ts
    ├── contracts/
    │   └── generator.ts
    ├── git/
    │   ├── merge.ts
    │   └── worktree.ts
    ├── hitl/
    │   ├── gate.ts
    │   └── types.ts
    ├── pipelines/
    │   ├── adversarial.ts
    │   ├── execution.ts
    │   └── plan-generation.ts
    ├── runtime/
    │   ├── claude-code.test.ts
    │   ├── claude-code.ts
    │   ├── codex.ts
    │   ├── router.ts
    │   └── types.ts
    ├── state/
    │   ├── machine.test.ts
    │   ├── machine.ts
    │   ├── transitions.ts
    │   └── types.ts
    ├── util/
    │   ├── cost.ts
    │   ├── logger.ts
    │   ├── metrics.ts
    │   ├── semaphore.test.ts
    │   └── semaphore.ts
    ├── config.test.ts
    ├── config.ts
    ├── errors.ts
    ├── index.ts
    ├── orchestrator.ts
    └── types.ts
```

## Runtime and Platform Decisions

- Runtime: Node.js
- Language: TypeScript with ESM modules
- CLI parser: `commander`
- Process execution: `execa`
- Logging: `pino`
- Config format: YAML
- Test runner: `vitest`
- Agent runtimes currently supported: Claude Code CLI and Codex CLI
- Coordination backend: Beads CLI (`bd`)

## Architecture

### Top-level flow

`harness start` creates a `HarnessOrchestrator`, loads configuration, and enters a polling loop. The orchestrator calls enabled pipelines once per cycle. This is currently sequential at the orchestrator level; only the execution pipeline performs bounded parallel ticket processing internally.

```text
harness CLI
  -> loadConfig()
  -> HarnessOrchestrator
       -> ExecutionPipeline.runOnce()      [implemented]
       -> PlanGenerationPipeline.runOnce() [placeholder]
       -> AdversarialPipeline.runOnce()    [placeholder]
```

### Execution pipeline

The execution pipeline is the only pipeline with real task-processing behavior today.

High-level flow:

```text
pull_ticket
  -> claim
  -> generate_contract
  -> execute_code
  -> deterministic_checks
  -> agent_review
  -> commit
  -> create_pr | merge
  -> close_ticket
  -> completed

Failure path:
deterministic_checks | agent_review | merge
  -> cascade_check
  -> reinject | hitl_gate
  -> generate_contract | failed
```

Key components used by execution:

- `BeadsClient`: polls ready tickets, claims, updates, and closes tickets
- `WorktreeManager`: creates one git worktree per active ticket under `.harness/worktrees/<ticketId>`
- `MergeCoordinator`: serializes merges into the canonical branch
- `StateMachine`: persists per-ticket state to `.harness/state/<ticketId>.json`
- `ClaudeCodeRuntime` / `CodexRuntime`: execute the planner, coder, and reviewer agents
- `HITLGate`: blocks for terminal input when retries are exhausted

### Plan and adversarial pipelines

- `PlanGenerationPipeline`: currently logs `plan_pipeline_placeholder`
- `AdversarialPipeline`: currently logs `adversarial_pipeline_placeholder`

The state types and transition tables for both pipelines exist, but there is no end-to-end ticket orchestration behind them yet.

## CLI Surface

Implemented commands in `src/index.ts`:

```text
harness --project <path> start [--pipeline execution|plan|adversarial] [--once]
harness --project <path> status
harness --project <path> config validate
harness init <path> [--beads-prefix <prefix>] [--beads-database <database>] [--beads-server-host <host>] [--beads-server-port <port>]
```

Scaffolded commands in `src/index.ts`:

```text
harness plan <spec-file>
harness retry <ticket-id>
harness abort <ticket-id>
harness metrics
```

Notes:

- There is no standalone `harness stop` command. Shutdown is handled by `SIGINT` / `SIGTERM`.
- The accepted `--pipeline` values are `execution`, `plan`, and `adversarial`.
- `status` prints a JSON summary of project paths, enabled pipelines, and configured runtime defaults.
- `config validate` validates config loading and prints a success message if parsing and validation pass.

## Configuration Model

### Load order

`loadConfig()` merges configuration in this order:

1. `DEFAULT_CONFIG` from `src/config.ts`
2. repository-level `config/harness.yaml` if present
3. target project `.harness/config.yaml` if `--project` points to a project with one
4. repository-level `config/harness.local.yaml` if present

After merging, project-relative paths are resolved to absolute paths under the effective project root, and the worktree, state, and log directories are created if missing.

### Current config shape

`HarnessConfig` currently contains:

- `project`
  - `name`
  - `root`
  - `worktreeDir`
  - `stateDir`
  - `logDir`
  - `canonicalBranch`
- `pipelines.planGeneration`
  - `enabled`
  - `runtime`
  - `model`
- `pipelines.execution`
  - `enabled`
  - `maxParallelAgents`
  - `pollIntervalMs`
  - `maxRetriesPerTicket`
  - `runtime`
  - `fallbackRuntime`
  - `maxRetriesBeforeFallback`
  - `mergeMode`
  - `checks`
  - `worktreeSetup`
  - `planner`
  - `coder`
  - `reviewer`
  - `streamAgentOutput?`
- `pipelines.adversarial`
  - `enabled`
  - `pollIntervalMs`
  - `maxParallelTargets`
  - `targetStrategy`
  - `targetsPerRun`
  - `bugFinder`
  - `adversarialRefuter`
  - `referee`
- `runtimes`
- `hitl`

### Effective defaults and checked-in values

Defaults in `DEFAULT_CONFIG`:

- execution pipeline enabled
- plan-generation pipeline disabled
- adversarial pipeline disabled
- direct merge mode
- execution checks default to:
  - `npm run typecheck`
  - `npm run lint`
- worktree setup default:
  - `[ -f package.json ] && npm install || true`

Checked-in repository config in `config/harness.yaml` currently sets:

- `pipelines.execution.enabled: true`
- `pipelines.planGeneration.enabled: false`
- `pipelines.adversarial.enabled: false`
- `pipelines.execution.mergeMode: direct`
- `pipelines.execution.streamAgentOutput: true`

Important configuration nuance:

- `harness init` writes a project-local `.harness/config.yaml` with `checks: []`
- the repository-level checked-in config contains TypeScript and lint checks
- because the project-local config overrides the harness config, the effective checks for an initialized target project depend on that local file

## Runtime Contract

The runtime abstraction in `src/runtime/types.ts` is:

```ts
export interface AgentResult {
  passed: boolean;
  output: Record<string, unknown>;
  rawOutput: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  exitReason: "completed" | "max_turns" | "max_budget" | "error" | "aborted";
  error?: string;
  durationMs: number;
}

export interface AgentRuntimeConfig {
  cwd: string;
  systemPrompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  logger?: import("pino").Logger;
  streamOutput?: boolean;
}

export interface AgentRuntime {
  readonly name: string;
  execute(prompt: string, config: AgentRuntimeConfig): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
  costPer1kInput(): number;
}
```

### Runtime adapters

`ClaudeCodeRuntime`:

- runs `claude -p --dangerously-skip-permissions --max-turns <N>`
- optionally adds `--output-format stream-json --verbose` when `streamOutput` is enabled
- strips Claude-specific environment variables before invocation to avoid nested-session issues
- supports cancellation through `config.signal`
- reports `aborted` when the subprocess is interrupted or the abort signal fires

`CodexRuntime`:

- runs `codex exec --full-auto --sandbox workspace-write <prompt>`
- attempts to parse JSON output but otherwise returns plain text output
- does not currently apply `maxTurns`, `maxBudgetUsd`, or streaming behavior in the CLI invocation

### Runtime routing status

`src/runtime/router.ts` provides a `RuntimeRouter` with health checking, role overrides, retry-before-fallback behavior, and fallback execution. That utility is present, but the current execution pipeline does not use it. Instead, `ExecutionPipeline` instantiates Claude and Codex directly and selects runtimes from the per-role config (`planner.runtime`, `coder.runtime`, `reviewer.runtime`).

As a result, these execution config fields exist but are not currently part of the active runtime flow:

- `pipelines.execution.runtime`
- `pipelines.execution.fallbackRuntime`
- `pipelines.execution.maxRetriesBeforeFallback`

## State Model

### Persisted state behavior

`StateMachine` persists ticket state to `.harness/state/<stateId>.json` after:

- every successful transition
- every `replaceContext()` call

Persisted state contains:

- `currentState`
- `context`
- `history`
- `updatedAt`

`StateMachine.restore()` is implemented, but orchestrator startup does not yet use it for recovery.

### Pipeline state unions

Plan states:

```text
plan:analyze_codebase
plan:generate_specs
plan:hitl_review
plan:create_tickets
plan:completed
```

Execution states:

```text
exec:pull_ticket
exec:claim
exec:generate_contract
exec:execute_code
exec:deterministic_checks
exec:agent_review
exec:commit
exec:create_pr
exec:merge
exec:close_ticket
exec:cascade_check
exec:reinject
exec:hitl_gate
exec:completed
exec:failed
```

Adversarial states:

```text
adv:select_target
adv:bug_finder
adv:adversarial_disprove
adv:referee_verdict
adv:create_ticket
adv:log_dismissed
adv:completed
```

`src/state/transitions.ts` enforces explicit allowlisted transitions for all three pipelines. The execution transition table is actively used. Plan and adversarial transition tables exist but are only paired with placeholder pipeline classes today.

## Execution Pipeline Behavior

### Ticket intake

- Beads CLI availability is checked before polling
- ready tickets are fetched via `bd ready --json --label pipeline:execution`
- at most `maxParallelAgents` tickets are selected per run
- each selected ticket is processed under a semaphore

### Per-ticket setup

Initial execution context contains:

- `ticketId`
- `retryCount: 0`
- `maxRetries`
- `mergeMode`
- `contractJson`, sourced from ticket description or title

For each ticket, the pipeline:

1. transitions `exec:pull_ticket -> exec:claim`
2. claims the ticket in Beads
3. transitions to `exec:generate_contract`
4. creates a worktree at `.harness/worktrees/<ticketId>` on branch `agent/<ticketId>`
5. stores worktree path and branch in state context
6. runs configured worktree setup commands

### Agent stages

Planner stage:

- prompt built by `buildPlannerPrompt()`
- runtime selected from `pipelines.execution.planner.runtime`
- planner output stored as `plannerOutput`

Coder stage:

- prompt built by `buildCoderPrompt(contract, plannerOutput)`
- runtime selected from `pipelines.execution.coder.runtime`
- raw result stored as `agentResult`

Reviewer stage:

- prompt built by `buildReviewerPrompt(contract, plannerOutput)`
- runtime selected from `pipelines.execution.reviewer.runtime`
- reviewer output is parsed as JSON and treated as pass only when `verdict === "pass"`
- if parsing fails, the current implementation defaults the reviewer verdict to pass

### Deterministic checks

- each configured check is executed with `sh -c <command>` in the ticket worktree
- results are stored as `checksResults`
- `checksPassed` is `true` only when every configured check passes

Failure handling from checks, reviewer, and merge:

- increments `retryCount`
- builds `failureContext` using `buildFailureContext()`
- transitions to `exec:cascade_check`

### Commit and merge

Commit behavior:

- if the worktree has no changes, the ticket is closed with reason `No changes produced by agent` and the state is advanced to completion
- otherwise the pipeline stages all files and creates a local commit:
  - `feat: <ticket title>`
  - `Ticket: <ticket id>`

Merge behavior:

- `MergeCoordinator` serializes merges with a process-level semaphore of size 1
- the current implementation merges directly into the configured canonical branch
- on merge conflict, the merge is aborted, conflicting files are collected, and the ticket enters cascade handling

PR mode behavior:

- `exec:create_pr` exists in the state graph
- current implementation does not create an external pull request
- the state immediately transitions from `exec:create_pr` to `exec:merge`

### HITL gate

The terminal HITL request/response contract in `src/hitl/types.ts` is:

```ts
export interface HITLRequest {
  type: "cascade_failure" | "merge_conflict" | "max_retries";
  ticketId: string;
  summary: string;
  retryCount: number;
  contractJson?: string;
  failureContext?: string;
}

export interface HITLResponse {
  decision: "approve" | "edit" | "reject" | "abort";
  editedContract?: string;
  humanNotes?: string;
}
```

Current behavior:

- when retries reach `maxRetries`, the terminal prompts for a decision
- `approve` and `edit` send the ticket back to `exec:generate_contract`
- `reject` and `abort` reopen the Beads ticket state to `open`, clean up the worktree, and mark the execution state as `exec:failed`

Note: `editedContract` exists in the type, but the current gate implementation only collects human notes and does not replace the contract body directly.

## Git and Beads Integration

### Beads client

`src/beads/client.ts` wraps `bd` and provides:

- `healthCheck()`
- `ready(filter?)`
- `create(opts)`
- `claim(ticketId, agent)`
- `update(ticketId, updates)`
- `close(ticketId, resolution)`
- `get(ticketId)`
- `list(filter?)`
- `addDependency(from, to, "blocks")`
- `checkCycles()`

Current execution flow actively uses:

- `healthCheck()`
- `ready()`
- `claim()`
- `update()` in the failed HITL path
- `close()`

### Worktree manager

`WorktreeManager` currently provides:

- `create(ticketId)`
- `setup(ticketId, commands)`
- `list()`
- `cleanup(ticketId)`
- `isBranchMerged(branch)`

Only `create()`, `setup()`, and `cleanup()` are used by the execution pipeline today.

### Merge coordinator

`MergeCoordinator` currently provides:

- `dryRun(branch)`
- `merge(branch)`

Only `merge(branch)` is used by the execution pipeline today.

## Logging, Metrics, and Tests

### Logging

Logging is implemented with `pino`:

- default level comes from `LOG_LEVEL` or falls back to `info`
- pretty output is used when stdout is a TTY and `LOG_FORMAT` is not `json`
- otherwise logs are emitted as structured JSON

Current logging reality:

- logs go to stdout/stderr
- `.harness/logs` is created by config/init flows, but no file log sink is wired in this repo today

### Metrics

`src/util/metrics.ts` can append JSONL metrics to a file path, and `src/util/cost.ts` can estimate cost from token counts. These helpers are not wired into the active execution flow, and the `metrics` CLI command is currently scaffolded only.

### Existing automated tests

The current test suite covers:

- `src/config.test.ts`
  - default pipeline enablement and merge mode
- `src/state/machine.test.ts`
  - valid transition persistence
  - invalid transition rejection
- `src/util/semaphore.test.ts`
  - acquire/release and waiter queuing
- `src/runtime/claude-code.test.ts`
  - streaming flags
  - stream-json result extraction
  - concise progress rendering
  - non-streaming behavior

## Scaffolded / Not Yet Implemented

The following surfaces exist but are not complete end to end:

- full plan-generation pipeline behavior beyond placeholder logging
- full adversarial pipeline behavior beyond placeholder logging
- startup recovery that scans persisted state files and resumes incomplete tickets
- runtime router integration for health-aware fallback execution
- external PR creation for `mergeMode: "pr"`
- webhook or Slack-backed HITL notifications
- file-based steering input and watch/reload behavior
- metrics emission and reporting wired into runtime and pipeline execution
- richer dashboard or progress UI described in separate planning notes

## Known Gaps / Next Work

1. Implement the full plan-generation pipeline behind `PlanGenerationPipeline.runOnce()`.
2. Implement the full adversarial pipeline behind `AdversarialPipeline.runOnce()`.
3. Replace direct runtime lookup in `ExecutionPipeline` with `RuntimeRouter` so fallback and retry policy are actually honored.
4. Wire runtime token usage, cost estimation, and metrics appenders into planner/coder/reviewer execution.
5. Add a real PR creation path for `mergeMode: "pr"` instead of immediately falling through to merge.
6. Implement startup scanning and deterministic recovery using persisted state files and `StateMachine.restore()`.
7. Add steering-file support if external operator guidance is still a requirement.
8. Decide whether reviewer JSON parse failure should continue to default to pass; this is permissive behavior in the current implementation.
9. Decide whether `harness init` should generate project-local check commands or keep leaving `checks: []` for manual project customization.

