# Pipeline Orchestrator Harness - Technical Specification

Generated: 2026-03-09  
Status: Canonical spec for implementation

## 1. Overview

Pipeline Orchestrator Harness is a deterministic TypeScript orchestrator that drives three concurrent pipelines for agentic software development:

- Plan Generation pipeline (sequential)
- Execution pipeline (parallel)
- Adversarial pipeline (parallel, continuous)

The harness sits above coding agents (Claude Code, Codex) and Beads (`bd`) and controls all routing, sequencing, retries, escalation, and lifecycle operations.

Core principle:

- Agents never decide what happens next.
- The harness state machine decides all transitions.

## 2. Runtime and Platform Decisions

- Runtime: Node.js (not Bun)
- Language: TypeScript (ESM)
- Process execution: `execa`
- State persistence: JSON files under `.harness/state/`
- Coordination system: Beads CLI (`bd --json`)
- Isolation model: one git worktree per active ticket
- Default post-review integration: direct merge
- PR creation: optional, configuration-gated
- v1 delivery mode: execution-first; plan/adversarial pipeline can be feature-flagged

## 3. High-Level Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ HARNESS (TypeScript, Node.js)                               │
│                                                              │
│  ┌────────────────┐ ┌──────────────┐ ┌────────────────────┐  │
│  │ Plan Generation│ │  Execution   │ │   Adversarial      │  │
│  │   Pipeline     │ │  Pipeline    │ │   Pipeline         │  │
│  └───────┬────────┘ └──────┬───────┘ └─────────┬──────────┘  │
│          │                 │                    │             │
│  ┌───────┴─────────────────┴────────────────────┴──────────┐  │
│  │            Deterministic State Machine                   │  │
│  └───────┬─────────────────┬────────────────────┬──────────┘  │
│          │                 │                    │             │
│  ┌───────┴──────────────────────────────────────────────────┐  │
│  │ Beads (`bd --json`)                                      │  │
│  │ Ticket queue + dependency graph                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ AgentRuntime abstraction                                 │  │
│  │  - Claude Code runtime                                   │  │
│  │  - Codex runtime                                         │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Git worktrees + serialized merge coordinator             │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 4. Project Structure

```text
PipelineOrchestratorHarness/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── errors.ts
│   ├── orchestrator.ts
│   ├── types.ts
│   ├── runtime/
│   │   ├── types.ts
│   │   ├── claude-code.ts
│   │   ├── codex.ts
│   │   └── router.ts
│   ├── pipelines/
│   │   ├── execution.ts
│   │   ├── plan-generation.ts
│   │   └── adversarial.ts
│   ├── state/
│   │   ├── types.ts
│   │   ├── transitions.ts
│   │   └── machine.ts
│   ├── beads/
│   │   ├── types.ts
│   │   └── client.ts
│   ├── git/
│   │   ├── worktree.ts
│   │   └── merge.ts
│   ├── contracts/
│   │   ├── generator.ts
│   │   └── templates/
│   ├── hitl/
│   │   ├── gate.ts
│   │   └── notifier.ts
│   ├── util/
│   │   ├── logger.ts
│   │   ├── semaphore.ts
│   │   ├── cost.ts
│   │   └── metrics.ts
│   └── commands/
│       ├── start.ts
│       ├── stop.ts
│       ├── status.ts
│       ├── plan.ts
│       ├── retry.ts
│       ├── abort.ts
│       ├── metrics.ts
│       └── config.ts
├── contracts/
│   ├── coder.md
│   ├── reviewer.md
│   ├── planner.md
│   ├── bug-finder.md
│   ├── adversarial-refuter.md
│   └── referee.md
├── config/
│   └── harness.yaml
├── package.json
├── tsconfig.json
└── README.md
```

## 5. Agent Runtime Abstraction

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
  exitReason: "completed" | "max_turns" | "max_budget" | "error";
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
}

