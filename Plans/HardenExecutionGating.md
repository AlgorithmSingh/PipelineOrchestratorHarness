# Harden Execution Gating and Init Check Policy (Harness-only) — v2

## Summary

Make execution fail-closed, require explicit deterministic checks, and make `harness init` capability-aware so newly initialized projects are validated against real tooling — not language assumptions.

### Design Principle

The harness advances on explicit evidence, never on ambiguity. If the harness cannot definitively confirm a step succeeded, it treats it as failure and enters cascade.

---

## Public Interface Changes

### `harness init`

New flags:

- `--project-type <node|python>` — used for capability detection, not as a static profile
- repeatable `--check <name=command>` — override all detected checks

Resolution order:

1. If one or more `--check` flags are provided, use exactly those. Validate each has a non-empty name and non-empty command (reject malformed input like bare `--check foo` with no `=`, or `--check =cmd` with an empty name).
2. Otherwise, require `--project-type` and run capability detection (see Init Capability Detection below).
3. If detection finds no usable checks, fail init with an actionable message listing what was inspected and suggesting `--check`.
4. Never scaffold `checks: []`.

### Config contract

- `pipelines.execution.checks` must be non-empty when `pipelines.execution.enabled: true`.
- Validation is split into two layers:
  - **Structural validation** runs in `loadConfig()` — parse, normalize, resolve paths. This is what `harness status` and `harness config validate` use.
  - **Execution-readiness validation** runs only before starting the execution pipeline — non-empty checks, valid check entries, etc. This keeps `harness status` usable on broken projects for inspection and repair.

### Behavior changes

- Malformed or unparseable reviewer output is treated as failure (`reviewer_output_invalid`), not pass.
- Coder or reviewer runtime failure (`exitReason !== "completed"` or `passed === false`) triggers cascade immediately — downstream stages are skipped by default.

---

## Init Capability Detection

### Node (`--project-type node`)

Inspect `package.json` scripts. Add checks in this priority order (use all that exist):

1. `typecheck` script exists → add `Typecheck: npm run typecheck`
2. `lint` script exists → add `Lint: npm run lint`
3. `test` script exists and is not the default npm stub (`echo "Error: no test specified" && exit 1`) → add `Tests: npm test`

If none are found, fail init:

```
No usable check commands detected in package.json scripts.
Looked for: test, typecheck, lint
Either add scripts to package.json or pass --check explicitly:
  harness init <path> --project-type node --check "Tests=npm test"
```

### Python (`--project-type python`)

Inspect the project for installed/configured tooling. Add checks in this priority order (use all that exist):

1. `pyproject.toml` or `setup.cfg` contains mypy config, or `mypy` is in requirements → add `Typecheck: python -m mypy .`
2. `pyproject.toml` contains ruff config, or `ruff` is in requirements → add `Lint: ruff check .`
3. `pyproject.toml` contains pytest config, or `pytest` is in requirements, or `tests/` directory exists → add `Tests: python -m pytest`
4. `tox.ini` exists → add `Tests: tox`

If none are found, fail init with an analogous message listing what was inspected.

### Extensibility

The detection logic should be structured as a registry of project-type handlers so adding `rust`, `go`, etc. later is a handler addition, not a rewrite.

---

## Implementation Changes

### 1. Reviewer verdict parser — `execution.ts`

Create a `parseReviewerVerdict(rawOutput: string)` function with these semantics:

- Extract the first JSON object from the output. Accept both bare JSON and JSON inside triple-backtick fences (` ```json ... ``` ` or ` ``` ... ``` `).
- Extraction strategy: strip fences if present, then find the first `{` and its matching `}`. Parse that substring.
- Validate that the parsed object has a `verdict` field with value exactly `"pass"` or `"fail"` (case-sensitive, string type).
- On success, return `{ valid: true, verdict: "pass" | "fail", parsed: object }`.
- On any failure (no JSON found, parse error, missing verdict, wrong verdict value, wrong type), return `{ valid: false, reason: string }` where reason is one of:
  - `no_json_found`
  - `json_parse_error`
  - `missing_verdict_field`
  - `invalid_verdict_value`

In the execution pipeline:

- Replace the current default-pass fallback with: if `!result.valid`, set `checksPassed = false`, record `failureType: "reviewer_output_invalid"` and `failureReason: result.reason` in context, and transition to `exec:cascade_check`.
- If `result.verdict === "fail"`, same cascade path but with `failureType: "reviewer_rejected"`.

### 2. Early runtime gates — `execution.ts`

After the **coder** runtime returns:

- If `exitReason !== "completed"` or `passed === false`, build failure context with `failureType: "coder_runtime_failure"` and `exitReason`, increment retry, and transition to `exec:cascade_check`. Skip deterministic checks and reviewer entirely.

After the **reviewer** runtime returns (before verdict parsing):

- If `exitReason !== "completed"` or `passed === false`, build failure context with `failureType: "reviewer_runtime_failure"`, increment retry, and transition to `exec:cascade_check`. Skip verdict parsing.

### 3. Config validation split — `config.ts`

Refactor `loadConfig()`:

