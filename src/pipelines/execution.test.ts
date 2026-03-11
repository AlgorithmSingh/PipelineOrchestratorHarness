import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "../beads/types.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { AgentResult } from "../runtime/types.js";
import type { HarnessConfig } from "../types.js";
import {
	createPromptArtifact,
	ExecutionPipeline,
	extractContractTitle,
	extractPlanSummary,
	extractReviewerReasoning,
	getDiffStat,
	parseDiffStat,
	parseReviewerVerdict,
	promptArtifactRelativePath,
	writePromptArtifact,
	writeTicketSummary,
} from "./execution.js";
import type { PromptArtifact, TicketSummary } from "./execution-types.js";

vi.mock("execa", () => ({
	execa: vi.fn(),
}));

const execaMock = vi.mocked(execa);

function createMockLogger(): {
	logger: Logger;
	info: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
	debug: ReturnType<typeof vi.fn>;
	error: ReturnType<typeof vi.fn>;
} {
	const info = vi.fn();
	const warn = vi.fn();
	const debug = vi.fn();
	const error = vi.fn();
	const child = vi.fn();

	const logger = {
		info,
		warn,
		debug,
		error,
		child,
	};

	child.mockImplementation(() => logger);

	return {
		logger: logger as unknown as Logger,
		info,
		warn,
		debug,
		error,
	};
}

function configForRoot(root: string): HarnessConfig {
	return {
		...DEFAULT_CONFIG,
		project: {
			...DEFAULT_CONFIG.project,
			root,
			worktreeDir: join(root, ".harness/worktrees"),
			stateDir: join(root, ".harness/state"),
			logDir: join(root, ".harness/logs"),
		},
	};
}

function sampleTicketSummary(ticketId = "ticket-1"): TicketSummary {
	return {
		ticketId,
		title: "Add due date field",
		outcome: "merged",
		sha: "abc123def456",
		branch: "agent/ticket-1",
		startedAt: "2026-03-10T17:46:35.000Z",
		completedAt: "2026-03-10T17:49:55.000Z",
		totalDurationMs: 200000,
		retryCount: 0,
		cost: {
			planner: null,
			coder: null,
			reviewer: null,
			totalUsd: 0,
		},
		stages: {
			planner: null,
			coder: null,
			checks: null,
			reviewer: null,
		},
		promptArtifacts: [],
		contract: "Add due date field to Todo items",
	};
}

function sampleTicket(id = "ticket-1"): Ticket {
	return {
		id,
		title: "Add due date field",
		status: "open",
		priority: 1,
		type: "task",
		description: "Add due date field to Todo items",
	};
}

function sampleAgentResult(
	inputTokens: number,
	outputTokens: number,
): AgentResult {
	return {
		passed: true,
		output: { text: "ok" },
		rawOutput: "ok",
		tokenUsage: {
			inputTokens,
			outputTokens,
		},
		exitReason: "completed",
		durationMs: 100,
	};
}

