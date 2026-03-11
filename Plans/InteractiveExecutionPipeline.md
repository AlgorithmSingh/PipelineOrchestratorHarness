# Interactive Execution UI (`pretty|json`) — Decision-Complete Plan

## Summary
- Implement two output modes for `harness start`: `--ui pretty|json`.
- Default mode is `pretty` when `stdout` is a TTY, otherwise `json`.
- In `pretty`, terminal becomes a live dashboard (sticky header + scrolling human log); structured logs are still produced but written to a file sink only.
- In `json`, keep machine-parseable pino output to stdout and no ANSI UI behavior.

## Key Implementation Changes
- CLI/bootstrap: add `--ui <pretty|json>` to `start`, resolve default from `process.stdout.isTTY`, and pass resolved mode into orchestrator/pipeline/runtime wiring.
- Logging behavior: make logger creation mode-aware so `pretty` writes NDJSON to `.harness/logs/harness-<timestamp>.ndjson` and does not print pino logs to terminal; `json` keeps stdout structured logs.
- New UI subsystem: add `action-formatter`, `log-formatter`, and `renderer` modules with the specified `TerminalRenderer` API and display state types.
- Sticky header rendering: show project, progress bar, completed/failed counts, total cost, elapsed time, ticket rows with status glyphs, and one active-detail row.
- Parallel active handling: for `maxParallelAgents > 1`, show one focused active ticket plus `+N active` indicator.
- Compact rendering: if terminal width `<80`, collapse rows to short format while preserving active detail + last action.
- Runtime action feed: extend runtime config with `onAction` callback, parse Claude stream-json tool events into human-readable action strings, and emit them to renderer.
- Claude stream behavior: in `pretty`, force streaming on for planner/coder/reviewer and suppress existing `[claude] ...` terminal stream lines to avoid dashboard corruption.
- Codex behavior: implement best-effort fallback actions (coarse start/completed/error, structured parsing only if JSON lines are present).
- Execution pipeline integration: inject optional renderer, update ticket display status/stage at each state boundary, feed stage summaries into scrolling log formatter, wire retry/HITL/terminal outcomes into UI updates.
- HITL behavior: pause renderer before human prompt, resume after response, and keep HITL text in scrolling zone.
- Stage log content: include plan summary, coder diff summary, deterministic checks with failure tail lines, reviewer verdict, merge/fail summary, and prompt artifact references.
- Documentation: replace stale README UI section with actual `pretty|json` behavior, log file path, fallback behavior, and current Codex action-feed limitation.

## Public Interfaces / Type Changes
- Add `UiMode = "pretty" | "json"` for CLI/orchestrator/runtime plumbing.
- Add UI state interfaces for tickets and run display (`TicketDisplayState`, `RunDisplayState`) and stage display enum.
- Extend `AgentRuntimeConfig` with `onAction?: (action: string) => void` and a stream render policy used to silence runtime stderr output in `pretty`.
- Keep execution state-machine transitions and ticket summary schema unchanged; pretty UI reads existing summary/check/prompt-artifact data.

## Test Plan
1. Action formatter unit tests for Claude tool events (`Bash`, `Write`, `Edit`, `Read`, `Glob/Find`, `Agent`) including truncation and missing-field fallback.
2. Claude runtime tests verifying `onAction` callbacks fire from stream-json events and stderr stream rendering is suppressed in `pretty`.
3. Codex runtime fallback tests verifying coarse action emission without requiring structured tool events.
4. Log formatter unit tests for stage blocks, check pass/fail blocks (including tail output), retry blocks, ticket dividers, and compact-width formatting.
5. Renderer unit tests using a fake writable stream for sticky redraw behavior, status transitions, focused-active behavior, pause/resume, and final-summary rendering.
6. Execution pipeline tests verifying renderer updates at planner/coder/check/reviewer/merge boundaries, retry transitions, HITL pause/resume, and last-action propagation.
7. CLI/logging integration tests verifying `--ui pretty` creates NDJSON file sink with no terminal pino noise, `--ui json` keeps stdout JSON logs, and mode auto-detection follows TTY.
8. Regression run of existing config/runtime/execution suites to confirm no behavior changes in state transitions, merge flow, checks, or summary writing.

## Assumptions and Defaults
- Chosen mode names are exactly `pretty` and `json` (no `auto|dashboard|logs` aliases).
- Pretty mode always writes structured logs to file-only NDJSON sink under `.harness/logs/`.
- Pretty mode forces runtime streaming for execution stages to keep `last action` live.
- `last action` is best-effort; bash exit code/duration suffix is shown only when stream metadata provides it.
- Keyboard controls (`r/s/p/q`) are out of scope for this iteration; renderer lifecycle methods remain ready for next phase.
