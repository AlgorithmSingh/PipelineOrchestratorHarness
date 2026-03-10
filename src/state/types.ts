import type { AgentResult } from "../runtime/types.js";

export type PlanState =
  | "plan:analyze_codebase"
  | "plan:generate_specs"
  | "plan:hitl_review"
  | "plan:create_tickets"
  | "plan:completed";

export type ExecutionState =
  | "exec:pull_ticket"
  | "exec:claim"
  | "exec:generate_contract"
  | "exec:execute_code"
  | "exec:deterministic_checks"
  | "exec:agent_review"
  | "exec:commit"
  | "exec:create_pr"
  | "exec:merge"
  | "exec:close_ticket"
  | "exec:cascade_check"
  | "exec:reinject"
  | "exec:hitl_gate"
  | "exec:completed"
  | "exec:failed";

export type AdversarialState =
  | "adv:select_target"
  | "adv:bug_finder"
  | "adv:adversarial_disprove"
  | "adv:referee_verdict"
  | "adv:create_ticket"
  | "adv:log_dismissed"
  | "adv:completed";

export type PipelineState = PlanState | ExecutionState | AdversarialState;

export interface StateContext {
  ticketId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  retryCount: number;
  maxRetries?: number;
  contractJson?: string;
  plannerOutput?: string;
  agentResult?: AgentResult;
  failureContext?: string;
  humanInput?: string;
  checksPassed?: boolean;
  checksResults?: Array<{ name: string; passed: boolean; output: string }>;
  reviewOutput?: string;
  mergeConflict?: boolean;
  mergeMode?: string;
  failureType?: string;
  failureReason?: string;
  bugReports?: Array<Record<string, unknown>>;
  currentBugIndex?: number;
  operationFlags?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface StateTransition<S extends PipelineState> {
  from: S;
  to: S;
  guard: (ctx: StateContext) => boolean;
  action: (ctx: StateContext) => Promise<StateContext>;
}

export interface PersistedState<S extends PipelineState> {
  currentState: S;
  context: StateContext;
  history: Array<{ from: S; to: S; timestamp: string }>;
  updatedAt: string;
}