function samplePromptArtifact(
	overrides: Partial<PromptArtifact> = {},
): PromptArtifact {
	return {
		ticketId: "ticket-1",
		stage: "planner",
		attempt: 0,
		sequence: 1,
		runtime: "claude-code",
		maxTurns: 20,
		maxBudgetUsd: 2,
		createdAt: "2026-03-10T17:46:35.000Z",
		promptHashSha256:
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		prompt: "hello",
		...overrides,
	};
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("parseReviewerVerdict", () => {
	it("parses plain pass/fail JSON", () => {
		expect(parseReviewerVerdict('{"verdict":"pass"}')).toMatchObject({
			valid: true,
			verdict: "pass",
		});
		expect(parseReviewerVerdict('{"verdict":"fail"}')).toMatchObject({
			valid: true,
			verdict: "fail",
		});
	});

	it("parses fenced JSON with or without language tag", () => {
		const fenced = '```json\n{"verdict":"pass"}\n```';
		const fencedNoLang = '```\n{"verdict":"fail"}\n```';
		expect(parseReviewerVerdict(fenced)).toMatchObject({
			valid: true,
			verdict: "pass",
		});
		expect(parseReviewerVerdict(fencedNoLang)).toMatchObject({
			valid: true,
			verdict: "fail",
		});
	});

	it("ignores extra fields and uses the first JSON block", () => {
		const output = [
			"prologue",
			'{"verdict":"pass","summary":"ok"}',
			'{"verdict":"fail"}',
		].join("\n");
		expect(parseReviewerVerdict(output)).toMatchObject({
			valid: true,
			verdict: "pass",
		});
	});

	it("returns invalid for wrong verdict casing or type", () => {
		expect(parseReviewerVerdict('{"verdict":"Pass"}')).toMatchObject({
			valid: false,
			reason: "invalid_verdict_value",
		});
		expect(parseReviewerVerdict('{"verdict":true}')).toMatchObject({
			valid: false,
			reason: "invalid_verdict_value",
		});
	});

	it("handles missing verdict field", () => {
		expect(parseReviewerVerdict('{"result":"pass"}')).toMatchObject({
			valid: false,
			reason: "missing_verdict_field",
		});
	});

	it("handles malformed or absent JSON", () => {
		expect(parseReviewerVerdict("not json at all")).toMatchObject({
			valid: false,
			reason: "no_json_found",
		});
		expect(parseReviewerVerdict('{"verdict"')).toMatchObject({
			valid: false,
			reason: "json_parse_error",
		});
		expect(parseReviewerVerdict("")).toMatchObject({
			valid: false,
			reason: "no_json_found",
		});
	});

	it("balances nested braces when extracting the JSON object", () => {
		const output = '```\n{"verdict":"fail","details":{"nested":true}}\n```';
		expect(parseReviewerVerdict(output)).toMatchObject({
			valid: true,
			verdict: "fail",
		});
	});
});

describe("extractContractTitle", () => {
	it("extracts title from JSON input", () => {
		const title = extractContractTitle('{"title":"Add due date field"}');
		expect(title).toBe("Add due date field");
	});

	it("uses stringified JSON first line when title is missing", () => {
		const title = extractContractTitle('{"contract":"test"}');
		expect(title).toContain("contract");
	});

	it("uses first line from plain text", () => {
		const title = extractContractTitle("Line one\nLine two");
		expect(title).toBe("Line one");
	});

	it("returns fallback for empty input", () => {
		expect(extractContractTitle("")).toBe("(no title)");
	});

	it("falls back to raw first line for malformed JSON", () => {
		const title = extractContractTitle('{"title"\nSecond line');
		expect(title).toBe('{"title"');
	});
});

describe("extractPlanSummary", () => {
	it("extracts file paths from planner output", () => {
		const summary = extractPlanSummary(
			"Update src/store.ts and src/cli.ts with due date support.",
		);
		expect(summary.targetFiles).toEqual(["src/store.ts", "src/cli.ts"]);
	});

	it("limits extracted files to first 10 unique paths", () => {
		const output = Array.from(
			{ length: 15 },
			(_, i) => `src/file-${i}.ts`,
		).join(" ");
		const summary = extractPlanSummary(output);
		expect(summary.targetFiles).toHaveLength(10);
		expect(summary.targetFiles[0]).toBe("src/file-0.ts");
		expect(summary.targetFiles[9]).toBe("src/file-9.ts");
	});

	it("returns empty file list when no recognizable paths are present", () => {
		const summary = extractPlanSummary("Refactor logic and simplify flow.");
		expect(summary.targetFiles).toEqual([]);
	});

	it("truncates approach to 200 chars", () => {
		const text = "a".repeat(250);
		const summary = extractPlanSummary(text);
		expect(summary.approach).toHaveLength(200);
	});

	it("uses structured JSON approach field when provided", () => {
		const summary = extractPlanSummary(
			JSON.stringify({
				approach: "Add dueDate to model and command handlers",
				files: ["src/types.ts", "src/store.ts"],
			}),
		);
		expect(summary.approach).toBe("Add dueDate to model and command handlers");
		expect(summary.targetFiles).toEqual(["src/types.ts", "src/store.ts"]);
	});
});

describe("extractReviewerReasoning", () => {
	it("extracts reasoning field", () => {
		expect(extractReviewerReasoning('{"reasoning":"Looks good"}')).toBe(
			"Looks good",
		);
	});

	it("falls back to notes when reasoning is absent", () => {
		expect(extractReviewerReasoning('{"notes":"Need tests"}')).toBe(
			"Need tests",
		);
	});

	it("falls back to comments when reasoning and notes are absent", () => {
		expect(extractReviewerReasoning('{"comments":"Mismatch in schema"}')).toBe(
			"Mismatch in schema",
		);
	});

	it("returns empty string for JSON without matching fields", () => {
		expect(extractReviewerReasoning('{"verdict":"pass"}')).toBe("");
	});

	it("returns empty string for non-JSON input", () => {
		expect(extractReviewerReasoning("plain text")).toBe("");
	});

	it("truncates extracted reasoning at 300 chars", () => {
		const longReasoning = "x".repeat(350);
		const reasoning = extractReviewerReasoning(
			JSON.stringify({ reasoning: longReasoning }),
		);
		expect(reasoning).toHaveLength(300);
	});
});

describe("parseDiffStat", () => {
	it("parses normal output with file and summary counts", () => {
		const raw = [
			" src/store.ts | 18 +++++++++++++++---",
			" src/types.ts |  3 ++-",
			" src/cli.ts   | 10 ++++++++--",
			" 3 files changed, 25 insertions(+), 6 deletions(-)",
		].join("\n");

		const parsed = parseDiffStat(raw);
		expect(parsed.filesChanged).toBe(3);
		expect(parsed.insertions).toBe(25);
		expect(parsed.deletions).toBe(6);
		expect(parsed.changedFiles).toEqual([
			"src/store.ts",
			"src/types.ts",
			"src/cli.ts",
		]);
		expect(parsed.diffStat).toContain("src/store.ts (+15 -3)");
	});

	it("returns zero-values for empty output", () => {
		expect(parseDiffStat("")).toEqual({
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			diffStat: "",
			changedFiles: [],
		});
	});

	it("handles binary file lines without contributing to insertions/deletions", () => {
		const raw = [
			" image.png | Bin 0 -> 123 bytes",
			" src/app.ts | 2 +-",
			" 2 files changed, 1 insertion(+), 1 deletion(-)",
		].join("\n");

		const parsed = parseDiffStat(raw);
		expect(parsed.filesChanged).toBe(2);
		expect(parsed.insertions).toBe(1);
		expect(parsed.deletions).toBe(1);
		expect(parsed.changedFiles).toContain("image.png");
	});

	it("handles single-file output without summary line", () => {
		const raw = " src/app.ts | 4 ++--";
		const parsed = parseDiffStat(raw);

		expect(parsed.filesChanged).toBe(1);
		expect(parsed.insertions).toBe(2);
		expect(parsed.deletions).toBe(2);
		expect(parsed.changedFiles).toEqual(["src/app.ts"]);
	});
});

describe("getDiffStat", () => {
	it("parses git diff --stat output", async () => {
		execaMock.mockResolvedValue({
			stdout:
				" src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
		} as never);

		const result = await getDiffStat("/tmp/worktree");

		expect(result.filesChanged).toBe(1);
		expect(result.insertions).toBe(1);
		expect(result.deletions).toBe(1);
		expect(execaMock).toHaveBeenCalledWith("git", ["diff", "--stat", "HEAD"], {
			cwd: "/tmp/worktree",
		});
	});

	it("returns zero-values for empty diff output", async () => {
		execaMock.mockResolvedValue({ stdout: "" } as never);

		const result = await getDiffStat("/tmp/worktree");

		expect(result).toEqual({
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			diffStat: "",
			changedFiles: [],
		});
	});

	it("gracefully falls back when git diff command fails", async () => {
		execaMock.mockRejectedValue(new Error("not a git repo"));
		const warn = vi.fn();

		const result = await getDiffStat("/tmp/worktree", { warn } as Pick<
			Logger,
			"warn"
		>);

		expect(result).toEqual({
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			diffStat: "",
			changedFiles: [],
		});
		expect(warn).toHaveBeenCalled();
	});
});

describe("writeTicketSummary", () => {
	it("writes summary JSON to .harness/summaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-summary-"));
		const config = configForRoot(root);
		const summary = sampleTicketSummary("ticket-a");

		await writeTicketSummary(config, summary);

		const summaryPath = join(root, ".harness/summaries/ticket-a.json");
		const raw = await readFile(summaryPath, "utf8");
		expect(JSON.parse(raw) as TicketSummary).toMatchObject(summary);
	});

	it("cleans up temporary file after atomic rename", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-summary-"));
		const config = configForRoot(root);
		const summary = sampleTicketSummary("ticket-b");

		await writeTicketSummary(config, summary);

		const entries = await readdir(join(root, ".harness/summaries"));
		expect(entries).toContain("ticket-b.json");
		expect(entries.some((entry) => entry.endsWith(".tmp.json"))).toBe(false);
	});

	it("logs warning and does not throw when write fails", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "harness-summary-"));
		const rootFile = join(tmp, "root-file");
		await writeFile(rootFile, "not a directory", "utf8");

		const config = configForRoot(rootFile);
		const summary = sampleTicketSummary("ticket-c");
		const warn = vi.fn();

		await expect(
			writeTicketSummary(config, summary, { warn } as Pick<Logger, "warn">),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});
});

