import type { Logger } from "pino";
import type { HarnessConfig } from "../types.js";

export class AdversarialPipeline {
  constructor(
    private readonly config: HarnessConfig,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    this.logger.info(
      {
        pipeline: "adversarial",
        event: "adversarial_pipeline_placeholder",
        enabled: this.config.pipelines.adversarial.enabled,
      },
      "adversarial pipeline is scaffolded but not fully implemented",
    );
  }
}
