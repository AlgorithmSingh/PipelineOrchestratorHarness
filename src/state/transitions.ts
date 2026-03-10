import type { AdversarialState, ExecutionState, PlanState, StateTransition } from "./types.js";

const pass = async <T extends Record<string, unknown>>(ctx: T): Promise<T> => ctx;

export const planTransitions: StateTransition<PlanState>[] = [
  { from: "plan:analyze_codebase", to: "plan:generate_specs", guard: () => true, action: pass },
  { from: "plan:generate_specs", to: "plan:hitl_review", guard: () => true, action: pass },
  { from: "plan:hitl_review", to: "plan:create_tickets", guard: () => true, action: pass },
  { from: "plan:hitl_review", to: "plan:analyze_codebase", guard: (ctx) => ctx.humanInput === "reject", action: pass },
  { from: "plan:create_tickets", to: "plan:completed", guard: () => true, action: pass },
];

export const executionTransitions: StateTransition<ExecutionState>[] = [
  { from: "exec:pull_ticket", to: "exec:claim", guard: () => true, action: pass },
  { from: "exec:claim", to: "exec:generate_contract", guard: () => true, action: pass },
  { from: "exec:generate_contract", to: "exec:execute_code", guard: () => true, action: pass },
  { from: "exec:execute_code", to: "exec:deterministic_checks", guard: () => true, action: pass },
  // Checks pass → reviewer; checks fail → cascade
  { from: "exec:deterministic_checks", to: "exec:agent_review", guard: (ctx) => ctx.checksPassed !== false, action: pass },
  { from: "exec:deterministic_checks", to: "exec:cascade_check", guard: (ctx) => ctx.checksPassed === false, action: pass },
  // Reviewer pass → commit; reviewer fail → cascade
  { from: "exec:agent_review", to: "exec:commit", guard: (ctx) => ctx.agentResult?.passed === true, action: pass },
  { from: "exec:agent_review", to: "exec:cascade_check", guard: (ctx) => ctx.agentResult?.passed === false, action: pass },
  // Commit → merge or PR
  { from: "exec:commit", to: "exec:create_pr", guard: (ctx) => ctx.mergeMode === "pr", action: pass },
  { from: "exec:commit", to: "exec:merge", guard: (ctx) => ctx.mergeMode !== "pr", action: pass },
  { from: "exec:create_pr", to: "exec:merge", guard: () => true, action: pass },
  // Merge success → close; merge conflict → cascade
  { from: "exec:merge", to: "exec:close_ticket", guard: (ctx) => ctx.mergeConflict !== true, action: pass },
  { from: "exec:merge", to: "exec:cascade_check", guard: (ctx) => ctx.mergeConflict === true, action: pass },
  { from: "exec:close_ticket", to: "exec:completed", guard: () => true, action: pass },
  // Cascade: retry if under limit, HITL if at limit
  {
    from: "exec:cascade_check", to: "exec:reinject",
    guard: (ctx) => Number(ctx.retryCount ?? 0) < Number(ctx.maxRetries ?? 3),
    action: pass,
  },
  {
    from: "exec:cascade_check", to: "exec:hitl_gate",
    guard: (ctx) => Number(ctx.retryCount ?? 0) >= Number(ctx.maxRetries ?? 3),
    action: pass,
  },
  { from: "exec:reinject", to: "exec:generate_contract", guard: () => true, action: pass },
  // HITL decisions
  { from: "exec:hitl_gate", to: "exec:generate_contract", guard: (ctx) => ctx.humanInput === "edit" || ctx.humanInput === "approve", action: pass },
  { from: "exec:hitl_gate", to: "exec:failed", guard: (ctx) => ctx.humanInput === "abort" || ctx.humanInput === "reject", action: pass },
];

export const adversarialTransitions: StateTransition<AdversarialState>[] = [
  { from: "adv:select_target", to: "adv:bug_finder", guard: () => true, action: pass },
  { from: "adv:bug_finder", to: "adv:adversarial_disprove", guard: () => true, action: pass },
  { from: "adv:adversarial_disprove", to: "adv:referee_verdict", guard: () => true, action: pass },
  { from: "adv:referee_verdict", to: "adv:create_ticket", guard: (ctx) => ctx.refereeVerdict === "verified_bug", action: pass },
  { from: "adv:referee_verdict", to: "adv:log_dismissed", guard: (ctx) => ctx.refereeVerdict !== "verified_bug", action: pass },
  { from: "adv:create_ticket", to: "adv:completed", guard: () => true, action: pass },
  { from: "adv:log_dismissed", to: "adv:completed", guard: () => true, action: pass },
];
