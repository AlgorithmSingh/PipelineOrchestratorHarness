bd create "Contract: JSON file persistence layer" -p P3 -l pipeline:execution,role:planner --body-file - <<'EOF'
## CONTRACT: JSON File Persistence

### Dependency

Requires ticket 1 (TodoStore) to be completed first.

### Implementation

- TypeScript, strict mode, ESM
- File: src/persistence.ts
- Class JsonPersistence
  - constructor(filePath: string) — default: ./todos.json
  - save(todos: Todo[]): void — writes JSON array to filePath, pretty-printed with 2-space indent
  - load(): Todo[] — reads and parses filePath, returns [] if file does not exist
- Use node:fs/promises (readFile, writeFile)
- Atomic write: write to filePath + ".tmp" then rename
- File format: JSON array of Todo objects, identical to Todo interface from store.ts

### Tests (src/persistence.test.ts, vitest)

1. load() returns empty array when file does not exist
2. save() then load() round-trips a list of 3 todos with all fields intact
3. save() writes pretty-printed JSON (contains newlines, 2-space indent)
4. save() is atomic — filePath exists after save, no .tmp file remains
5. load() throws on malformed JSON with a descriptive error message

### Completion criteria

ALL 5 tests must pass. Do NOT modify tests. Task is NOT complete until npx vitest run src/persistence.test.ts exits 0.
EOF
