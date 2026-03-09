export class HarnessError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessError";
    this.code = code;
  }
}

export class ConfigError extends HarnessError {
  readonly configPath: string | null;
  readonly field: string | null;

  constructor(message: string, context?: { configPath?: string; field?: string; cause?: Error }) {
    super(message, "CONFIG_ERROR", { cause: context?.cause });
    this.name = "ConfigError";
    this.configPath = context?.configPath ?? null;
    this.field = context?.field ?? null;
  }
}

export class RuntimeError extends HarnessError {
  readonly runtime: string | null;

  constructor(message: string, context?: { runtime?: string; cause?: Error }) {
    super(message, "RUNTIME_ERROR", { cause: context?.cause });
    this.name = "RuntimeError";
    this.runtime = context?.runtime ?? null;
  }
}

export class WorktreeError extends HarnessError {
  readonly worktreePath: string | null;
  readonly branchName: string | null;

  constructor(
    message: string,
    context?: { worktreePath?: string; branchName?: string; cause?: Error },
  ) {
    super(message, "WORKTREE_ERROR", { cause: context?.cause });
    this.name = "WorktreeError";
    this.worktreePath = context?.worktreePath ?? null;
    this.branchName = context?.branchName ?? null;
  }
}

export class PipelineError extends HarnessError {
  readonly pipeline: string | null;
  readonly ticketId: string | null;

  constructor(message: string, context?: { pipeline?: string; ticketId?: string; cause?: Error }) {
    super(message, "PIPELINE_ERROR", { cause: context?.cause });
    this.name = "PipelineError";
    this.pipeline = context?.pipeline ?? null;
    this.ticketId = context?.ticketId ?? null;
  }
}

export class StateError extends HarnessError {
  readonly from: string | null;
  readonly to: string | null;
  readonly ticketId: string | null;

  constructor(message: string, context?: { from?: string; to?: string; ticketId?: string; cause?: Error }) {
    super(message, "STATE_ERROR", { cause: context?.cause });
    this.name = "StateError";
    this.from = context?.from ?? null;
    this.to = context?.to ?? null;
    this.ticketId = context?.ticketId ?? null;
  }
}

export class BeadsError extends HarnessError {
  readonly command: string | null;

  constructor(message: string, context?: { command?: string; cause?: Error }) {
    super(message, "BEADS_ERROR", { cause: context?.cause });
    this.name = "BeadsError";
    this.command = context?.command ?? null;
  }
}

export class MergeError extends HarnessError {
  readonly branchName: string | null;
  readonly conflictFiles: string[];

  constructor(message: string, context?: { branchName?: string; conflictFiles?: string[]; cause?: Error }) {
    super(message, "MERGE_ERROR", { cause: context?.cause });
    this.name = "MergeError";
    this.branchName = context?.branchName ?? null;
    this.conflictFiles = context?.conflictFiles ?? [];
  }
}

export class ContractError extends HarnessError {
  readonly ticketId: string | null;

  constructor(message: string, context?: { ticketId?: string; cause?: Error }) {
    super(message, "CONTRACT_ERROR", { cause: context?.cause });
    this.name = "ContractError";
    this.ticketId = context?.ticketId ?? null;
  }
}

export class HITLError extends HarnessError {
  readonly gateType: string | null;
  readonly ticketId: string | null;

  constructor(message: string, context?: { gateType?: string; ticketId?: string; cause?: Error }) {
    super(message, "HITL_ERROR", { cause: context?.cause });
    this.name = "HITLError";
    this.gateType = context?.gateType ?? null;
    this.ticketId = context?.ticketId ?? null;
  }
}
