import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateError } from "../errors.js";
import type { PersistedState, PipelineState, StateContext, StateTransition } from "./types.js";

export interface StateMachineOptions<S extends PipelineState> {
  stateDir: string;
  stateId: string;
  initialState: S;
  initialContext: StateContext;
  transitions: StateTransition<S>[];
  onTransition?: (entry: { from: S; to: S; context: StateContext }) => Promise<void> | void;
}

export class StateMachine<S extends PipelineState> {
  private currentState: S;
  private context: StateContext;
  private readonly stateDir: string;
  private readonly stateId: string;
  private readonly transitions: StateTransition<S>[];
  private readonly history: Array<{ from: S; to: S; timestamp: string }> = [];
  private readonly onTransition?: StateMachineOptions<S>["onTransition"];

  constructor(options: StateMachineOptions<S>) {
    this.currentState = options.initialState;
    this.context = options.initialContext;
    this.stateDir = options.stateDir;
    this.stateId = options.stateId;
    this.transitions = options.transitions;
    this.onTransition = options.onTransition;
  }

  get state(): S {
    return this.currentState;
  }

  get ctx(): StateContext {
    return this.context;
  }

  private stateFilePath(): string {
    return join(this.stateDir, `${this.stateId}.json`);
  }

  private async persist(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const payload: PersistedState<S> = {
      currentState: this.currentState,
      context: this.context,
      history: this.history,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(this.stateFilePath(), JSON.stringify(payload, null, 2), "utf8");
  }

  async transition(nextState: S): Promise<void> {
    const transition = this.transitions.find((candidate) => candidate.from === this.currentState && candidate.to === nextState);
    if (!transition) {
      throw new StateError(`Invalid transition ${this.currentState} -> ${nextState}`, {
        from: this.currentState,
        to: nextState,
        ticketId: typeof this.context.ticketId === "string" ? this.context.ticketId : undefined,
      });
    }
    if (!transition.guard(this.context)) {
      throw new StateError(`Transition guard failed for ${this.currentState} -> ${nextState}`, {
        from: this.currentState,
        to: nextState,
        ticketId: typeof this.context.ticketId === "string" ? this.context.ticketId : undefined,
      });
    }

    const from = this.currentState;
    this.context = await transition.action(this.context);
    this.currentState = nextState;
    this.history.push({
      from,
      to: nextState,
      timestamp: new Date().toISOString(),
    });
    await this.persist();
    if (this.onTransition) {
      await this.onTransition({ from, to: nextState, context: this.context });
    }
  }

  async replaceContext(mutator: (ctx: StateContext) => StateContext): Promise<void> {
    this.context = mutator(this.context);
    await this.persist();
  }

  static async restore<S extends PipelineState>(
    stateDir: string,
    stateId: string,
    transitions: StateTransition<S>[],
    onTransition?: (entry: { from: S; to: S; context: StateContext }) => Promise<void> | void,
  ): Promise<StateMachine<S>> {
    const filePath = join(stateDir, `${stateId}.json`);
    const raw = await readFile(filePath, "utf8");
    const payload = JSON.parse(raw) as PersistedState<S>;

    const machine = new StateMachine<S>({
      stateDir,
      stateId,
      initialState: payload.currentState,
      initialContext: payload.context,
      transitions,
      onTransition,
    });
    for (const entry of payload.history) {
      machine.history.push(entry);
    }
    return machine;
  }
}
