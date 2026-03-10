import { execa } from "execa";
import type { Logger } from "pino";
import type { HarnessConfig } from "../types.js";
import { validateExecutionReadiness } from "../config.js";
import { PipelineError } from "../errors.js";
import { createBeadsClient } from "../beads/client.js";
import type { Ticket } from "../beads/types.js";
import { Semaphore } from "../util/semaphore.js";
import { WorktreeManager } from "../git/worktree.js";
import { MergeCoordinator } from "../git/merge.js";
import { ClaudeCodeRuntime } from "../runtime/claude-code.js";
import { CodexRuntime } from "../runtime/codex.js";
import type { AgentRuntime } from "../runtime/types.js";
import { StateMachine } from "../state/machine.js";
import { executionTransitions } from "../state/transitions.js";
import type { ExecutionState, StateContext } from "../state/types.js";
import { buildCoderPrompt, buildFailureContext, buildPlannerPrompt, buildReviewerPrompt } from "../contracts/generator.js";
import { HITLGate } from "../hitl/gate.js";

export type ReviewerVerdictParseResult =
  | { valid: true; verdict: "pass" | "fail"; parsed: Record<string, unknown> }
  | { valid: false; reason: "no_json_found" | "json_parse_error" | "missing_verdict_field" | "invalid_verdict_value" };

