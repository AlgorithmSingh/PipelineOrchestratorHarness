export type UiMode = "pretty" | "json";

export type TicketDisplayStatus =
	| "queued"
	| "active"
	| "retrying"
	| "completed"
	| "failed";

export type TicketDisplayStage =
	| "planner"
	| "coder"
	| "checks"
	| "reviewer"
	| "merge";

export interface TicketDisplayState {
	ticketId: string;
	title: string;
	status: TicketDisplayStatus;
	stage?: TicketDisplayStage;
	attempt: number;
	cost: number;
	durationMs: number;
	lastAction?: string;
	stageProgress?: { current: number; max: number };
	failureReason?: string;
}

export interface RunDisplayState {
	projectName: string;
	tickets: TicketDisplayState[];
	totalCost: number;
	elapsedMs: number;
}
