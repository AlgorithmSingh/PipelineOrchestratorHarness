# Pipeline Orchestrator Harness

Deterministic TypeScript orchestrator for Plan Generation, Execution, and Adversarial pipelines. Sits above coding agents (Claude Code, Codex) and controls all routing, sequencing, retries, and lifecycle. Agents never decide what happens next — the harness state machine decides all transitions.

## Prerequisites

- Node.js 18+
- [Beads CLI](https://github.com/steveyegge/beads) (`bd`) with Dolt backend
- At least one agent runtime: `claude` (Claude Code CLI) and/or `codex` (OpenAI Codex CLI)

## Quick Start

```bash
npm install
npm run typecheck
npm test
```

## Usage

The harness operates on a **target project** — any directory with a `.beads/` database initialized. The harness itself is a standalone tool you point at a project.

### Point at a project

```bash
# Check config
npm run dev -- --project /path/to/your-project status

# Validate config
npm run dev -- --project /path/to/your-project config validate
```

### Run the execution pipeline

```bash
# Single polling cycle (claim tickets, run agents, merge results)
npm run dev -- --project /path/to/your-project start --pipeline execution --once

# Continuous polling loop (Ctrl+C to stop)
npm run dev -- --project /path/to/your-project start --pipeline execution
```

If `--project` is omitted, the harness uses the current working directory.

### Create contracts in Beads

The harness polls for tickets labeled `pipeline:execution`. Create them with `bd`:

```bash
cd /path/to/your-project
bd create "Your task title" --type task --priority 1 \
  --labels "pipeline:execution" \
  --description "Precise implementation contract here..."
```

## Execution Pipeline Flow

For each ticket, the harness:

1. **Claims** the ticket in Beads
2. **Creates a git worktree** at `.harness/worktrees/<ticketId>` on branch `agent/<ticketId>`
3. **Runs setup commands** (e.g. `npm install`) in the worktree
4. **Spawns the coder agent** (Claude Code or Codex) with the contract as input
5. **Runs deterministic checks** (typecheck, lint) in the worktree
6. **Commits** changes and **merges** to the canonical branch
7. **Closes** the ticket in Beads and cleans up the worktree

If checks fail or merge conflicts occur, the ticket is reopened. Errors are logged and worktrees are cleaned up.

## Prompt Artifacts

Execution prompt capture is always on for planner, coder, and reviewer stages.

- Location: `.harness/prompts/<ticketId>/`
- Filename pattern: `<sequence>-attempt<attempt>-<stage>.json`
- Stages: `planner`, `coder`, `reviewer`

Each prompt artifact JSON contains:

- `ticketId`
- `stage`
- `attempt`
- `sequence`
- `runtime`
- `maxTurns`
- `maxBudgetUsd`
- `createdAt`
- `promptHashSha256`
- `prompt`

This data is local to the target project and is not pruned by default.

## Configuration

Config lives in `config/harness.yaml`. Override locally with `config/harness.local.yaml`.

Key settings:

```yaml
pipelines:
  execution:
    enabled: true
    maxParallelAgents: 1        # sequential by default for merge stability
    pollIntervalMs: 30000       # polling interval
    maxRetriesPerTicket: 3
    runtime: "claude-code"      # default agent
    fallbackRuntime: "codex"    # fallback if primary fails
    checks:                     # deterministic checks after agent runs
      - name: "TypeScript"
        command: "npm run typecheck"
      - name: "Lint"
        command: "npm run lint"
    worktreeSetup:              # commands to run in new worktrees
      - "npm install"
    coder:
      runtime: "claude-code"
      maxTurns: 50
      maxBudgetUsd: 5
```

## CLI Commands

| Command | Description |
|---|---|
| `start` | Start enabled pipelines |
| `start --pipeline <name>` | Run only one pipeline (`execution`, `plan`, `adversarial`) |
| `start --once` | Single polling cycle then exit |
| `init <path>` | Initialize target project (git + `.harness` + Beads) |
| `init <path> --beads-database <db>` | Initialize against an existing Dolt server database |
| `init <path> --beads-server-port <port>` | Force Beads to use a specific Dolt server port |
| `status` | Show config and enabled pipelines |
| `config validate` | Validate configuration |
| `plan <spec-file>` | Trigger plan generation (scaffolded) |
| `retry <ticket-id>` | Retry a failed ticket (scaffolded) |
| `abort <ticket-id>` | Abort and cleanup (scaffolded) |
| `metrics` | Print metrics (scaffolded) |

`harness init` is intentionally a thin wrapper around `bd init`. If Beads init fails, rerun with explicit DB/server settings:

```bash
harness init /path/to/project --beads-database <existing_database_name>
harness init /path/to/project --beads-server-host 127.0.0.1 --beads-server-port 3307
# or environment variables
BEADS_DATABASE=<existing_database_name> BEADS_SERVER_PORT=3307 harness init /path/to/project
```

If the error is `database not found`, the harness now auto-attempts:
1. create the missing database with `dolt sql`
2. retry `bd init` once with that database

## Architecture

```
harness (deterministic)
  ├── polls Beads for tickets
  ├── creates git worktrees per ticket
  ├── spawns agents (Claude Code / Codex) as black-box subprocesses
  ├── runs deterministic checks
  ├── merges results (serialized via semaphore)
  └── closes tickets

agents (non-deterministic)
  └── receive contract prompt, write code, run tests — no control flow decisions
```

## Development

```bash
npm run dev -- <command>     # run with tsx (no build)
npm run build                # compile to dist/
npm run typecheck            # type-check without emit
npm test                     # run vitest
npm run lint                 # biome lint
```

## The Experience, Deterministic State machine

# 1. Init a new project
harness init /path/to/my-project
# → creates dir, git init, bd init, .harness/ dirs, scaffold

# 2. Create tickets in Beads
cd /path/to/my-project
bd create "Build auth system" --labels "pipeline:execution" --description "contract..."

# 3. Start the harness — it does everything
harness start --project /path/to/my-project
The Full Execution Pipeline Flow

ticket queue → PLANNER → CODER → deterministic checks → REVIEWER
                  ↑                                        |
                  |                            pass → commit → merge → close
                  |                            fail ↓
                  |                         cascade check
                  |                        /            \
                  └── reinject (single)   HITL gate (multiple failures)
                                           |           |
                                         approve    abort → failed
What Needs To Be Built (5 phases)
Phase	What	Files
A	harness init command	Create src/commands/init.ts, modify src/index.ts, src/config.ts
B	Prompt builders per role	Create src/contracts/generator.ts — planner, coder, reviewer prompts
C	HITL gate	Create src/hitl/types.ts, gate.ts, notifier.ts
D	Wire state machine transitions	Refactor src/state/transitions.ts to factory with real actions, extend src/state/types.ts
E	Rewrite execution pipeline	State-machine-driven processTicket() in src/pipelines/execution.ts
The existing state machine, runtimes, worktree manager, merge coordinator, and Beads client are all already built — they just need to be plugged together.

Want me to start building? I'd go phase by phase so it stays compilable at each step.


# 
Here's a summary of everything that was built:

Phase A — harness init
src/commands/init.ts — Creates dir, git init, bd init, .harness/ dirs, default config, .gitignore
src/index.ts — Added init command
src/config.ts — Now also loads .harness/config.yaml from the target project
Phase B — Prompt Builders
src/contracts/generator.ts — buildPlannerPrompt(), buildCoderPrompt(), buildReviewerPrompt(), buildFailureContext()
Phase C — HITL Gate
src/hitl/types.ts — Request/response interfaces
src/hitl/gate.ts — Terminal-based blocking prompt with timeout
Phase D — State Machine
src/state/types.ts — Extended context with checksPassed, reviewOutput, mergeConflict, maxRetries, etc.
src/state/transitions.ts — Added checks→cascade, merge→cascade transitions; made retry guards use ctx.maxRetries
Phase E — Full Execution Pipeline
src/pipelines/execution.ts — State-machine-driven processTicket() with planner → coder → checks → reviewer → commit → merge → close, with cascade/reinject/HITL on failure
Now you can do:

npx harness init /path/to/project     # sets up everything
# create tickets with bd
npx harness start --project /path/to/project --pipeline execution


### UI Modes

`harness start` now supports `--ui auto|dashboard|logs`:

- `auto` (default): uses interactive dashboard when running in a TTY, otherwise falls back to logs.
- `dashboard`: forces interactive tree UI (falls back to logs on non-TTY).
- `logs`: classic log output only.

In dashboard mode:

- Queue progress is shown per pipeline (`ready/running/completed/failed/pending`).
- Execution tickets show stage checklist progress and expandable agent activity nodes.
- Full NDJSON logs are written to `.harness/logs/harness-<timestamp>.ndjson`.
- Keyboard:
  - `up/down`: move selection
  - `enter`: toggle expand/collapse
  - `left/right`: collapse/expand selected node
  - `e`: expand all
  - `c`: collapse all
  - `Ctrl+C`: stop

ps aux | grep claude

LOG_LEVEL=debug npx harness start --project /Users/ankitsingh/Documents/dev/HARNESS/to-do-list-4 --pipeline execution


======
## NEXT STEPS 
-> FUNCTIONALITY DEPENDING ON TYPE OF PROJECT. So it can catch mistakes claude code makes. it is not just going to make typescript project, it could also make python project. Maybe ask user what type of project you want and then make rules based on that. 
-> ALSO I want it to beautiully show how much of the pipeline is pending. Is that possible?
--> Program the Codex SDK and claude code sdk.
--> Can you think of a more user Friendly CLI? THINK OF THIS VISION -> I should be able to look at my cli logs and be able to understand where it is in the list of tickets I gave it. I SHOULD BE ABLE TO GRASP - HEY I GAVE IT THE WRONG TICKET, HEY THIS TICKET WAS RIGHT. HEY I DONT LIKE THIS IMPLEMENTATION, LET'S MAKE IT RE-DO IT. WE WILL GET TO THAT VISION IN TIME BUT ATLEAST LET'S get started.


### COMMANDS
npx npm run build

npx harness init /Users/ankitsingh/Documents/dev/HARNESS/todolist14 \
  --check "Typecheck=npm run typecheck" \
  --check "Lint=npm run lint" \
  --check "Tests=npm test"

npx harness start --project /Users/ankitsingh/Documents/dev/HARNESS/todolist14 --pipeline execution

```bash
npm run dev -- <command>     # run with tsx (no build)
npm run build                # compile to dist/
npm run typecheck            # type-check without emit
npm test                     # run vitest
npm run lint                 # biome lint
```