describe("prompt artifacts", () => {
	it("creates deterministic SHA-256 hash for prompt content", () => {
		const artifact = createPromptArtifact({
			ticketId: "ticket-1",
			stage: "planner",
			attempt: 0,
			sequence: 1,
			runtime: "claude-code",
			maxTurns: 20,
			maxBudgetUsd: 2,
			prompt: "hello",
			createdAt: "2026-03-10T17:46:35.000Z",
		});

		expect(artifact.promptHashSha256).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);
		expect(artifact.prompt).toBe("hello");
	});

	it("builds expected prompt artifact relative path", () => {
		expect(promptArtifactRelativePath("ticket-abc", 3, 2, "coder")).toBe(
			".harness/prompts/ticket-abc/3-attempt2-coder.json",
		);
	});

	it("writes prompt artifact JSON with atomic rename", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-prompts-"));
		const config = configForRoot(root);
		const artifact = samplePromptArtifact({
			ticketId: "ticket-a",
			stage: "reviewer",
			sequence: 7,
			attempt: 1,
		});

		const relativePath = await writePromptArtifact(config, artifact);
		const absolutePath = join(root, relativePath ?? "");

		expect(relativePath).toBe(
			".harness/prompts/ticket-a/7-attempt1-reviewer.json",
		);
		const raw = await readFile(absolutePath, "utf8");
		expect(JSON.parse(raw) as PromptArtifact).toMatchObject(artifact);
		const entries = await readdir(join(root, ".harness/prompts/ticket-a"));
		expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
	});

	it("logs warning and does not throw when prompt artifact write fails", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "harness-prompts-"));
		const rootFile = join(tmp, "root-file");
		await writeFile(rootFile, "not a directory", "utf8");
		const config = configForRoot(rootFile);
		const warn = vi.fn();

		const result = await writePromptArtifact(config, samplePromptArtifact(), {
			warn,
		} as Pick<Logger, "warn">);

		expect(result).toBeNull();
		expect(warn).toHaveBeenCalled();
	});
});

