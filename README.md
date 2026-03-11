# Pipeline Orchestrator Harness

Deterministic TypeScript orchestrator for Plan Generation, Execution, and Adversarial pipelines. Sits above coding agents (Claude Code, Codex) and controls all routing, sequencing, retries, and lifecycle. Agents never decide what happens next — the harness state machine decides all transitions.


## The Full Execution Pipeline Flow

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



======
## NEXT STEPS 
-> FUNCTIONALITY DEPENDING ON TYPE OF PROJECT. So it can catch mistakes claude code makes. it is not just going to make typescript project, it could also make python project. Maybe ask user what type of project you want and then make rules based on that. 
-> ALSO I want it to beautiully show how much of the pipeline is pending. Is that possible?
--> Program the Codex SDK and claude code sdk.
--> Can you think of a more user Friendly CLI? THINK OF THIS VISION -> I should be able to look at my cli logs and be able to understand where it is in the list of tickets I gave it. I SHOULD BE ABLE TO GRASP - HEY I GAVE IT THE WRONG TICKET, HEY THIS TICKET WAS RIGHT. HEY I DONT LIKE THIS IMPLEMENTATION, LET'S MAKE IT RE-DO IT. WE WILL GET TO THAT VISION IN TIME BUT ATLEAST LET'S get started.
-> I think the problem is testing the changes. Unit test isnt enough - you have to run it to understand whether it did what you want it to.


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
