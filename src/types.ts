export type RuntimeName = "claude-code" | "codex" | (string & {});

export interface CheckCommand {
	name: string;
	command: string;
}

export interface RoleRuntimeConfig {
	runtime: RuntimeName;
	maxTurns: number;
	maxBudgetUsd: number;
}

export interface ProjectConfig {
	name: string;
	root: string;
	worktreeDir: string;
	stateDir: string;
	logDir: string;
	canonicalBranch: string;
}

export interface PlanGenerationConfig {
	enabled: boolean;
	runtime: RuntimeName;
	model: string;
}

export interface ExecutionConfig {
	enabled: boolean;
	maxParallelAgents: number;
	pollIntervalMs: number;
	maxRetriesPerTicket: number;
	runtime: RuntimeName;
	fallbackRuntime: RuntimeName;
	maxRetriesBeforeFallback: number;
	mergeMode: "direct" | "pr";
	checks: CheckCommand[];
	worktreeSetup: string[];
	planner: RoleRuntimeConfig;
	coder: RoleRuntimeConfig;
	reviewer: RoleRuntimeConfig;
	streamAgentOutput?: boolean;
}

export interface AdversarialRoleConfig extends RoleRuntimeConfig {
	model?: string;
	aggressiveness?: number;
}

export interface AdversarialConfig {
	enabled: boolean;
	pollIntervalMs: number;
	maxParallelTargets: number;
	targetStrategy: "recent" | "high-churn" | "complexity" | "random";
	targetsPerRun: number;
	bugFinder: AdversarialRoleConfig;
	adversarialRefuter: AdversarialRoleConfig;
	referee: AdversarialRoleConfig;
}

export interface RuntimeConfigEntry {
	type: string;
	approvalPolicy?: string;
	sandbox?: string;
}

export interface HitlConfig {
	notifyMethod: "terminal" | "webhook" | "slack";
	webhookUrl: string;
	timeoutMinutes: number;
}

export interface CostRate {
	inputPer1kUsd: number;
	outputPer1kUsd: number;
}

export interface CostRatesConfig {
	default: CostRate;
	runtimes: Record<string, CostRate>;
}

export interface HarnessConfig {
	project: ProjectConfig;
	pipelines: {
		planGeneration: PlanGenerationConfig;
		execution: ExecutionConfig;
		adversarial: AdversarialConfig;
	};
	runtimes: Record<string, RuntimeConfigEntry>;
	hitl: HitlConfig;
	costRates: CostRatesConfig;
}

export interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	pipeline: "plan" | "execution" | "adversarial" | "harness";
	ticketId?: string;
	state?: string;
	event: string;
	data?: Record<string, unknown>;
	durationMs?: number;
	tokenUsage?: { input: number; output: number };
	costUsd?: number;
}

export interface MetricEntry {
	timestamp: string;
	type: string;
	ticketId?: string;
	runtime?: string;
	pipeline: "plan" | "execution" | "adversarial" | "harness";
	data: Record<string, unknown>;
}
