bd create "Contract: Todo data model and in-memory CRUD store" -p P1 -l pipeline:execution,role:planner --body-file - <<'EOF'
## CONTRACT: Todo Data Model + CRUD Store

### Implementation

- TypeScript, strict mode, ESM
- File: src/store.ts
- Interface Todo: id (string, nanoid 8-char), title (string), completed (boolean), createdAt (ISO-8601 string)
- Class TodoStore backed by Map
- Methods:
  - add(title: string): Todo — creates with completed=false, createdAt=now
  - getAll(): Todo[] — returns sorted by createdAt descending (newest first)
  - getById(id: string): Todo | undefined
  - toggle(id: string): Todo — flips completed, throws if not found
  - remove(id: string): boolean — returns true if deleted, false if not found
- No persistence, no I/O, pure in-memory

### Tests (src/store.test.ts, vitest)

1. add() returns a Todo with 8-char id, completed=false, valid ISO createdAt
2. getAll() returns empty array when store is empty
3. getAll() returns todos sorted newest-first
4. getById() returns undefined for unknown id
5. toggle() flips completed from false to true and back
6. toggle() throws Error("Todo not found") for unknown id
7. remove() returns true for existing, false for unknown

### Completion criteria

ALL 7 tests must pass. Do NOT modify tests. Task is NOT complete until npx vitest run src/store.test.ts exits 0.
EOF





