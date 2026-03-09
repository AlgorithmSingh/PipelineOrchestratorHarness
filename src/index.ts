#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { HarnessOrchestrator, type PipelineSelector } from "./orchestrator.js";
import { createLogger } from "./util/logger.js";

const program = new Command();

program
  .name("harness")
  .description("Pipeline Orchestrator Harness")
  .version("0.1.0");

program
  .command("start")
  .description("Start enabled pipelines")
  .option("--pipeline <name>", "Run only one pipeline (execution|plan|adversarial)")
  .option("--once", "Run only one polling cycle")
  .action(async (options: { pipeline?: string; once?: boolean }) => {
    const config = await loadConfig(process.cwd());
    const logger = createLogger();
    const selector = parsePipeline(options.pipeline);
    const orchestrator = new HarnessOrchestrator(config, logger);

    if (options.once) {
      await orchestrator.runOnce(selector);
      return;
    }

    const shutdown = (): void => {
      orchestrator.stop();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await orchestrator.start(selector);
  });

program
  .command("status")
  .description("Show current config and enabled pipelines")
  .action(async () => {
    const config = await loadConfig(process.cwd());
    const payload = {
      project: config.project.name,
      root: config.project.root,
      pipelines: {
        execution: config.pipelines.execution.enabled,
        plan: config.pipelines.planGeneration.enabled,
        adversarial: config.pipelines.adversarial.enabled,
      },
      runtimeDefaults: {
        execution: config.pipelines.execution.runtime,
        executionFallback: config.pipelines.execution.fallbackRuntime,
        plan: config.pipelines.planGeneration.runtime,
      },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  });

program
  .command("config")
  .description("Config operations")
  .command("validate")
  .description("Validate harness configuration")
  .action(async () => {
    await loadConfig(process.cwd());
    process.stdout.write("Config is valid.\n");
  });

program
  .command("plan")
  .description("Trigger plan generation from a spec file")
  .argument("<spec-file>")
  .action((specFile: string) => {
    process.stdout.write(`Plan command scaffolded. Requested spec: ${specFile}\n`);
  });

program
  .command("retry")
  .description("Manually retry a failed ticket")
  .argument("<ticket-id>")
  .action((ticketId: string) => {
    process.stdout.write(`Retry command scaffolded for ticket: ${ticketId}\n`);
  });

program
  .command("abort")
  .description("Abort ticket and cleanup its worktree")
  .argument("<ticket-id>")
  .action((ticketId: string) => {
    process.stdout.write(`Abort command scaffolded for ticket: ${ticketId}\n`);
  });

program
  .command("metrics")
  .description("Print metrics summary")
  .action(() => {
    process.stdout.write("Metrics command scaffolded.\n");
  });

function parsePipeline(input?: string): PipelineSelector | undefined {
  if (!input) return undefined;
  if (input === "execution" || input === "plan" || input === "adversarial") {
    return input;
  }
  throw new Error(`Invalid pipeline '${input}'. Use execution|plan|adversarial.`);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