export interface AgentRuntime {
  readonly name: string;
  execute(prompt: string, config: AgentRuntimeConfig): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
  costPer1kInput(): number;
}
```

Notes:

- This is SDK/programmatic oriented, not tmux-TUI oriented.
- Each `execute()` call starts a fresh bounded session.
- Runtime router supports default, role override, retries, fallback, and health filtering.

## 6. Beads Integration

`src/beads/client.ts` wraps `bd` with `--json` and typed parsing.

Required methods:

- `ready(filter?)`
- `create(opts)`
- `claim(ticketId, agent)`
- `update(ticketId, updates)`
- `close(ticketId, resolution)`
- `get(ticketId)`
- `list(filter?)`
- `addDependency(from, to, "blocks")`
- `checkCycles()`

Ticket metadata labels:

- `pipeline:plan`
- `pipeline:execution`
- `pipeline:adversarial`
- `role:planner`, `role:coder`, `role:reviewer`
- `needs-human`
- `retry:N`
- `cascade-risk`

## 7. Git Worktrees and Merge Coordination

Worktree rules:

- Path: `.harness/worktrees/<ticket-id>/`
- Branch: `agent/<ticket-id>`
- One active ticket maps to one isolated worktree

Worktree manager methods:

- `create(ticketId)`
- `cleanup(ticketId)`
- `list()`
- `setup(ticketId, commands[])`

Merge coordinator requirements:

- `dryRun(ticketId)` for conflict prediction
- `merge(ticketId)` for actual merge
- global serialization queue/lock so only one merge executes at a time
- on conflict:
  - abort merge
  - return conflict list
  - escalate to HITL

Safety:

- never force-push
- never rewrite branch history

## 8. State Machine

Pipeline state unions:

- Plan states: `plan:*`
- Execution states: `exec:*`
- Adversarial states: `adv:*`

Core properties:

- all transitions are explicitly declared
- transition validation rejects undeclared transitions
- per-ticket persisted state file:
  - `.harness/state/<ticket-id>.json`
- persist after every transition
- history appended on every transition (`from`, `to`, timestamp)
- transition hooks emit structured events for logs/metrics

Idempotency requirement:

- transition actions must be idempotent
- persisted operation markers prevent duplicate side effects after crash replay (e.g. duplicate claim/commit/close)

Crash recovery:

- on startup, scan state dir for incomplete tickets
- deterministic states resume in place
- agent-execution states restart from beginning of that state with fresh session
- worktrees and Beads state remain source of truth

## 9. Pipelines

### 9.1 Plan Generation Pipeline

Flow:

`ANALYZE_CODEBASE -> GENERATE_SPECS -> HITL_REVIEW -> CREATE_TICKETS`

Behavior:

- sequential
- generates structured contract JSON
- supports iterative reject/edit cycles
- creates Beads tickets and dependencies for approved contracts

### 9.2 Execution Pipeline

Flow:

`PULL_TICKET -> CLAIM -> GENERATE_CONTRACT -> EXECUTE_CODE -> DETERMINISTIC_CHECKS -> AGENT_REVIEW -> (PASS path | FAIL path)`

PASS path (default):

`COMMIT -> MERGE -> CLOSE_TICKET -> COMPLETED`

Optional PR mode:

`COMMIT -> CREATE_PR -> MERGE -> CLOSE_TICKET`

FAIL path:

`CASCADE_CHECK -> (REINJECT or HITL_GATE)`

Rules:

- deterministic checks are harness-run, not AI-judged
- retries bounded by config (`maxRetriesPerTicket`)
- cascade risk triggers immediate HITL escalation
- per-ticket execution is isolated in its own worktree/session

### 9.3 Adversarial Pipeline

Flow:

`SELECT_TARGET -> BUG_FINDER -> ADVERSARIAL_DISPROVE -> REFEREE_VERDICT -> (CREATE_TICKET | LOG_DISMISSED)`

Rules:

- bug finder is high-recall by design (aggressiveness configurable)
- adversarial refuter attempts to disprove each claim
- referee resolves surviving claims using deterministic scenario input from harness
- verified bugs become execution tickets

## 10. HITL Gates

Interface:

```ts
interface HITLRequest {
  type: "plan_review" | "cascade_failure" | "merge_conflict" | "max_retries";
  ticketId?: string;
  summary: string;
  contractJson?: string;
  failureContext?: string;
  downstreamTickets?: string[];
}

