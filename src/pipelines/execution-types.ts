export interface DiffStatResult {
	filesChanged: number;
	insertions: number;
	deletions: number;
	diffStat: string;
	changedFiles: string[];
}

export interface PlanSummary {
	targetFiles: string[];
	approach: string;
}

export interface StageCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd: number;
}

export interface CheckResult {
	name: string;
	passed: boolean;
	exitCode: number | null;
	durationMs: number | null;
}

export type PromptStage = "planner" | "coder" | "reviewer";

export interface PromptArtifact {
	ticketId: string;
	stage: PromptStage;
	attempt: number;
	sequence: number;
	runtime: string;
	maxTurns: number;
	maxBudgetUsd: number;
	createdAt: string;
	promptHashSha256: string;
	prompt: string;
}

export interface TicketSummary {
	ticketId: string;
	title: string;
	outcome: "merged" | "failed" | "no_changes";
	sha: string | null;
	branch: string | null;
	startedAt: string;
	completedAt: string;
	totalDurationMs: number;
	retryCount: number;
	cost: {
		planner: StageCost | null;
		coder: StageCost | null;
		reviewer: StageCost | null;
		totalUsd: number;
	};
	stages: {
		planner: {
			runtime: string | null;
			model: string | null;
			durationMs: number | null;
			turns: number | null;
			approach: string;
			targetFiles: string[];
		} | null;
		coder: {
			runtime: string | null;
			model: string | null;
			durationMs: number | null;
			turns: number | null;
			exitReason: string | null;
			passed: boolean | null;
			filesChanged: number;
			insertions: number;
			deletions: number;
			diffStat: string;
			changedFiles: string[];
		} | null;
		checks: {
			allPassed: boolean;
			results: CheckResult[];
		} | null;
		reviewer: {
			runtime: string | null;
			model: string | null;
			durationMs: number | null;
			turns: number | null;
			verdict: string | null;
			reasoning: string;
		} | null;
	};
	promptArtifacts: PromptArtifact[];
	contract: string;
	failureType?: string;
	failureReason?: string;
}

export interface RunSummary {
	ticketsCompleted: number;
	ticketsFailed: number;
	ticketIds: string[];
	totalCostUsd: number;
	totalDurationMs: number;
	averageCostPerTicket: number;
	averageDurationPerTicket: number;
}
