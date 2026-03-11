#!/usr/bin/env node

import { Command } from "commander";
import { initProject } from "./commands/init.js";
import { loadConfig } from "./config.js";
import { HarnessOrchestrator, type PipelineSelector } from "./orchestrator.js";
import { createLogger } from "./util/logger.js";

const program = new Command();

program
	.name("harness")
	.description("Pipeline Orchestrator Harness")
	.version("0.1.0")
	.option(
		"--project <path>",
		"Target project directory (must have .beads/ initialized)",
		process.cwd(),
	);

program
	.command("start")
	.description("Start enabled pipelines")
	.option(
		"--pipeline <name>",
		"Run only one pipeline (execution|plan|adversarial)",
	)
	.option("--once", "Run only one polling cycle")
	.action(async (options: { pipeline?: string; once?: boolean }) => {
		const parentOpts = program.opts<{ project: string }>();
		const config = await loadConfig(process.cwd(), parentOpts.project);
		const logger = createLogger();
		const selector = parsePipeline(options.pipeline);
		const orchestrator = new HarnessOrchestrator(config, logger);

		if (options.once) {
			await orchestrator.runOnce(selector);
			if (!selector || selector === "execution") {
				orchestrator.flushExecutionRunSummary("once");
			}
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
		const parentOpts = program.opts<{ project: string }>();
		const config = await loadConfig(process.cwd(), parentOpts.project);
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
		const parentOpts = program.opts<{ project: string }>();
		await loadConfig(process.cwd(), parentOpts.project);
		process.stdout.write("Config is valid.\n");
	});

program
	.command("init")
	.description("Initialize a new project with Beads, git, and harness config")
	.argument("<path>", "Directory to initialize")
	.option(
		"--beads-prefix <prefix>",
		"Override Beads issue prefix (default: target directory name)",
	)
	.option(
		"--beads-database <database>",
		"Use an existing Dolt server database for Beads init",
	)
	.option("--beads-server-host <host>", "Beads Dolt server host override")
	.option("--beads-server-port <port>", "Beads Dolt server port override")
	.option(
		"--project-type <node|python>",
		"Project type for capability detection",
	)
	.option(
		"--check <name=command>",
		"Override detected checks (repeatable)",
		(value, prev: string[]) => {
			prev.push(value);
			return prev;
		},
		[],
	)
	.action(
		async (
			path: string,
			options: {
				beadsPrefix?: string;
				beadsDatabase?: string;
				beadsServerHost?: string;
				beadsServerPort?: string;
				projectType?: "node" | "python";
				check: string[];
			},
		) => {
			await initProject(path, {
				beadsPrefix: options.beadsPrefix,
				beadsDatabase: options.beadsDatabase,
				beadsServerHost: options.beadsServerHost,
				beadsServerPort: options.beadsServerPort
					? Number(options.beadsServerPort)
					: undefined,
				projectType: options.projectType,
				checks: options.check,
			});
		},
	);

program
	.command("plan")
	.description("Trigger plan generation from a spec file")
	.argument("<spec-file>")
	.action((specFile: string) => {
		process.stdout.write(
			`Plan command scaffolded. Requested spec: ${specFile}\n`,
		);
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
	throw new Error(
		`Invalid pipeline '${input}'. Use execution|plan|adversarial.`,
	);
}

program.parseAsync(process.argv).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
