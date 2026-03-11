import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { Logger } from "pino";
import { createBeadsClient } from "../beads/client.js";
import type { Ticket } from "../beads/types.js";
import { validateExecutionReadiness } from "../config.js";
import {
	buildCoderPrompt,
	buildFailureContext,
	buildPlannerPrompt,
	buildReviewerPrompt,
} from "../contracts/generator.js";
import { PipelineError } from "../errors.js";
import { MergeCoordinator } from "../git/merge.js";
import { WorktreeManager } from "../git/worktree.js";
import { HITLGate } from "../hitl/gate.js";
import { ClaudeCodeRuntime } from "../runtime/claude-code.js";
import { CodexRuntime } from "../runtime/codex.js";
import type { AgentResult, AgentRuntime } from "../runtime/types.js";
import { StateMachine } from "../state/machine.js";
import { executionTransitions } from "../state/transitions.js";
import type { ExecutionState, StateContext } from "../state/types.js";
import type { CostRate, HarnessConfig } from "../types.js";
import { estimateCost } from "../util/cost.js";
import { Semaphore } from "../util/semaphore.js";
import type {
	CheckResult,
	DiffStatResult,
	PlanSummary,
	PromptArtifact,
	PromptStage,
	RunSummary,
	StageCost,
	TicketSummary,
} from "./execution-types.js";

const PROMPT_SUBDIR = ".harness/prompts";
const SUMMARY_SUBDIR = ".harness/summaries";
const MAX_TITLE_LENGTH = 200;
const MAX_APPROACH_LENGTH = 200;
const MAX_REVIEWER_REASONING_LENGTH = 300;
const PLAN_FILE_LIMIT = 10;

type RunSummaryReason = "idle" | "shutdown" | "once";

interface StageInfo {
	runtime: string | null;
	model: string | null;
	durationMs: number | null;
	turns: number | null;
}

interface CoderStageInfo extends StageInfo {
	exitReason: string | null;
	passed: boolean | null;
}

interface TicketExecutionMeta {
	startedAt: Date;
	title: string;
	contractSummary: string;
	plan: PlanSummary | null;
	diff: DiffStatResult | null;
	reviewerVerdict: string | null;
	reviewerReasoning: string;
	costs: {
		planner: StageCost | null;
		coder: StageCost | null;
		reviewer: StageCost | null;
	};
	checkResults: CheckResult[];
	plannerStage: StageInfo | null;
	coderStage: CoderStageInfo | null;
	reviewerStage: StageInfo | null;
	promptArtifacts: PromptArtifact[];
	nextPromptSequence: number;
	outcome: "merged" | "failed" | "no_changes" | null;
	mergeSha: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return value.slice(0, maxLength);
}

function firstLine(value: string): string {
	const [line = ""] = value.split(/\r?\n/, 1);
	return line.trim();
}

function stripFences(input: string): string {
	const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/im);
	if (fenced?.[1]) {
		return fenced[1];
	}
	return input;
}

function findFirstJsonObjectText(input: string): string | null {
	const source = stripFences(input ?? "").trim();
	const start = source.indexOf("{");
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;

	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
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

	if (end === -1) return null;
	return source.slice(start, end + 1);
}

function parseFirstJsonRecord(input: string): Record<string, unknown> | null {
	const jsonText = findFirstJsonObjectText(input);
	if (!jsonText) return null;

	try {
		const parsed = JSON.parse(jsonText) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function emptyDiffStat(): DiffStatResult {
	return {
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		diffStat: "",
		changedFiles: [],
	};
}

function normalizePath(path: string): string {
	return path.trim().replace(/[),.;:]+$/g, "");
}

function addUniqueFilePath(target: string[], candidate: string): void {
	if (target.length >= PLAN_FILE_LIMIT) return;
	const normalized = normalizePath(candidate);
	if (!normalized || target.includes(normalized)) return;
	target.push(normalized);
}

function collectPathsFromText(target: string[], text: string): void {
	if (target.length >= PLAN_FILE_LIMIT || text.trim().length === 0) return;

	const pathPattern =
		/\b(?:\.{1,2}\/)?[A-Za-z0-9_./-]+\.(?:ts|js|py|tsx|jsx|json|yaml|yml|css|html|md)\b/g;
	for (const match of text.matchAll(pathPattern)) {
		addUniqueFilePath(target, match[0]);
		if (target.length >= PLAN_FILE_LIMIT) break;
	}
}

function extractStructuredPlanFiles(parsed: Record<string, unknown>): string[] {
	const files: string[] = [];

	const addFromValue = (value: unknown): void => {
		if (
			files.length >= PLAN_FILE_LIMIT ||
			value === undefined ||
			value === null
		)
			return;

		if (typeof value === "string") {
			collectPathsFromText(files, value);
			return;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					addUniqueFilePath(files, item);
				} else if (isRecord(item)) {
					for (const nestedValue of Object.values(item)) {
						addFromValue(nestedValue);
					}
				}
				if (files.length >= PLAN_FILE_LIMIT) break;
			}
			return;
		}

		if (isRecord(value)) {
			for (const nestedValue of Object.values(value)) {
				addFromValue(nestedValue);
				if (files.length >= PLAN_FILE_LIMIT) break;
			}
		}
	};

	addFromValue(parsed.files);
	addFromValue(parsed.targetFiles);

	if (parsed.plan !== undefined) {
		addFromValue(parsed.plan);
	}

	return files.slice(0, PLAN_FILE_LIMIT);
}

function summarizeApproach(
	plannerOutput: string,
	parsed: Record<string, unknown> | null,
): string {
	if (parsed) {
		const approach = parsed.approach;
		if (typeof approach === "string" && approach.trim().length > 0) {
			return truncate(approach.trim(), MAX_APPROACH_LENGTH);
		}

		const plan = parsed.plan;
		if (typeof plan === "string" && plan.trim().length > 0) {
			return truncate(plan.trim(), MAX_APPROACH_LENGTH);
		}

		if (Array.isArray(plan)) {
			const planText = plan
				.filter((item): item is string => typeof item === "string")
				.join(" ")
				.trim();
			if (planText.length > 0) {
				return truncate(planText, MAX_APPROACH_LENGTH);
			}
		}
	}

	const trimmed = plannerOutput.trim();
	return truncate(trimmed, MAX_APPROACH_LENGTH);
}

