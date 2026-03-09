import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { HarnessConfig } from "./types.js";
import { AdversarialPipeline } from "./pipelines/adversarial.js";
import { ExecutionPipeline } from "./pipelines/execution.js";
import { PlanGenerationPipeline } from "./pipelines/plan-generation.js";

export type PipelineSelector = "execution" | "plan" | "adversarial";

export class HarnessOrchestrator {
  private running = false;
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

  async runOnce(selector?: PipelineSelector): Promise<void> {
    if (!selector || selector === "execution") {
      if (this.config.pipelines.execution.enabled) {
        await this.executionPipeline.runOnce();
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
    this.logger.info({ pipeline: "harness", event: "start", selector }, "harness orchestrator started");

    while (this.running) {
      await this.runOnce(selector);
      await sleep(this.pollInterval(selector));
    }
  }

  stop(): void {
    this.running = false;
    this.logger.info({ pipeline: "harness", event: "stop" }, "harness orchestrator stopping");
  }

  private pollInterval(selector?: PipelineSelector): number {
    if (selector === "execution") return this.config.pipelines.execution.pollIntervalMs;
    if (selector === "plan") return this.config.pipelines.planGeneration.enabled ? 30_000 : 5_000;
    if (selector === "adversarial") return this.config.pipelines.adversarial.pollIntervalMs;
    return Math.min(
      this.config.pipelines.execution.pollIntervalMs,
      this.config.pipelines.adversarial.pollIntervalMs,
    );
  }
}