describe("ExecutionPipeline run summary + idle behavior", () => {
	it("captures planner/coder/reviewer prompts with sequence and retry attempt", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-prompt-capture-"));
		const { logger, info } = createMockLogger();
		const pipeline = new ExecutionPipeline(configForRoot(root), logger);
		const ticket = sampleTicket("ticket-prompt");

		const internal = pipeline as unknown as {
			createTicketMeta: (ticketArg: Ticket) => {
				promptArtifacts: PromptArtifact[];
				nextPromptSequence: number;
			};
			capturePromptArtifact: (
				ticketId: string,
				stage: "planner" | "coder" | "reviewer",
				prompt: string,
				stageConfig: {
					runtime: string;
					maxTurns: number;
					maxBudgetUsd: number;
				},
				attempt: number,
				meta: { promptArtifacts: PromptArtifact[]; nextPromptSequence: number },
				log: Logger,
			) => Promise<void>;
		};

		const meta = internal.createTicketMeta(ticket);
		await internal.capturePromptArtifact(
			ticket.id,
			"planner",
			"planner prompt",
			{ runtime: "claude-code", maxTurns: 20, maxBudgetUsd: 2 },
			0,
			meta,
			logger,
		);
		await internal.capturePromptArtifact(
			ticket.id,
			"coder",
			"coder prompt",
			{ runtime: "claude-code", maxTurns: 50, maxBudgetUsd: 5 },
			0,
			meta,
			logger,
		);
		await internal.capturePromptArtifact(
			ticket.id,
			"reviewer",
			"reviewer prompt",
			{ runtime: "claude-code", maxTurns: 15, maxBudgetUsd: 1 },
			1,
			meta,
			logger,
		);

		expect(meta.promptArtifacts).toHaveLength(3);
		expect(meta.promptArtifacts.map((artifact) => artifact.sequence)).toEqual([
			1, 2, 3,
		]);
		expect(meta.promptArtifacts.map((artifact) => artifact.attempt)).toEqual([
			0, 0, 1,
		]);
		expect(meta.promptArtifacts.map((artifact) => artifact.stage)).toEqual([
			"planner",
			"coder",
			"reviewer",
		]);

		const entries = await readdir(join(root, ".harness/prompts/ticket-prompt"));
		expect(entries).toEqual(
			expect.arrayContaining([
				"1-attempt0-planner.json",
				"2-attempt0-coder.json",
				"3-attempt1-reviewer.json",
			]),
		);

		const promptCaptureLogs = info.mock.calls.filter((call) => {
			const [payload] = call as [Record<string, unknown>, string];
			return payload.event === "prompt_captured";
		});
		expect(promptCaptureLogs).toHaveLength(3);
	});

	it("includes sorted promptArtifacts in ticket summary output", () => {
		const { logger } = createMockLogger();
		const pipeline = new ExecutionPipeline(
			configForRoot("/tmp/project"),
			logger,
		);
		const ticket = sampleTicket("ticket-summary-prompts");

		const internal = pipeline as unknown as {
			createTicketMeta: (ticketArg: Ticket) => Record<string, unknown>;
			buildTicketSummary: (
				ticketArg: Ticket,
				context: {
					retryCount: number;
					contractJson: string;
					worktreeBranch?: string;
					mergeSha?: string;
				},
				meta: {
					startedAt: Date;
					promptArtifacts: PromptArtifact[];
					plan: null;
					diff: null;
					reviewerVerdict: null;
					reviewerReasoning: string;
					costs: { planner: null; coder: null; reviewer: null };
					checkResults: [];
					plannerStage: null;
					coderStage: null;
					reviewerStage: null;
					outcome: "merged" | "failed" | "no_changes" | null;
					mergeSha: string | null;
					title: string;
					contractSummary: string;
				},
				outcome: "merged" | "failed" | "no_changes",
			) => TicketSummary;
		};

		const meta = internal.createTicketMeta(ticket) as {
			promptArtifacts: PromptArtifact[];
		};
		meta.promptArtifacts = [
			samplePromptArtifact({
				ticketId: ticket.id,
				stage: "coder",
				sequence: 2,
			}),
			samplePromptArtifact({
				ticketId: ticket.id,
				stage: "planner",
				sequence: 1,
			}),
		];

		const summary = internal.buildTicketSummary(
			ticket,
			{
				retryCount: 1,
				contractJson: ticket.description ?? ticket.title,
				mergeSha: "abc123",
			},
			meta as Parameters<typeof internal.buildTicketSummary>[2],
			"merged",
		);

		expect(summary.promptArtifacts).toHaveLength(2);
		expect(
			summary.promptArtifacts.map((artifact) => artifact.sequence),
		).toEqual([1, 2]);
	});

	it("accumulates stage cost from token usage", () => {
		const { logger } = createMockLogger();
		const pipeline = new ExecutionPipeline(
			configForRoot("/tmp/project"),
			logger,
		);

		const internal = pipeline as unknown as {
			estimateStageCost: (
				result: AgentResult,
				runtimeName: string,
			) => { costUsd: number };
		};

		const planner = internal.estimateStageCost(
			sampleAgentResult(1000, 500),
			"claude-code",
		);
		const coder = internal.estimateStageCost(
			sampleAgentResult(2000, 500),
			"claude-code",
		);
		const reviewer = internal.estimateStageCost(
			sampleAgentResult(0, 0),
			"claude-code",
		);

		expect(planner.costUsd).toBeCloseTo(0.0105, 8);
		expect(coder.costUsd).toBeCloseTo(0.0135, 8);
		expect(reviewer.costUsd).toBe(0);
		expect(planner.costUsd + coder.costUsd + reviewer.costUsd).toBeCloseTo(
			0.024,
			8,
		);
	});

	it("flushRunSummary emits rollup and resets accumulators", () => {
		const { logger, info } = createMockLogger();
		const pipeline = new ExecutionPipeline(
			configForRoot("/tmp/project"),
			logger,
		);

		const internal = pipeline as unknown as {
			runTicketIds: string[];
			runStartedAt: Date | null;
			runTotalCost: number;
			runTicketsCompleted: number;
			runTicketsFailed: number;
		};

		internal.runTicketIds = ["ticket-1", "ticket-2"];
		internal.runStartedAt = new Date(Date.now() - 60_000);
		internal.runTotalCost = 1.75;
		internal.runTicketsCompleted = 1;
		internal.runTicketsFailed = 1;

		pipeline.flushRunSummary("shutdown");

		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "run_summary",
				reason: "shutdown",
				ticketsCompleted: 1,
				ticketsFailed: 1,
				totalCostUsd: 1.75,
			}),
			expect.stringContaining("run_summary"),
		);
		expect(internal.runTicketIds).toEqual([]);
		expect(internal.runStartedAt).toBeNull();

		pipeline.flushRunSummary("shutdown");
		expect(info).toHaveBeenCalledTimes(1);
	});

	it("suppresses idle noise and resets counter after tickets are found", async () => {
		const { logger, info, debug } = createMockLogger();
		const pipeline = new ExecutionPipeline(
			configForRoot("/tmp/project"),
			logger,
		);

		const internal = pipeline as unknown as {
			beads: {
				healthCheck: ReturnType<typeof vi.fn>;
				ready: ReturnType<typeof vi.fn>;
			};
			processTicket: ReturnType<typeof vi.fn>;
			runTicketIds: string[];
			runStartedAt: Date | null;
			runTotalCost: number;
			runTicketsCompleted: number;
			runTicketsFailed: number;
		};

		const ready = vi.fn().mockResolvedValue([]);
		internal.beads = {
			healthCheck: vi.fn().mockResolvedValue(true),
			ready,
		};
		internal.processTicket = vi.fn().mockResolvedValue(undefined);

		for (let i = 0; i < 10; i++) {
			await pipeline.runOnce();
		}

		const infoEvents = info.mock.calls.map((call) => {
			const [payload] = call as [Record<string, unknown>, string];
			return payload.event;
		});

		expect(infoEvents.filter((event) => event === "no_tickets")).toHaveLength(
			1,
		);
		expect(infoEvents).toContain("idle_heartbeat");

		const debugEvents = debug.mock.calls.map((call) => {
			const [payload] = call as [Record<string, unknown>, string];
			return payload.event;
		});
		expect(
			debugEvents.filter((event) => event === "no_tickets").length,
		).toBeGreaterThanOrEqual(8);

		ready.mockResolvedValueOnce([sampleTicket("ticket-reset")]);
		await pipeline.runOnce();
		await pipeline.runOnce();

		const noTicketInfosAfterReset = info.mock.calls.filter((call) => {
			const [payload] = call as [Record<string, unknown>, string];
			return payload.event === "no_tickets";
		});
		expect(noTicketInfosAfterReset).toHaveLength(2);
	});

	it("emits run summary on idle when run accumulators are populated", async () => {
		const { logger, info } = createMockLogger();
		const pipeline = new ExecutionPipeline(
			configForRoot("/tmp/project"),
			logger,
		);

		const internal = pipeline as unknown as {
			beads: {
				healthCheck: ReturnType<typeof vi.fn>;
				ready: ReturnType<typeof vi.fn>;
			};
			runTicketIds: string[];
			runStartedAt: Date | null;
			runTotalCost: number;
			runTicketsCompleted: number;
			runTicketsFailed: number;
		};

		internal.beads = {
			healthCheck: vi.fn().mockResolvedValue(true),
			ready: vi.fn().mockResolvedValue([]),
		};

		internal.runTicketIds = ["ticket-rollup"];
		internal.runStartedAt = new Date(Date.now() - 5_000);
		internal.runTotalCost = 0.42;
		internal.runTicketsCompleted = 1;
		internal.runTicketsFailed = 0;

		await pipeline.runOnce();

		const runSummaryLog = info.mock.calls.find((call) => {
			const [payload] = call as [Record<string, unknown>, string];
			return payload.event === "run_summary";
		});

		expect(runSummaryLog).toBeDefined();
	});
});
