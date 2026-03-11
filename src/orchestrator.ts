import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import { AdversarialPipeline } from "./pipelines/adversarial.js";
import { ExecutionPipeline } from "./pipelines/execution.js";
import { PlanGenerationPipeline } from "./pipelines/plan-generation.js";
import type { HarnessConfig } from "./types.js";

export type PipelineSelector = "execution" | "plan" | "adversarial";
export type RunSummaryFlushReason = "idle" | "shutdown" | "once";

export class HarnessOrchestrator {
	private running = false;
	private abortController: AbortController | null = null;
	private readonly executionPipeline: ExecutionPipeline;
	private readonly planPipeline: PlanGenerationPipeline;
	private readonly adversarialPipeline: AdversarialPipeline;

	constructor(
		private readonly config: HarnessConfig,
		private readonly logger: Logger,
	) {
		this.executionPipeline = new ExecutionPipeline(config, logger);
		this.planPipeline = new PlanGenerationPipeline(config, logger);
		this.adversarialPipeline = new AdversarialPipeline(config, logger);
	}

	get signal(): AbortSignal | undefined {
		return this.abortController?.signal;
	}

	async runOnce(selector?: PipelineSelector): Promise<void> {
		const signal = this.abortController?.signal;

		if (!selector || selector === "execution") {
			if (this.config.pipelines.execution.enabled) {
				await this.executionPipeline.runOnce(signal);
			}
		}

		if (!selector || selector === "plan") {
			if (this.config.pipelines.planGeneration.enabled) {
				await this.planPipeline.runOnce();
			}
		}

		if (!selector || selector === "adversarial") {
			if (this.config.pipelines.adversarial.enabled) {
				await this.adversarialPipeline.runOnce();
			}
		}
	}

	async start(selector?: PipelineSelector): Promise<void> {
		this.running = true;
		this.abortController = new AbortController();
		this.logger.info(
			{ pipeline: "harness", event: "start", selector },
			"harness orchestrator started",
		);

		while (this.running) {
			await this.runOnce(selector);
			if (!this.running) break;
			await sleep(this.pollInterval(selector));
		}
	}

	stop(): void {
		this.running = false;
		this.abortController?.abort();
		this.executionPipeline.flushRunSummary("shutdown");
		this.logger.info(
			{ pipeline: "harness", event: "stop" },
			"harness orchestrator stopping",
		);
	}

	flushExecutionRunSummary(reason: RunSummaryFlushReason = "idle"): void {
		this.executionPipeline.flushRunSummary(reason);
	}

	private pollInterval(selector?: PipelineSelector): number {
		if (selector === "execution")
			return this.config.pipelines.execution.pollIntervalMs;
		if (selector === "plan")
			return this.config.pipelines.planGeneration.enabled ? 30_000 : 5_000;
		if (selector === "adversarial")
			return this.config.pipelines.adversarial.pollIntervalMs;
		return Math.min(
			this.config.pipelines.execution.pollIntervalMs,
			this.config.pipelines.adversarial.pollIntervalMs,
		);
	}
}
