import type { Logger } from "pino";
import type { HarnessConfig } from "../types.js";

export class PlanGenerationPipeline {
  constructor(
    private readonly config: HarnessConfig,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    this.logger.info(
      {
        pipeline: "plan",
        event: "plan_pipeline_placeholder",
        enabled: this.config.pipelines.planGeneration.enabled,
      },
      "plan generation pipeline is scaffolded but not fully implemented",
    );
  }
}