export function parseReviewerVerdict(rawOutput: string): ReviewerVerdictParseResult {
  const stripFences = (input: string): string => {
    const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/m);
    if (fenced && fenced[1]) return fenced[1];
    return input;
  };

  const candidateSource = stripFences(rawOutput ?? "").trim();
  const start = candidateSource.indexOf("{");
  if (start === -1) {
    return { valid: false, reason: "no_json_found" };
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < candidateSource.length; i++) {
    const ch = candidateSource[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  if (end === -1) {
    return { valid: false, reason: "json_parse_error" };
  }

  const jsonText = candidateSource.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return { valid: false, reason: "json_parse_error" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { valid: false, reason: "json_parse_error" };
  }

  const verdict = (parsed as Record<string, unknown>).verdict;
  if (verdict === undefined) {
    return { valid: false, reason: "missing_verdict_field" };
  }
  if (typeof verdict !== "string") {
    return { valid: false, reason: "invalid_verdict_value" };
  }
  if (verdict !== "pass" && verdict !== "fail") {
    return { valid: false, reason: "invalid_verdict_value" };
  }

  return { valid: true, verdict, parsed: parsed as Record<string, unknown> };
}

export class ExecutionPipeline {
  private readonly beads;
  private readonly semaphore: Semaphore;
  private readonly worktrees: WorktreeManager;
  private readonly merger: MergeCoordinator;
  private readonly runtimes: Map<string, AgentRuntime>;
  private readonly hitlGate: HITLGate;

  constructor(
    private readonly config: HarnessConfig,
    private readonly logger: Logger,
  ) {
    this.beads = createBeadsClient(this.config.project.root);
    this.semaphore = new Semaphore(this.config.pipelines.execution.maxParallelAgents);
    this.worktrees = new WorktreeManager(
      this.config.project.root,
      this.config.project.worktreeDir,
      this.config.project.canonicalBranch,
    );
    this.merger = new MergeCoordinator(this.config.project.root, this.config.project.canonicalBranch);
    this.runtimes = new Map<string, AgentRuntime>();
    this.runtimes.set("claude-code", new ClaudeCodeRuntime());
    this.runtimes.set("codex", new CodexRuntime());
    this.hitlGate = new HITLGate(this.config.hitl.timeoutMinutes);
  }

  private getRuntime(name: string): AgentRuntime {
    const rt = this.runtimes.get(name);
    if (!rt) throw new PipelineError(`Unknown runtime: ${name}`, { pipeline: "execution" });
    return rt;
  }

  async runOnce(signal?: AbortSignal): Promise<void> {
    const log = this.logger.child({ pipeline: "execution" });
    validateExecutionReadiness(this.config);
    const beadsAvailable = await this.beads.healthCheck();
    if (!beadsAvailable) {
      throw new PipelineError(
        "Beads CLI is unavailable. Install/configure `bd` before running execution pipeline.",
        { pipeline: "execution" },
      );
    }

    const tickets = await this.beads.ready({ label: "pipeline:execution" });
    log.info({ event: "tickets_polled", count: tickets.length }, "polled execution tickets");

    if (tickets.length === 0) {
      log.info({ event: "no_tickets" }, "no ready tickets");
      return;
    }

    const selected = tickets.slice(0, this.config.pipelines.execution.maxParallelAgents);
    const results = await Promise.allSettled(
      selected.map(async (ticket) => {
        await this.semaphore.acquire();
        try {
          await this.processTicket(ticket, signal);
        } finally {
          this.semaphore.release();
        }
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        log.error({ event: "ticket_failed", error: String(result.reason) }, "ticket processing failed");
      }
    }
  }

  private async processTicket(ticket: Ticket, signal?: AbortSignal): Promise<void> {
    const log = this.logger.child({ pipeline: "execution", ticketId: ticket.id });
    const execConfig = this.config.pipelines.execution;

    const machine = new StateMachine<ExecutionState>({
      stateDir: this.config.project.stateDir,
      stateId: ticket.id,
      initialState: "exec:pull_ticket",
      initialContext: {
        ticketId: ticket.id,
        retryCount: 0,
        maxRetries: execConfig.maxRetriesPerTicket,
        mergeMode: execConfig.mergeMode,
        contractJson: ticket.description ?? ticket.title,
      },
      transitions: executionTransitions,
      onTransition: ({ from, to }) => {
        log.info({ event: "transition", from, to }, `${from} → ${to}`);
      },
    });

    try {
      // exec:pull_ticket → exec:claim
      await machine.transition("exec:claim");
      await this.beads.claim(ticket.id, "harness-execution");

      // exec:claim → exec:generate_contract
      await machine.transition("exec:generate_contract");

      // Create worktree
      const worktree = await this.worktrees.create(ticket.id);
      await machine.replaceContext((ctx) => ({
        ...ctx,
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
      }));

      // Run setup commands
      if (execConfig.worktreeSetup.length > 0) {
        await this.worktrees.setup(ticket.id, execConfig.worktreeSetup);
        log.info({ event: "worktree_setup" }, "setup complete");
      }

      // Drive the state machine loop
      await this.driveStateMachine(machine, ticket, log, signal);
    } catch (error) {
      log.error({ event: "error", error: error instanceof Error ? error.message : String(error) }, "ticket failed");
      try {
        await this.worktrees.cleanup(ticket.id);
      } catch {
        // best effort
      }
      throw new PipelineError(`Execution pipeline failed for ticket ${ticket.id}`, {
        pipeline: "execution",
        ticketId: ticket.id,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  private async driveStateMachine(
    machine: StateMachine<ExecutionState>,
    ticket: Ticket,
    log: Logger,
    signal?: AbortSignal,
  ): Promise<void> {
    const execConfig = this.config.pipelines.execution;
    const terminalStates = new Set<ExecutionState>(["exec:completed", "exec:failed"]);

    while (!terminalStates.has(machine.state)) {
      // Check if orchestrator is shutting down before each step
      if (signal?.aborted) {
        log.warn(
          { event: "aborted", state: machine.state },
          `aborting ticket at ${machine.state} due to shutdown`,
        );
        return;
      }

      const ctx = machine.ctx;
      const state = machine.state;

      switch (state) {
        case "exec:generate_contract": {
          // PLANNER stage
          const plannerRuntime = this.getRuntime(execConfig.planner.runtime);
          const plannerPrompt = buildPlannerPrompt(
            ctx.contractJson ?? "",
            ctx.retryCount,
            ctx.failureContext,
          );

          log.info({ event: "planner_start", runtime: plannerRuntime.name }, "starting planner");
          const plannerResult = await this.executeWithHeartbeat(
            plannerRuntime,
            plannerPrompt,
            {
              cwd: ctx.worktreePath!,
              systemPrompt: "",
              maxTurns: execConfig.planner.maxTurns,
              maxBudgetUsd: execConfig.planner.maxBudgetUsd,
              signal,
            },
            "planner",
            log,
          );
          log.info({ event: "planner_done", durationMs: plannerResult.durationMs }, "planner finished");

          if (plannerResult.exitReason === "aborted") {
            log.warn({ event: "planner_aborted" }, "planner aborted by shutdown");
            return;
          }

          await machine.replaceContext((c) => ({ ...c, plannerOutput: plannerResult.rawOutput }));
          await machine.transition("exec:execute_code");
          break;
        }

        case "exec:execute_code": {
          // CODER stage
          const coderRuntime = this.getRuntime(execConfig.coder.runtime);
          const coderPrompt = buildCoderPrompt(ctx.contractJson ?? "", ctx.plannerOutput);

          log.info({ event: "coder_start", runtime: coderRuntime.name }, "starting coder");
          const coderResult = await this.executeWithHeartbeat(
            coderRuntime,
            coderPrompt,
            {
              cwd: ctx.worktreePath!,
              systemPrompt: "",
              maxTurns: execConfig.coder.maxTurns,
              maxBudgetUsd: execConfig.coder.maxBudgetUsd,
              signal,
            },
            "coder",
            log,
          );
          log.info(
            { event: "coder_done", passed: coderResult.passed, durationMs: coderResult.durationMs },
            "coder finished",
          );

          if (coderResult.exitReason === "aborted") {
            log.warn({ event: "coder_aborted" }, "coder aborted by shutdown");
            return;
          }

          if (coderResult.exitReason !== "completed" || coderResult.passed === false) {
            await machine.replaceContext((c) => ({
              ...c,
              agentResult: coderResult,
              retryCount: c.retryCount + 1,
              failureType: "coder_runtime_failure",
              failureReason: coderResult.exitReason,
              failureContext: buildFailureContext(undefined, undefined, coderResult.error ?? coderResult.exitReason),
            }));
            await machine.transition("exec:cascade_check");
            break;
          }

          await machine.replaceContext((c) => ({ ...c, agentResult: coderResult }));
          await machine.transition("exec:deterministic_checks");
          break;
        }

        case "exec:deterministic_checks": {
          // Harness-controlled checks
          const checksResults: Array<{ name: string; passed: boolean; output: string }> = [];
          for (const check of execConfig.checks) {
            try {
              await execa("sh", ["-c", check.command], { cwd: ctx.worktreePath! });
              checksResults.push({ name: check.name, passed: true, output: "" });
              log.info({ event: "check_passed", check: check.name }, `check passed: ${check.name}`);
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              checksResults.push({ name: check.name, passed: false, output: errMsg });
              log.warn({ event: "check_failed", check: check.name }, `check failed: ${check.name}`);
            }
          }

          const allPassed = checksResults.length === 0 || checksResults.every((r) => r.passed);
          await machine.replaceContext((c) => ({ ...c, checksPassed: allPassed, checksResults }));

          if (allPassed) {
            await machine.transition("exec:agent_review");
          } else {
            await machine.replaceContext((c) => ({
              ...c,
              retryCount: c.retryCount + 1,
              failureContext: buildFailureContext(checksResults),
            }));
            await machine.transition("exec:cascade_check");
          }
          break;
        }

        case "exec:agent_review": {
          // REVIEWER stage
          const reviewerRuntime = this.getRuntime(execConfig.reviewer.runtime);
          const reviewerPrompt = buildReviewerPrompt(ctx.contractJson ?? "", ctx.plannerOutput);

          log.info({ event: "reviewer_start", runtime: reviewerRuntime.name }, "starting reviewer");
          const reviewResult = await this.executeWithHeartbeat(
            reviewerRuntime,
            reviewerPrompt,
            {
              cwd: ctx.worktreePath!,
              systemPrompt: "",
              maxTurns: execConfig.reviewer.maxTurns,
              maxBudgetUsd: execConfig.reviewer.maxBudgetUsd,
              signal,
            },
            "reviewer",
            log,
          );
          log.info({ event: "reviewer_done", durationMs: reviewResult.durationMs }, "reviewer finished");

          if (reviewResult.exitReason === "aborted") {
            log.warn({ event: "reviewer_aborted" }, "reviewer aborted by shutdown");
            return;
          }

          if (reviewResult.exitReason !== "completed" || reviewResult.passed === false) {
            await machine.replaceContext((c) => ({
              ...c,
              agentResult: reviewResult,
              retryCount: c.retryCount + 1,
              failureType: "reviewer_runtime_failure",
              failureReason: reviewResult.exitReason,
              failureContext: buildFailureContext(undefined, undefined, reviewResult.error ?? reviewResult.exitReason),
            }));
            await machine.transition("exec:cascade_check");
            break;
          }

          const verdict = parseReviewerVerdict(reviewResult.rawOutput);
          await machine.replaceContext((c) => ({
            ...c,
            agentResult: { ...reviewResult, passed: verdict.valid && verdict.verdict === "pass" },
            reviewOutput: reviewResult.rawOutput,
          }));

          if (!verdict.valid) {
            await machine.replaceContext((c) => ({
              ...c,
              retryCount: c.retryCount + 1,
              checksPassed: false,
              failureType: "reviewer_output_invalid",
              failureReason: verdict.reason,
              failureContext: `${buildFailureContext(undefined, reviewResult.rawOutput)}\n\nReviewer verdict parse failure: ${verdict.reason}`,
            }));
            await machine.transition("exec:cascade_check");
            break;
          }

          if (verdict.verdict === "pass") {
            await machine.transition("exec:commit");
          } else {
            await machine.replaceContext((c) => ({
              ...c,
              retryCount: c.retryCount + 1,
              failureType: "reviewer_rejected",
              failureReason: "fail",
              failureContext: buildFailureContext(undefined, reviewResult.rawOutput),
            }));
            await machine.transition("exec:cascade_check");
          }
          break;
        }

        case "exec:commit": {
          const hasChanges = await this.hasGitChanges(ctx.worktreePath!);
          if (!hasChanges) {
            await this.beads.close(ticket.id, "No changes produced by agent");
            await this.worktrees.cleanup(ticket.id);
            log.warn({ event: "no_changes" }, "no changes, ticket closed");
            // Force to completed
            await machine.replaceContext((c) => ({ ...c }));
            await machine.transition("exec:merge");
            await machine.replaceContext((c) => ({ ...c }));
            await machine.transition("exec:close_ticket");
            await machine.transition("exec:completed");
            break;
          }

          await execa("git", ["add", "-A"], { cwd: ctx.worktreePath! });
          await execa("git", ["commit", "-m", `feat: ${ticket.title}\n\nTicket: ${ticket.id}`], {
            cwd: ctx.worktreePath!,
          });
          log.info({ event: "committed" }, "changes committed");

          if (ctx.mergeMode === "pr") {
            await machine.transition("exec:create_pr");
          } else {
            await machine.transition("exec:merge");
          }
          break;
        }

        case "exec:create_pr": {
          // PR creation would go here; for now pass through to merge
          await machine.transition("exec:merge");
          break;
        }

        case "exec:merge": {
          const mergeResult = await this.merger.merge(ctx.worktreeBranch!);
          if (!mergeResult.success) {
            await machine.replaceContext((c) => ({
              ...c,
              mergeConflict: true,
              retryCount: c.retryCount + 1,
              failureContext: buildFailureContext(
                undefined,
                undefined,
                `Merge conflict on files: ${mergeResult.conflicts?.join(", ")}`,
              ),
            }));
            log.warn({ event: "merge_conflict", conflicts: mergeResult.conflicts }, "merge conflict");
            await machine.transition("exec:cascade_check");
            break;
          }

          await machine.replaceContext((c) => ({ ...c, mergeConflict: false }));
          log.info({ event: "merged", sha: mergeResult.commitSha }, "merged");
          await machine.transition("exec:close_ticket");
          break;
        }

        case "exec:close_ticket": {
          await this.beads.close(ticket.id, "Completed by harness execution pipeline");
          await this.worktrees.cleanup(ticket.id);
          log.info({ event: "completed" }, "ticket completed");
          await machine.transition("exec:completed");
          break;
        }

        case "exec:cascade_check": {
          const retryCount = ctx.retryCount;
          const maxRetries = Number(ctx.maxRetries ?? execConfig.maxRetriesPerTicket);

          if (retryCount < maxRetries) {
            log.info(
              { event: "reinject", retry: retryCount, max: maxRetries },
              `reinjecting (attempt ${retryCount}/${maxRetries})`,
            );
            await machine.transition("exec:reinject");
          } else {
            log.warn(
              { event: "hitl_needed", retry: retryCount, max: maxRetries },
              "max retries reached, requesting human intervention",
            );
            await machine.transition("exec:hitl_gate");
          }
          break;
        }

        case "exec:reinject": {
          // Clear previous results, loop back to planner
          await machine.replaceContext((c) => ({
            ...c,
            agentResult: undefined,
            reviewOutput: undefined,
            checksResults: undefined,
            checksPassed: undefined,
            mergeConflict: undefined,
            operationFlags: {},
          }));
          await machine.transition("exec:generate_contract");
          break;
        }

        case "exec:hitl_gate": {
          const response = await this.hitlGate.prompt({
            type: "max_retries",
            ticketId: ticket.id,
            summary: `Ticket failed ${ctx.retryCount} times. Contract: ${ticket.title}`,
            retryCount: ctx.retryCount,
            contractJson: ctx.contractJson,
            failureContext: ctx.failureContext,
          });

          const humanInput = response.decision;
          await machine.replaceContext((c) => ({
            ...c,
            humanInput,
            failureContext: response.humanNotes
              ? `${c.failureContext ?? ""}\n\nHuman notes: ${response.humanNotes}`
              : c.failureContext,
          }));

          if (humanInput === "approve" || humanInput === "edit") {
            await machine.transition("exec:generate_contract");
          } else {
            await this.beads.update(ticket.id, { status: "open" });
            await this.worktrees.cleanup(ticket.id);
            await machine.transition("exec:failed");
          }
          break;
        }

        default:
          throw new PipelineError(`Unhandled state: ${state}`, { pipeline: "execution", ticketId: ticket.id });
      }
    }
  }

  private async executeWithHeartbeat(
    runtime: AgentRuntime,
    prompt: string,
    config: import("../runtime/types.js").AgentRuntimeConfig,
    stage: string,
    log: Logger,
    intervalMs = 30_000,
  ): Promise<import("../runtime/types.js").AgentResult> {
    const started = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      log.info({ event: `${stage}_heartbeat`, elapsedSec: elapsed }, `${stage} still running (${elapsed}s)`);
    }, intervalMs);

    try {
      return await runtime.execute(prompt, {
        ...config,
        logger: log.child({ stage }),
        streamOutput: this.config.pipelines.execution.streamAgentOutput ?? false,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async hasGitChanges(cwd: string): Promise<boolean> {
    const { stdout } = await execa("git", ["status", "--porcelain"], { cwd });
    return stdout.trim().length > 0;
  }
}
