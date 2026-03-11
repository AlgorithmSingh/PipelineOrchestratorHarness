## Prompt Auditability for Execution Pipeline

### Summary
Add always-on prompt artifact capture for execution stages so every planner/coder/reviewer invocation stores the exact resolved prompt plus deterministic metadata and hash. This makes post-run debugging reproducible across retries and ticket attempts without relying on terminal logs.

### Key Implementation Changes
1. **Prompt artifact model + summary surface**
- Extend execution observability types to include a `PromptArtifact` record with: `ticketId`, `stage`, `attempt`, `sequence`, `runtime`, `maxTurns`, `maxBudgetUsd`, `createdAt`, `promptHashSha256`, `prompt`.
- Add `promptArtifacts: PromptArtifact[]` to ticket summary output (backward-compatible optional field for older files is acceptable).
- Keep stage-level final summary fields unchanged; prompt history is represented as append-only artifact records.

2. **Always-on artifact writer (atomic, non-blocking)**
- In [execution.ts](/Users/ankitsingh/Documents/dev/HARNESS/PIpelineOrchestratorHarness2/PipelineOrchestratorHarness/src/pipelines/execution.ts), add helper to persist one JSON artifact per stage invocation at:
  - `.harness/prompts/<ticketId>/<sequence>-attempt<attempt>-<stage>.json`
- Compute SHA-256 over exact prompt text before write.
- Write via temp file + rename; on write failure, log warning and continue pipeline (no behavior regression in execution flow).

3. **Capture at exact stage boundaries**
- Capture prompts immediately after prompt construction and before `runtime.execute(...)` for:
  - planner (`buildPlannerPrompt`)
  - coder (`buildCoderPrompt`)
  - reviewer (`buildReviewerPrompt`)
- Use current retry state as `attempt` (initial `0`, then incremented attempts on reinjection path).
- Maintain monotonic `sequence` in per-ticket execution metadata so artifacts are ordered even with retries.
- Record artifact metadata into in-memory ticket meta and include in final ticket summary JSON.

4. **Operator visibility**
- Add lightweight structured log event (debug/info) per captured prompt with `ticketId`, `stage`, `attempt`, `sequence`, `promptHashSha256`, and relative artifact path.
- Add `promptArtifactsCount` to `ticket_summary` log payload for quick confirmation that capture happened.

5. **Documentation**
- Update [README.md](/Users/ankitsingh/Documents/dev/HARNESS/PIpelineOrchestratorHarness2/PipelineOrchestratorHarness/README.md) with:
  - prompt artifact location
  - artifact schema
  - note that capture is always-on and local to project workspace

### Public Interfaces / Types
- Add `PromptArtifact` type in [execution-types.ts](/Users/ankitsingh/Documents/dev/HARNESS/PIpelineOrchestratorHarness2/PipelineOrchestratorHarness/src/pipelines/execution-types.ts).
- Extend `TicketSummary` with `promptArtifacts`.
- No CLI flags or config toggles added (capture is always on by decision).

### Test Plan
1. **Unit: prompt writer**
- Writes JSON artifact with full prompt text and metadata.
- SHA-256 is stable and matches expected hash for known prompt text.
- Atomic write leaves no temp file.
- Write failure logs warning and does not throw.

2. **Unit: stage capture integration**
- Planner/coder/reviewer each create one artifact in a no-retry run.
- Retry path creates additional artifacts with incremented `attempt` and `sequence`.
- Stored `prompt` exactly matches generated stage prompt (including retry failure-context section when present).

3. **Unit: summary assembly**
- `ticket_summary` JSON includes `promptArtifacts` list sorted by `sequence`.
- `promptArtifactsCount` in log payload matches artifacts persisted.

4. **Regression**
- Existing execution tests for verdict parsing, run summaries, and idle behavior remain green.
- No change to state-machine transitions or merge behavior.

### Assumptions and Defaults
- Prompt text is stored in plaintext locally (accepted by decision).
- Retention is unbounded by default (no pruning in this iteration).
- Prompt capture failures are observability-only failures and must never block ticket processing.