- `loadConfig()` performs structural validation only: YAML parsing, schema shape, path resolution, directory creation. Returns `HarnessConfig`.
- New export: `validateExecutionReadiness(config: HarnessConfig): void` — throws `ConfigError` if:
  - `pipelines.execution.enabled` is `true` and `checks` is empty or missing
  - Any check entry has an empty `name` or empty `command`
- `ConfigError` message includes a copy-paste YAML snippet showing valid check configuration.
- `validateExecutionReadiness()` is called at the top of `ExecutionPipeline.runOnce()`, not in `loadConfig()`.
- `harness status`, `harness config validate`, and other non-execution commands continue to work on projects with incomplete config.

### 4. Init capability detection — `init.ts`

- Add `--project-type` and `--check` flags to the init command in `src/index.ts`.
- Implement detection handlers as described in Init Capability Detection above.
- Write resolved checks to `.harness/config.yaml`.
- If detection finds checks, log what was detected and why.
- If detection finds nothing, fail with the actionable error message.

### 5. Codex runtime correctness — `codex.ts`

- Non-zero exit code sets `passed: false` and `exitReason: "error"`.
- Zero exit code sets `passed: true` and `exitReason: "completed"`.
- Ensure `error` field is populated with stderr or exit code on failure.

### 6. Migration path for existing projects

When `validateExecutionReadiness()` throws on empty checks, the error message should explicitly address the migration:

```
pipelines.execution.checks is empty. The execution pipeline requires at least one
deterministic check to run.

Previously, empty checks were allowed. To fix this, either:

1. Add checks to .harness/config.yaml:
   pipelines:
     execution:
       checks:
         - name: Tests
           command: npm test

2. Re-initialize with capability detection:
   harness init <path> --project-type node
```

---

## Test Plan

### Reviewer verdict parser

- Plain JSON `{"verdict":"pass"}` → pass
- Plain JSON `{"verdict":"fail"}` → fail
- Fenced JSON (` ```json\n{"verdict":"pass"}\n``` `) → pass
- Fenced JSON without language tag → pass
- JSON with extra fields → pass (only `verdict` matters)
- `{"verdict":"Pass"}` (wrong case) → `invalid_verdict_value`
- `{"verdict":true}` (wrong type) → `invalid_verdict_value`
- `{"result":"pass"}` (missing verdict) → `missing_verdict_field`
- Prose with no JSON → `no_json_found`
- Malformed JSON → `json_parse_error`
- Multiple JSON blocks → uses first one
- Nested JSON objects → correctly matches outer braces
- Empty string → `no_json_found`

### Early runtime gates

- Coder returns `exitReason: "max_turns"` → cascade with `coder_runtime_failure`, checks and reviewer skipped
- Coder returns `exitReason: "error"` → cascade with `coder_runtime_failure`
- Coder returns `passed: false, exitReason: "completed"` → cascade with `coder_runtime_failure`
- Reviewer runtime returns `exitReason: "error"` → cascade with `reviewer_runtime_failure`, verdict parsing skipped
- Coder succeeds → checks and reviewer proceed normally

### Config validation

- Empty `checks: []` with execution enabled → `ConfigError` with migration message
- Missing `checks` key with execution enabled → `ConfigError`
- Check with empty name → `ConfigError`
- Check with empty command → `ConfigError`
- Valid checks → passes
- Empty checks with execution disabled → passes (no validation)
- `harness status` on project with empty checks → succeeds (structural validation only)

### Init capability detection

- `--check "Tests=npm test"` → uses exactly that check, ignores project type
- `--check "Lint=ruff check ."` `--check "Tests=pytest"` → uses both
- `--check "badformat"` (no `=`) → error
- `--check "=npm test"` (empty name) → error
- `--project-type node` with `package.json` containing `test` and `lint` scripts → scaffolds both
- `--project-type node` with only default npm test stub → skips test, looks for other scripts
- `--project-type node` with no usable scripts → fails with actionable message
- `--project-type python` with `pytest` in requirements and `mypy` in pyproject.toml → scaffolds both
- `--project-type python` with nothing detectable → fails with actionable message
- Neither `--check` nor `--project-type` → error requiring one or the other

### Codex runtime

- Non-zero exit → `passed: false`, `exitReason: "error"`, `error` populated
- Zero exit → `passed: true`, `exitReason: "completed"`

---

## Implementation Order

1. **Reviewer verdict parser + tests** — highest severity fix, self-contained, proves out the cascade path
2. **Early runtime gates + tests** — depends on cascade path working
3. **Codex runtime correctness + tests** — independent, small
4. **Config validation split + tests** — refactor, moderate scope
5. **Init capability detection + tests** — most new code, depends on config contract being settled
6. **Migration error messaging** — finish pass, depends on config validation

---

## Assumptions

- Scope is harness-only. No edits to target projects.
- Strict enforcement is immediate. Existing projects with `checks: []` must update config before running the execution pipeline.
- The `--project-type` handler registry starts with `node` and `python`. Additional types are future work.
- Reviewer verdict parser does not attempt to coerce or fuzzy-match verdicts. Exact `"pass"` or `"fail"` only.