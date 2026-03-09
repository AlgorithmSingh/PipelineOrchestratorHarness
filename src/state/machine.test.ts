import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { StateError } from "../errors.js";
import { StateMachine } from "./machine.js";
import type { ExecutionState, StateTransition } from "./types.js";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("StateMachine", () => {
  it("applies valid transitions and persists state", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "harness-state-"));

    const transitions: StateTransition<ExecutionState>[] = [
      {
        from: "exec:pull_ticket",
        to: "exec:claim",
        guard: () => true,
        action: async (ctx) => ({ ...ctx, claimed: true }),
      },
    ];

    const machine = new StateMachine<ExecutionState>({
      stateDir: tempDir,
      stateId: "ticket-1",
      initialState: "exec:pull_ticket",
      initialContext: { retryCount: 0, ticketId: "ticket-1" },
      transitions,
    });

    await machine.transition("exec:claim");
    expect(machine.state).toBe("exec:claim");
    expect(machine.ctx.claimed).toBe(true);

    const restored = await StateMachine.restore<ExecutionState>(tempDir, "ticket-1", transitions);
    expect(restored.state).toBe("exec:claim");
  });

  it("rejects invalid transitions", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "harness-state-"));
    const transitions: StateTransition<ExecutionState>[] = [];
    const machine = new StateMachine<ExecutionState>({
      stateDir: tempDir,
      stateId: "ticket-2",
      initialState: "exec:pull_ticket",
      initialContext: { retryCount: 0, ticketId: "ticket-2" },
      transitions,
    });

    await expect(machine.transition("exec:claim")).rejects.toBeInstanceOf(StateError);
  });
});
