bd create "Contract: CLI interface for todo list" -p P2 -l pipeline:execution,role:planner --deps "blocks:<TICKET_1_ID>" --body-file - <<'EOF'
## CONTRACT: Todo CLI Interface

### Dependency

Requires ticket 1 (TodoStore) to be completed first.

### Implementation

- TypeScript, strict mode, ESM
- File: src/cli.ts
- Use Commander 12.x (already in package.json)
- Commands:
  - todo add <title> — prints "Added: <id> — <title>"
  - todo list — prints table: ID | Title | Status (done/pending) | Created. Empty state prints "No todos yet."
  - todo list --done — filters to completed only
  - todo list --pending — filters to pending only
  - todo toggle <id> — prints "Toggled: <id> — now <done|pending>"
  - todo remove <id> — prints "Removed: <id>" or "Not found: <id>"
- Import and instantiate TodoStore from src/store.ts
- No persistence between runs (that is contract 3)

### Tests (src/cli.test.ts, vitest)

1. todo add "Buy milk" outputs line matching /Added: \w{8} — Buy milk/
2. todo list with no todos outputs "No todos yet."
3. todo list after adding 2 items shows both titles
4. todo toggle <id> outputs line matching /now done/
5. todo remove <id> outputs /Removed:/
6. todo remove nonexistent outputs /Not found:/

### Completion criteria

ALL 6 tests must pass. Do NOT modify tests. Task is NOT complete until npx vitest run src/cli.test.ts exits 0.
EOF