function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (isRecord(error)) {
		const shortMessage = error.shortMessage;
		if (typeof shortMessage === "string" && shortMessage.trim().length > 0) {
			return shortMessage;
		}

		const message = error.message;
		if (typeof message === "string" && message.trim().length > 0) {
			return message;
		}
	}

	return String(error);
}

function extractExitCode(error: unknown): number | null {
	if (!isRecord(error)) return null;
	const raw = error.exitCode;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function formatDuration(totalDurationMs: number): string {
	const totalSeconds = Math.max(0, Math.round(totalDurationMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export type ReviewerVerdictParseResult =
	| { valid: true; verdict: "pass" | "fail"; parsed: Record<string, unknown> }
	| {
			valid: false;
			reason:
				| "no_json_found"
				| "json_parse_error"
				| "missing_verdict_field"
				| "invalid_verdict_value";
	  };

export function parseReviewerVerdict(
	rawOutput: string,
): ReviewerVerdictParseResult {
	const candidateSource = stripFences(rawOutput ?? "").trim();
	const start = candidateSource.indexOf("{");
	if (start === -1) {
		return { valid: false, reason: "no_json_found" };
	}

	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;

	for (let i = start; i < candidateSource.length; i++) {
		const ch = candidateSource[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
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
		parsed = JSON.parse(jsonText) as unknown;
	} catch {
		return { valid: false, reason: "json_parse_error" };
	}

	if (!isRecord(parsed)) {
		return { valid: false, reason: "json_parse_error" };
	}

	const verdict = parsed.verdict;
	if (verdict === undefined) {
		return { valid: false, reason: "missing_verdict_field" };
	}
	if (typeof verdict !== "string") {
		return { valid: false, reason: "invalid_verdict_value" };
	}
	if (verdict !== "pass" && verdict !== "fail") {
		return { valid: false, reason: "invalid_verdict_value" };
	}

	return { valid: true, verdict, parsed };
}

export function extractContractTitle(contractJson: string): string {
	const raw = contractJson ?? "";
	if (raw.trim().length === 0) {
		return "(no title)";
	}

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (
			isRecord(parsed) &&
			typeof parsed.title === "string" &&
			parsed.title.trim().length > 0
		) {
			return truncate(parsed.title.trim(), MAX_TITLE_LENGTH);
		}

		const fallback = firstLine(JSON.stringify(parsed));
		return fallback.length > 0
			? truncate(fallback, MAX_TITLE_LENGTH)
			: "(no title)";
	} catch {
		const fallback = firstLine(raw);
		return fallback.length > 0
			? truncate(fallback, MAX_TITLE_LENGTH)
			: "(no title)";
	}
}

export function extractPlanSummary(plannerOutput: string): PlanSummary {
	const raw = plannerOutput ?? "";
	const parsed = parseFirstJsonRecord(raw);

	const targetFiles = parsed ? extractStructuredPlanFiles(parsed) : [];
	collectPathsFromText(targetFiles, raw);

	return {
		targetFiles: targetFiles.slice(0, PLAN_FILE_LIMIT),
		approach: summarizeApproach(raw, parsed),
	};
}

export function extractReviewerReasoning(rawOutput: string): string {
	const parsed = parseFirstJsonRecord(rawOutput ?? "");
	if (!parsed) return "";

	const fields: Array<"reasoning" | "notes" | "comments" | "explanation"> = [
		"reasoning",
		"notes",
		"comments",
		"explanation",
	];

	for (const field of fields) {
		const value = parsed[field];
		if (typeof value === "string" && value.trim().length > 0) {
			return truncate(value.trim(), MAX_REVIEWER_REASONING_LENGTH);
		}

		if (value !== undefined && value !== null && typeof value !== "string") {
			try {
				const serialized = JSON.stringify(value);
				if (serialized.length > 0) {
					return truncate(serialized, MAX_REVIEWER_REASONING_LENGTH);
				}
			} catch {
				// ignore serialization failures and continue
			}
		}
	}

	return "";
}

export function parseDiffStat(gitOutput: string): DiffStatResult {
	const raw = (gitOutput ?? "").trim();
	if (raw.length === 0) {
		return emptyDiffStat();
	}

	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);

	const changedFiles: string[] = [];
	const diffParts: string[] = [];

	let summaryFiles: number | null = null;
	let summaryInsertions = 0;
	let summaryDeletions = 0;

	let countedInsertions = 0;
	let countedDeletions = 0;

	for (const line of lines) {
		const summaryMatch = line.match(
			/(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/,
		);
		if (summaryMatch) {
			summaryFiles = Number(summaryMatch[1]);
			summaryInsertions = summaryMatch[2] ? Number(summaryMatch[2]) : 0;
			summaryDeletions = summaryMatch[3] ? Number(summaryMatch[3]) : 0;
			continue;
		}

		const separatorIndex = line.indexOf(" | ");
		if (separatorIndex === -1) continue;

		const filePath = line.slice(0, separatorIndex).trim();
		if (filePath.length === 0) continue;

		if (!changedFiles.includes(filePath)) {
			changedFiles.push(filePath);
		}

		const rhs = line.slice(separatorIndex + 3).trim();
		if (/\bBin\b/i.test(rhs)) {
			diffParts.push(`${filePath} (binary)`);
			continue;
		}

		const symbols = rhs.match(/[+-]+/)?.[0] ?? "";
		const insertions = (symbols.match(/\+/g) ?? []).length;
		const deletions = (symbols.match(/-/g) ?? []).length;

		countedInsertions += insertions;
		countedDeletions += deletions;

		diffParts.push(`${filePath} (+${insertions} -${deletions})`);
	}

	return {
		filesChanged: summaryFiles ?? changedFiles.length,
		insertions: summaryFiles === null ? countedInsertions : summaryInsertions,
		deletions: summaryFiles === null ? countedDeletions : summaryDeletions,
		diffStat: diffParts.join(", "),
		changedFiles,
	};
}

export async function getDiffStat(
	worktreePath: string,
	logger?: Pick<Logger, "warn">,
): Promise<DiffStatResult> {
	try {
		const { stdout } = await execa("git", ["diff", "--stat", "HEAD"], {
			cwd: worktreePath,
		});
		return parseDiffStat(stdout);
	} catch (error) {
		logger?.warn(
			{
				event: "coder_changes_unavailable",
				worktreePath,
				error: extractErrorMessage(error),
			},
			"unable to collect diff stat",
		);
		return emptyDiffStat();
	}
}

export async function writeTicketSummary(
	config: HarnessConfig,
	summary: TicketSummary,
	logger?: Pick<Logger, "warn">,
): Promise<void> {
	const summariesDir = join(config.project.root, SUMMARY_SUBDIR);
	const finalPath = join(summariesDir, `${summary.ticketId}.json`);
	const tmpPath = join(summariesDir, `${summary.ticketId}.tmp.json`);

	try {
		await mkdir(summariesDir, { recursive: true });
		await writeFile(tmpPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
		await rename(tmpPath, finalPath);
	} catch (error) {
		logger?.warn(
			{
				event: "ticket_summary_write_failed",
				ticketId: summary.ticketId,
				error: extractErrorMessage(error),
			},
			"failed to write ticket summary",
		);

		try {
			await unlink(tmpPath);
		} catch {
			// best effort cleanup
		}
	}
}

export function promptArtifactRelativePath(
	ticketId: string,
	sequence: number,
	attempt: number,
	stage: PromptStage,
): string {
	return `${PROMPT_SUBDIR}/${ticketId}/${sequence}-attempt${attempt}-${stage}.json`;
}

export function createPromptArtifact(input: {
	ticketId: string;
	stage: PromptStage;
	attempt: number;
	sequence: number;
	runtime: string;
	maxTurns: number;
	maxBudgetUsd: number;
	prompt: string;
	createdAt?: string;
}): PromptArtifact {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const promptHashSha256 = createHash("sha256")
		.update(input.prompt, "utf8")
		.digest("hex");

	return {
		ticketId: input.ticketId,
		stage: input.stage,
		attempt: input.attempt,
		sequence: input.sequence,
		runtime: input.runtime,
		maxTurns: input.maxTurns,
		maxBudgetUsd: input.maxBudgetUsd,
		createdAt,
		promptHashSha256,
		prompt: input.prompt,
	};
}

export async function writePromptArtifact(
	config: HarnessConfig,
	artifact: PromptArtifact,
	logger?: Pick<Logger, "warn">,
): Promise<string | null> {
	const relativePath = promptArtifactRelativePath(
		artifact.ticketId,
		artifact.sequence,
		artifact.attempt,
		artifact.stage,
	);
	const finalPath = join(config.project.root, relativePath);
	const tmpPath = `${finalPath}.tmp`;

	try {
		await mkdir(join(config.project.root, PROMPT_SUBDIR, artifact.ticketId), {
			recursive: true,
		});
		await writeFile(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		await rename(tmpPath, finalPath);
		return relativePath;
	} catch (error) {
		logger?.warn(
			{
				event: "prompt_artifact_write_failed",
				ticketId: artifact.ticketId,
				stage: artifact.stage,
				sequence: artifact.sequence,
				attempt: artifact.attempt,
				error: extractErrorMessage(error),
			},
			"failed to write prompt artifact",
		);

		try {
			await unlink(tmpPath);
		} catch {
			// best effort cleanup
		}

		return null;
	}
}

export class ExecutionPipeline {
	private readonly beads;
	private readonly semaphore: Semaphore;
	private readonly worktrees: WorktreeManager;
	private readonly merger: MergeCoordinator;
	private readonly runtimes: Map<string, AgentRuntime>;
	private readonly hitlGate: HITLGate;

	private runTicketIds: string[] = [];
	private runStartedAt: Date | null = null;
	private runTotalCost = 0;
	private runTicketsCompleted = 0;
	private runTicketsFailed = 0;
	private consecutiveEmptyPolls = 0;

	constructor(
		private readonly config: HarnessConfig,
		private readonly logger: Logger,
	) {
		this.beads = createBeadsClient(this.config.project.root);
		this.semaphore = new Semaphore(
			this.config.pipelines.execution.maxParallelAgents,
		);
		this.worktrees = new WorktreeManager(
			this.config.project.root,
			this.config.project.worktreeDir,
			this.config.project.canonicalBranch,
		);
		this.merger = new MergeCoordinator(
			this.config.project.root,
			this.config.project.canonicalBranch,
		);
		this.runtimes = new Map<string, AgentRuntime>();
		this.runtimes.set("claude-code", new ClaudeCodeRuntime());
		this.runtimes.set("codex", new CodexRuntime());
		this.hitlGate = new HITLGate(this.config.hitl.timeoutMinutes);
	}

	private getRuntime(name: string): AgentRuntime {
		const rt = this.runtimes.get(name);
		if (!rt)
			throw new PipelineError(`Unknown runtime: ${name}`, {
				pipeline: "execution",
			});
		return rt;
	}

	private resolveCostRate(runtimeName: string): CostRate {
		return (
			this.config.costRates.runtimes[runtimeName] ??
			this.config.costRates.default
		);
	}

	private estimateStageCost(
		result: AgentResult,
		runtimeName: string,
	): StageCost {
		const tokenUsage = {
			inputTokens: result.tokenUsage?.inputTokens ?? 0,
			outputTokens: result.tokenUsage?.outputTokens ?? 0,
			cacheReadTokens: result.tokenUsage?.cacheReadTokens,
			cacheWriteTokens: result.tokenUsage?.cacheWriteTokens,
		};

		const normalized: AgentResult = {
			...result,
			tokenUsage,
		};

		const rate = this.resolveCostRate(runtimeName);
		const costUsd = estimateCost(
			normalized,
			rate.inputPer1kUsd,
			rate.outputPer1kUsd,
		).total;

		return {
			inputTokens: tokenUsage.inputTokens,
			outputTokens: tokenUsage.outputTokens,
			cacheReadTokens: tokenUsage.cacheReadTokens,
			cacheWriteTokens: tokenUsage.cacheWriteTokens,
			costUsd,
		};
	}

	private createTicketMeta(ticket: Ticket): TicketExecutionMeta {
		const contract = ticket.description ?? ticket.title;
		return {
			startedAt: new Date(),
			title: extractContractTitle(contract),
			contractSummary: truncate(contract ?? "", MAX_TITLE_LENGTH),
			plan: null,
			diff: null,
			reviewerVerdict: null,
			reviewerReasoning: "",
			costs: {
				planner: null,
				coder: null,
				reviewer: null,
			},
			checkResults: [],
			plannerStage: null,
			coderStage: null,
			reviewerStage: null,
			promptArtifacts: [],
			nextPromptSequence: 1,
			outcome: null,
			mergeSha: null,
		};
	}

	private async capturePromptArtifact(
		ticketId: string,
		stage: PromptStage,
		prompt: string,
		stageConfig: {
			runtime: string;
			maxTurns: number;
			maxBudgetUsd: number;
		},
		attempt: number,
		meta: TicketExecutionMeta,
		log: Logger,
	): Promise<void> {
		const sequence = meta.nextPromptSequence;
		meta.nextPromptSequence += 1;

		const artifact = createPromptArtifact({
			ticketId,
			stage,
			attempt,
			sequence,
			runtime: stageConfig.runtime,
			maxTurns: stageConfig.maxTurns,
			maxBudgetUsd: stageConfig.maxBudgetUsd,
			prompt,
		});
		meta.promptArtifacts.push(artifact);

		const artifactPath = await writePromptArtifact(this.config, artifact, log);
		log.info(
			{
				event: "prompt_captured",
				stage,
				attempt,
				sequence,
				promptHashSha256: artifact.promptHashSha256,
				artifactPath,
			},
			`${ticketId} prompt_captured | ${stage} | attempt ${attempt} | seq ${sequence}`,
		);
	}

	private totalCost(meta: TicketExecutionMeta): number {
		return [meta.costs.planner, meta.costs.coder, meta.costs.reviewer]
			.filter((stage): stage is StageCost => stage !== null)
			.reduce((sum, stage) => sum + stage.costUsd, 0);
	}

	private addRunOutcome(summary: TicketSummary): void {
		if (this.runTicketIds.includes(summary.ticketId)) {
			return;
		}

		if (!this.runStartedAt) {
			this.runStartedAt = new Date(summary.startedAt);
		}

		this.runTicketIds.push(summary.ticketId);
		this.runTotalCost += summary.cost.totalUsd;
		if (summary.outcome === "failed") {
			this.runTicketsFailed += 1;
		} else {
			this.runTicketsCompleted += 1;
		}
	}

	private resetRunSummary(): void {
		this.runTicketIds = [];
		this.runStartedAt = null;
		this.runTotalCost = 0;
		this.runTicketsCompleted = 0;
		this.runTicketsFailed = 0;
	}

	private toRunSummary(): RunSummary | null {
		if (this.runTicketIds.length === 0) {
			return null;
		}

		const runStartedAt = this.runStartedAt ?? new Date();
		const totalDurationMs = Math.max(0, Date.now() - runStartedAt.getTime());
		const ticketCount = this.runTicketIds.length;

		return {
			ticketsCompleted: this.runTicketsCompleted,
			ticketsFailed: this.runTicketsFailed,
			ticketIds: [...this.runTicketIds],
			totalCostUsd: this.runTotalCost,
			totalDurationMs,
			averageCostPerTicket:
				ticketCount > 0 ? this.runTotalCost / ticketCount : 0,
			averageDurationPerTicket:
				ticketCount > 0 ? totalDurationMs / ticketCount : 0,
		};
	}

	flushRunSummary(reason: RunSummaryReason = "idle"): void {
		const summary = this.toRunSummary();
		if (!summary) {
			return;
		}

		const log = this.logger.child({ pipeline: "execution" });
		log.info(
			{
				event: "run_summary",
				reason,
				...summary,
			},
			`run_summary | ${summary.ticketsCompleted} completed | ${summary.ticketsFailed} failed | $${summary.totalCostUsd.toFixed(2)} total | ${formatDuration(summary.totalDurationMs)}`,
		);

		this.resetRunSummary();
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
		log.info(
			{ event: "tickets_polled", count: tickets.length },
			"polled execution tickets",
		);

		if (tickets.length === 0) {
			this.flushRunSummary("idle");

			if (this.consecutiveEmptyPolls === 0) {
				log.info({ event: "no_tickets" }, "no ready tickets");
			} else if (this.consecutiveEmptyPolls % 10 === 9) {
				const consecutive = this.consecutiveEmptyPolls + 1;
				const idleSinceMs =
					consecutive * this.config.pipelines.execution.pollIntervalMs;
				log.info(
					{
						event: "idle_heartbeat",
						consecutiveEmptyPolls: consecutive,
						idleSinceMs,
					},
					`idle_heartbeat | no tickets for ${Math.round(idleSinceMs / 60000)}m | polling continues`,
				);
			} else {
				log.debug(
					{
						event: "no_tickets",
						consecutiveEmptyPolls: this.consecutiveEmptyPolls + 1,
					},
					"no ready tickets",
				);
			}

			this.consecutiveEmptyPolls += 1;
			return;
		}

		this.consecutiveEmptyPolls = 0;

		const selected = tickets.slice(
			0,
			this.config.pipelines.execution.maxParallelAgents,
		);
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
				log.error(
					{ event: "ticket_failed", error: String(result.reason) },
					"ticket processing failed",
				);
			}
		}
	}

	private buildTicketSummary(
		ticket: Ticket,
		context: StateContext,
		meta: TicketExecutionMeta,
		outcome: "merged" | "failed" | "no_changes",
	): TicketSummary {
		const completedAt = new Date();
		const totalDurationMs = Math.max(
			0,
			completedAt.getTime() - meta.startedAt.getTime(),
		);
		const contract =
			typeof context.contractJson === "string"
				? context.contractJson
				: (ticket.description ?? ticket.title ?? "");
		const title = meta.title === "(no title)" ? ticket.title : meta.title;

		const diff = meta.diff ?? emptyDiffStat();
		const totalUsd = this.totalCost(meta);
		const retryCount = Number.isFinite(Number(context.retryCount))
			? Number(context.retryCount)
			: 0;
		const branch =
			typeof context.worktreeBranch === "string"
				? context.worktreeBranch
				: null;
		const shaFromCtx =
			typeof context.mergeSha === "string" ? context.mergeSha : null;
		const sha = meta.mergeSha ?? shaFromCtx;

		const plannerStage = meta.plannerStage
			? {
					runtime: meta.plannerStage.runtime,
					model: meta.plannerStage.model,
					durationMs: meta.plannerStage.durationMs,
					turns: meta.plannerStage.turns,
					approach: meta.plan?.approach ?? "",
					targetFiles: meta.plan?.targetFiles ?? [],
				}
			: null;

		const coderStage = meta.coderStage
			? {
					runtime: meta.coderStage.runtime,
					model: meta.coderStage.model,
					durationMs: meta.coderStage.durationMs,
					turns: meta.coderStage.turns,
					exitReason: meta.coderStage.exitReason,
					passed: meta.coderStage.passed,
					filesChanged: diff.filesChanged,
					insertions: diff.insertions,
					deletions: diff.deletions,
					diffStat: diff.diffStat,
					changedFiles: diff.changedFiles,
				}
			: null;

		const checksStage =
			meta.checkResults.length > 0 || typeof context.checksPassed === "boolean"
				? {
						allPassed:
							meta.checkResults.length > 0
								? meta.checkResults.every((result) => result.passed)
								: Boolean(context.checksPassed),
						results: meta.checkResults,
					}
				: null;

		const reviewerStage = meta.reviewerStage
			? {
					runtime: meta.reviewerStage.runtime,
					model: meta.reviewerStage.model,
					durationMs: meta.reviewerStage.durationMs,
					turns: meta.reviewerStage.turns,
					verdict: meta.reviewerVerdict,
					reasoning: meta.reviewerReasoning,
				}
			: null;

		const summary: TicketSummary = {
			ticketId: ticket.id,
			title,
			outcome,
			sha,
			branch,
			startedAt: meta.startedAt.toISOString(),
			completedAt: completedAt.toISOString(),
			totalDurationMs,
			retryCount,
			cost: {
				planner: meta.costs.planner,
				coder: meta.costs.coder,
				reviewer: meta.costs.reviewer,
				totalUsd,
			},
			stages: {
				planner: plannerStage,
				coder: coderStage,
				checks: checksStage,
				reviewer: reviewerStage,
			},
			promptArtifacts: [...meta.promptArtifacts].sort(
				(left, right) => left.sequence - right.sequence,
			),
			contract,
		};

		if (outcome === "failed") {
			if (
				typeof context.failureType === "string" &&
				context.failureType.length > 0
			) {
				summary.failureType = context.failureType;
			}
			if (
				typeof context.failureReason === "string" &&
				context.failureReason.length > 0
			) {
				summary.failureReason = context.failureReason;
			}
		}

		return summary;
	}

	private async emitFinalSummary(
		machine: StateMachine<ExecutionState>,
		ticket: Ticket,
		meta: TicketExecutionMeta,
		log: Logger,
	): Promise<void> {
		if (machine.state === "exec:completed") {
			const outcome = meta.outcome ?? "merged";
			const summary = this.buildTicketSummary(
				ticket,
				machine.ctx,
				meta,
				outcome,
			);
			const shortSha = summary.sha ? summary.sha.slice(0, 7) : null;
			const filesChanged = summary.stages.coder?.filesChanged ?? 0;

			log.info(
				{
					event: "ticket_summary",
					outcome: summary.outcome,
					sha: shortSha,
					title: summary.title,
					filesChanged,
					totalCost: summary.cost.totalUsd,
					totalDurationMs: summary.totalDurationMs,
					plannerCost: summary.cost.planner?.costUsd ?? 0,
					coderCost: summary.cost.coder?.costUsd ?? 0,
					reviewerCost: summary.cost.reviewer?.costUsd ?? 0,
					retryCount: summary.retryCount,
					promptArtifactsCount: summary.promptArtifacts.length,
				},
				`${ticket.id} ticket_summary | ${summary.outcome}${shortSha ? ` ${shortSha}` : ""} | "${summary.title}" | ${filesChanged} files | $${summary.cost.totalUsd.toFixed(2)} | ${formatDuration(summary.totalDurationMs)}`,
			);

			await writeTicketSummary(this.config, summary, log);
			this.addRunOutcome(summary);
			return;
		}

		if (machine.state === "exec:failed") {
			const summary = this.buildTicketSummary(
				ticket,
				machine.ctx,
				meta,
				"failed",
			);
			const failureType = summary.failureType ?? "unknown";
			log.warn(
				{
					event: "ticket_failed",
					title: summary.title,
					failureType,
					retryCount: summary.retryCount,
					totalCost: summary.cost.totalUsd,
					totalDurationMs: summary.totalDurationMs,
					promptArtifactsCount: summary.promptArtifacts.length,
				},
				`${ticket.id} ticket_failed | "${summary.title}" | reason: ${failureType} | retries: ${summary.retryCount} | $${summary.cost.totalUsd.toFixed(2)}`,
			);

			await writeTicketSummary(this.config, summary, log);
			this.addRunOutcome(summary);
		}
	}

	private async emitErroredSummary(
		ticket: Ticket,
		context: StateContext,
		meta: TicketExecutionMeta,
		log: Logger,
		error: unknown,
	): Promise<void> {
		const nextContext: StateContext = {
			...context,
			failureType:
				typeof context.failureType === "string"
					? context.failureType
					: "pipeline_error",
			failureReason:
				typeof context.failureReason === "string"
					? context.failureReason
					: extractErrorMessage(error),
		};

		const summary = this.buildTicketSummary(
			ticket,
			nextContext,
			{ ...meta, outcome: "failed" },
			"failed",
		);
		const failureType = summary.failureType ?? "pipeline_error";

		log.warn(
			{
				event: "ticket_failed",
				title: summary.title,
				failureType,
				retryCount: summary.retryCount,
				totalCost: summary.cost.totalUsd,
				totalDurationMs: summary.totalDurationMs,
				promptArtifactsCount: summary.promptArtifacts.length,
			},
			`${ticket.id} ticket_failed | "${summary.title}" | reason: ${failureType} | retries: ${summary.retryCount} | $${summary.cost.totalUsd.toFixed(2)}`,
		);

		await writeTicketSummary(this.config, summary, log);
		this.addRunOutcome(summary);
	}

	private async processTicket(
		ticket: Ticket,
		signal?: AbortSignal,
	): Promise<void> {
		const log = this.logger.child({
			pipeline: "execution",
			ticketId: ticket.id,
		});
		const execConfig = this.config.pipelines.execution;
		const meta = this.createTicketMeta(ticket);

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

			if (!this.runStartedAt) {
				this.runStartedAt = new Date();
			}

			// exec:claim → exec:generate_contract
			await machine.transition("exec:generate_contract");
			const contractTitle = extractContractTitle(
				machine.ctx.contractJson ?? "",
			);
			meta.title = contractTitle;
			meta.contractSummary = truncate(
				machine.ctx.contractJson ?? "",
				MAX_TITLE_LENGTH,
			);
			log.info(
				{
					event: "contract",
					title: contractTitle,
					contractSummary: meta.contractSummary,
				},
				`${ticket.id} contract | ${contractTitle}`,
			);

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

			await this.driveStateMachine(machine, ticket, meta, log, signal);
			await this.emitFinalSummary(machine, ticket, meta, log);
		} catch (error) {
			log.error(
				{ event: "error", error: extractErrorMessage(error) },
				"ticket failed",
			);

			try {
				await this.worktrees.cleanup(ticket.id);
			} catch {
				// best effort cleanup
			}

			await this.emitErroredSummary(
				ticket,
				machine.ctx,
				{ ...meta, outcome: "failed" },
				log,
				error,
			);

			throw new PipelineError(
				`Execution pipeline failed for ticket ${ticket.id}`,
				{
					pipeline: "execution",
					ticketId: ticket.id,
					cause: error instanceof Error ? error : undefined,
				},
			);
		}
	}

	private async driveStateMachine(
		machine: StateMachine<ExecutionState>,
		ticket: Ticket,
		meta: TicketExecutionMeta,
		log: Logger,
		signal?: AbortSignal,
	): Promise<void> {
		const execConfig = this.config.pipelines.execution;
		const terminalStates = new Set<ExecutionState>([
			"exec:completed",
			"exec:failed",
		]);

		while (!terminalStates.has(machine.state)) {
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
					const worktreePath = this.requireContextValue(
						ctx.worktreePath,
						"worktreePath",
						ticket.id,
					);
					const plannerRuntime = this.getRuntime(execConfig.planner.runtime);
					const plannerPrompt = buildPlannerPrompt(
						ctx.contractJson ?? "",
						ctx.retryCount,
						ctx.failureContext,
					);
					const plannerAttempt = Number(ctx.retryCount ?? 0);
					await this.capturePromptArtifact(
						ticket.id,
						"planner",
						plannerPrompt,
						{
							runtime: plannerRuntime.name,
							maxTurns: execConfig.planner.maxTurns,
							maxBudgetUsd: execConfig.planner.maxBudgetUsd,
						},
						plannerAttempt,
						meta,
						log,
					);

					log.info(
						{ event: "planner_start", runtime: plannerRuntime.name },
						"starting planner",
					);
					const plannerResult = await this.executeWithHeartbeat(
						plannerRuntime,
						plannerPrompt,
						{
							cwd: worktreePath,
							systemPrompt: "",
							maxTurns: execConfig.planner.maxTurns,
							maxBudgetUsd: execConfig.planner.maxBudgetUsd,
							signal,
						},
						"planner",
						log,
					);
					log.info(
						{ event: "planner_done", durationMs: plannerResult.durationMs },
						"planner finished",
					);

					meta.plannerStage = {
						runtime: plannerRuntime.name,
						model: null,
						durationMs: plannerResult.durationMs,
						turns: null,
					};
					meta.costs.planner = this.estimateStageCost(
						plannerResult,
						plannerRuntime.name,
					);

					if (plannerResult.exitReason === "aborted") {
						log.warn(
							{ event: "planner_aborted" },
							"planner aborted by shutdown",
						);
						return;
					}

					const plan = extractPlanSummary(plannerResult.rawOutput);
					meta.plan = plan;

					await machine.replaceContext((c) => ({
						...c,
						plannerOutput: plannerResult.rawOutput,
					}));

					log.info(
						{
							event: "plan_summary",
							targetFiles: plan.targetFiles,
							approach: plan.approach,
						},
						`${ticket.id} plan_summary | files: ${plan.targetFiles.join(", ")} | approach: ${plan.approach}`,
					);

					await machine.transition("exec:execute_code");
					break;
				}

				case "exec:execute_code": {
					const worktreePath = this.requireContextValue(
						ctx.worktreePath,
						"worktreePath",
						ticket.id,
					);
					const coderRuntime = this.getRuntime(execConfig.coder.runtime);
					const coderPrompt = buildCoderPrompt(
						ctx.contractJson ?? "",
						ctx.plannerOutput,
					);
					const coderAttempt = Number(ctx.retryCount ?? 0);
					await this.capturePromptArtifact(
						ticket.id,
						"coder",
						coderPrompt,
						{
							runtime: coderRuntime.name,
							maxTurns: execConfig.coder.maxTurns,
							maxBudgetUsd: execConfig.coder.maxBudgetUsd,
						},
						coderAttempt,
						meta,
						log,
					);

					log.info(
						{ event: "coder_start", runtime: coderRuntime.name },
						"starting coder",
					);
					const coderResult = await this.executeWithHeartbeat(
						coderRuntime,
						coderPrompt,
						{
							cwd: worktreePath,
							systemPrompt: "",
							maxTurns: execConfig.coder.maxTurns,
							maxBudgetUsd: execConfig.coder.maxBudgetUsd,
							signal,
						},
						"coder",
						log,
					);
					log.info(
						{
							event: "coder_done",
							passed: coderResult.passed,
							durationMs: coderResult.durationMs,
						},
						"coder finished",
					);

					meta.coderStage = {
						runtime: coderRuntime.name,
						model: null,
						durationMs: coderResult.durationMs,
						turns: null,
						exitReason: coderResult.exitReason,
						passed: coderResult.passed,
					};
					meta.costs.coder = this.estimateStageCost(
						coderResult,
						coderRuntime.name,
					);

					if (coderResult.exitReason === "aborted") {
						log.warn({ event: "coder_aborted" }, "coder aborted by shutdown");
						return;
					}

					if (
						coderResult.exitReason !== "completed" ||
						coderResult.passed === false
					) {
						await machine.replaceContext((c) => ({
							...c,
							agentResult: coderResult,
							retryCount: c.retryCount + 1,
							failureType: "coder_runtime_failure",
							failureReason: coderResult.exitReason,
							failureContext: buildFailureContext(
								undefined,
								undefined,
								coderResult.error ?? coderResult.exitReason,
							),
						}));
						await machine.transition("exec:cascade_check");
						break;
					}

					const diff = await getDiffStat(worktreePath, log);
					meta.diff = diff;
					if (diff.filesChanged === 0) {
						log.info(
							{
								event: "coder_changes",
								filesChanged: 0,
								insertions: 0,
								deletions: 0,
								diffStat: "",
								changedFiles: [],
							},
							`${ticket.id} coder_changes | no changes detected`,
						);
					} else {
						log.info(
							{
								event: "coder_changes",
								filesChanged: diff.filesChanged,
								insertions: diff.insertions,
								deletions: diff.deletions,
								diffStat: diff.diffStat,
								changedFiles: diff.changedFiles,
							},
							`${ticket.id} coder_changes | ${diff.filesChanged} files | ${diff.diffStat}`,
						);
					}

					await machine.replaceContext((c) => ({
						...c,
						agentResult: coderResult,
					}));
					await machine.transition("exec:deterministic_checks");
					break;
				}

				case "exec:deterministic_checks": {
					const worktreePath = this.requireContextValue(
						ctx.worktreePath,
						"worktreePath",
						ticket.id,
					);
					const checksResults: Array<{
						name: string;
						passed: boolean;
						output: string;
					}> = [];
					const checkResultSummary: CheckResult[] = [];

					for (const check of execConfig.checks) {
						const checkStartedAt = Date.now();
						try {
							const result = await execa("sh", ["-c", check.command], {
								cwd: worktreePath,
							});
							const durationMs = Date.now() - checkStartedAt;

							checksResults.push({
								name: check.name,
								passed: true,
								output: result.stdout,
							});
							checkResultSummary.push({
								name: check.name,
								passed: true,
								exitCode: result.exitCode ?? 0,
								durationMs,
							});
							log.info(
								{ event: "check_passed", check: check.name },
								`check passed: ${check.name}`,
							);
						} catch (error) {
							const durationMs = Date.now() - checkStartedAt;
							const errMsg = extractErrorMessage(error);
							const exitCode = extractExitCode(error);

							checksResults.push({
								name: check.name,
								passed: false,
								output: errMsg,
							});
							checkResultSummary.push({
								name: check.name,
								passed: false,
								exitCode,
								durationMs,
							});
							log.warn(
								{ event: "check_failed", check: check.name },
								`check failed: ${check.name}`,
							);
						}
					}

					meta.checkResults = checkResultSummary;

					const allPassed =
						checksResults.length === 0 ||
						checksResults.every((result) => result.passed);
					await machine.replaceContext((c) => ({
						...c,
						checksPassed: allPassed,
						checksResults,
					}));

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
					const worktreePath = this.requireContextValue(
						ctx.worktreePath,
						"worktreePath",
						ticket.id,
					);
					const reviewerRuntime = this.getRuntime(execConfig.reviewer.runtime);
					const reviewerPrompt = buildReviewerPrompt(
						ctx.contractJson ?? "",
						ctx.plannerOutput,
					);
					const reviewerAttempt = Number(ctx.retryCount ?? 0);
					await this.capturePromptArtifact(
						ticket.id,
						"reviewer",
						reviewerPrompt,
						{
							runtime: reviewerRuntime.name,
							maxTurns: execConfig.reviewer.maxTurns,
							maxBudgetUsd: execConfig.reviewer.maxBudgetUsd,
						},
						reviewerAttempt,
						meta,
						log,
					);

					log.info(
						{ event: "reviewer_start", runtime: reviewerRuntime.name },
						"starting reviewer",
					);
					const reviewResult = await this.executeWithHeartbeat(
						reviewerRuntime,
						reviewerPrompt,
						{
							cwd: worktreePath,
							systemPrompt: "",
							maxTurns: execConfig.reviewer.maxTurns,
							maxBudgetUsd: execConfig.reviewer.maxBudgetUsd,
							signal,
						},
						"reviewer",
						log,
					);
					log.info(
						{ event: "reviewer_done", durationMs: reviewResult.durationMs },
						"reviewer finished",
					);

					meta.reviewerStage = {
						runtime: reviewerRuntime.name,
						model: null,
						durationMs: reviewResult.durationMs,
						turns: null,
					};
					meta.costs.reviewer = this.estimateStageCost(
						reviewResult,
						reviewerRuntime.name,
					);

					if (reviewResult.exitReason === "aborted") {
						log.warn(
							{ event: "reviewer_aborted" },
							"reviewer aborted by shutdown",
						);
						return;
					}

					if (
						reviewResult.exitReason !== "completed" ||
						reviewResult.passed === false
					) {
						await machine.replaceContext((c) => ({
							...c,
							agentResult: reviewResult,
							retryCount: c.retryCount + 1,
							failureType: "reviewer_runtime_failure",
							failureReason: reviewResult.exitReason,
							failureContext: buildFailureContext(
								undefined,
								undefined,
								reviewResult.error ?? reviewResult.exitReason,
							),
						}));
						await machine.transition("exec:cascade_check");
						break;
					}

					const verdict = parseReviewerVerdict(reviewResult.rawOutput);
					const verdictValue = verdict.valid ? verdict.verdict : "invalid";
					const reasoning = extractReviewerReasoning(reviewResult.rawOutput);

					meta.reviewerVerdict = verdictValue;
					meta.reviewerReasoning = reasoning;

					log.info(
						{
							event: "reviewer_verdict",
							verdict: verdictValue,
							reasoning,
						},
						`${ticket.id} reviewer_verdict | ${verdictValue} | ${reasoning.slice(0, 100)}`,
					);

					await machine.replaceContext((c) => ({
						...c,
						agentResult: {
							...reviewResult,
							passed: verdict.valid && verdict.verdict === "pass",
						},
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
							failureContext: buildFailureContext(
								undefined,
								reviewResult.rawOutput,
							),
						}));
						await machine.transition("exec:cascade_check");
					}
					break;
				}

				case "exec:commit": {
					const worktreePath = this.requireContextValue(
						ctx.worktreePath,
						"worktreePath",
						ticket.id,
					);
					const hasChanges = await this.hasGitChanges(worktreePath);
					if (!hasChanges) {
						meta.outcome = "no_changes";

						await this.beads.close(ticket.id, "No changes produced by agent");
						await this.worktrees.cleanup(ticket.id);
						log.warn({ event: "no_changes" }, "no changes, ticket closed");

						await machine.transition("exec:merge");
						await machine.transition("exec:close_ticket");
						await machine.transition("exec:completed");
						break;
					}

					await execa("git", ["add", "-A"], { cwd: worktreePath });
					await execa(
						"git",
						["commit", "-m", `feat: ${ticket.title}\n\nTicket: ${ticket.id}`],
						{
							cwd: worktreePath,
						},
					);
					log.info({ event: "committed" }, "changes committed");

					if (ctx.mergeMode === "pr") {
						await machine.transition("exec:create_pr");
					} else {
						await machine.transition("exec:merge");
					}
					break;
				}

				case "exec:create_pr": {
					await machine.transition("exec:merge");
					break;
				}

				case "exec:merge": {
					const worktreeBranch = this.requireContextValue(
						ctx.worktreeBranch,
						"worktreeBranch",
						ticket.id,
					);
					const mergeResult = await this.merger.merge(worktreeBranch);
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
						log.warn(
							{ event: "merge_conflict", conflicts: mergeResult.conflicts },
							"merge conflict",
						);
						await machine.transition("exec:cascade_check");
						break;
					}

					meta.outcome = "merged";
					meta.mergeSha = mergeResult.commitSha ?? null;

					await machine.replaceContext((c) => ({
						...c,
						mergeConflict: false,
						mergeSha: mergeResult.commitSha,
					}));
					log.info({ event: "merged", sha: mergeResult.commitSha }, "merged");
					await machine.transition("exec:close_ticket");
					break;
				}

				case "exec:close_ticket": {
					await this.beads.close(
						ticket.id,
						"Completed by harness execution pipeline",
					);
					await this.worktrees.cleanup(ticket.id);
					log.info({ event: "completed" }, "ticket completed");
					await machine.transition("exec:completed");
					break;
				}

				case "exec:cascade_check": {
					const retryCount = ctx.retryCount;
					const maxRetries = Number(
						ctx.maxRetries ?? execConfig.maxRetriesPerTicket,
					);

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
						meta.outcome = "failed";
						await this.beads.update(ticket.id, { status: "open" });
						await this.worktrees.cleanup(ticket.id);
						await machine.transition("exec:failed");
					}
					break;
				}

				default:
					throw new PipelineError(`Unhandled state: ${state}`, {
						pipeline: "execution",
						ticketId: ticket.id,
					});
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
	): Promise<AgentResult> {
		const started = Date.now();
		const heartbeat = setInterval(() => {
			const elapsed = Math.round((Date.now() - started) / 1000);
			log.info(
				{ event: `${stage}_heartbeat`, elapsedSec: elapsed },
				`${stage} still running (${elapsed}s)`,
			);
		}, intervalMs);

		try {
			return await runtime.execute(prompt, {
				...config,
				logger: log.child({ stage }),
				streamOutput:
					this.config.pipelines.execution.streamAgentOutput ?? false,
			});
		} finally {
			clearInterval(heartbeat);
		}
	}

	private requireContextValue(
		value: string | undefined,
		field: string,
		ticketId: string,
	): string {
		if (!value) {
			throw new PipelineError(`Missing ${field} in execution context`, {
				pipeline: "execution",
				ticketId,
			});
		}
		return value;
	}

	private async hasGitChanges(cwd: string): Promise<boolean> {
		const { stdout } = await execa("git", ["status", "--porcelain"], { cwd });
		return stdout.trim().length > 0;
	}
}