interface HITLResponse {
  decision: "approve" | "edit" | "reject" | "abort";
  editedContract?: string;
  humanNotes?: string;
}
```

v1 implementation:

- terminal-first
- blocking wait with timeout
- optional notifier hook (terminal/webhook/slack adapter model)

## 11. Logging and Metrics

Logging:

- JSON logs to stdout
- fields: timestamp, level, pipeline, ticketId, state, event, durationMs, tokenUsage, costUsd

Metrics:

- append-only JSONL at `.harness/metrics.jsonl`
- track:
  - per-ticket time/cost/retries/result
  - per-pipeline throughput/failure rate/avg cost
  - per-runtime success/latency/cost
  - adversarial precision/false positives/cost per verified bug

## 12. Steering File

`.harness/STEERING.md` is watched continuously.

On change:

- parse directives (`pipeline`, `ticket`, `message`)
- apply to next relevant agent session system prompt
- log application
- rename to `STEERING.md.applied.<timestamp>`

## 13. CLI Surface

```text
harness start
harness start --pipeline exec
harness stop
harness status
harness plan <spec-file>
harness retry <ticket-id>
harness abort <ticket-id>
harness metrics
harness config validate
```

## 14. Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@openai/codex-sdk": "latest",
    "execa": "^9.0.0",
    "yaml": "^2.0.0",
    "commander": "^12.0.0",
    "chokidar": "^4.0.0",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.0.0",
    "@types/node": "^22.0.0",
    "vitest": "^2.0.0"
  }
}
```

## 15. Implementation Plan (Reviewed, Execution-First)

### Phase 1: Foundation

1. Scaffold `package.json`, `tsconfig.json`, `.gitignore`
2. Add `src/errors.ts`, `src/util/logger.ts`, `src/util/semaphore.ts`
3. Add `src/config.ts` + `config/harness.yaml` with strict defaults

### Phase 2: Core Infrastructure

1. Implement state types + transition tables + machine + persistence + recovery
2. Implement runtime adapters (Claude, Codex) and runtime router
3. Implement Beads client
4. Implement worktree manager and merge coordinator with serialized merge lock/queue

### Phase 3: Execution Pipeline

1. Contract generation/compression subsystem and templates
2. HITL gate + notifier
3. Single-ticket execution state flow end-to-end
4. Deterministic checks + reviewer stage + commit/merge/close
5. Retry/cascade routing with escalation
6. Cost and metrics integration

### Phase 4: Parallel Orchestration

1. Add orchestrator loop + semaphore fan-out
2. Add startup crash-recovery scan and resume logic
3. Add graceful shutdown semantics

### Phase 5: Additional Pipelines

1. Plan generation pipeline implementation
2. Adversarial pipeline implementation
3. Keep both feature-flag controlled until stable

### Phase 6: CLI and Steering

1. Commander entrypoint + command modules
2. Steering watcher integration
3. Status/metrics surfaces

## 16. Test Strategy

Unit tests:

- state transition allow/deny
- idempotent replay behavior
- Beads JSON parsing and normalization
- runtime router fallback behavior
- semaphore behavior

Integration tests:

- full single-ticket execution with mock runtimes + real git/fs
- multi-ticket parallel execution with serialized merge coordinator

Recovery tests:

- crash in each execution state then restart and verify correct resume without duplicate side effects

## 17. Non-Goals

- web dashboard
- cloud/k8s deployment
- multi-repo orchestration
- direct agent-to-agent messaging
- custom LLM runtime integrations beyond Claude Code and Codex in v1

## 18. Decision Log

- Node.js + npm + tsx selected
- Codex TS SDK selected as primary integration mode
- Direct merge is default; PR flow optional via config
- Execution-first implementation order selected

