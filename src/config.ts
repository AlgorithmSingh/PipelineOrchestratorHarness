import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { ConfigError } from "./errors.js";
import type { HarnessConfig } from "./types.js";

const CONFIG_PATH = "config/harness.yaml";
const CONFIG_LOCAL_PATH = "config/harness.local.yaml";

export const DEFAULT_CONFIG: HarnessConfig = {
  project: {
    name: "pipeline-orchestrator-harness",
    root: ".",
    worktreeDir: ".harness/worktrees",
    stateDir: ".harness/state",
    logDir: ".harness/logs",
    canonicalBranch: "main",
  },
  pipelines: {
    planGeneration: {
      enabled: false,
      runtime: "claude-code",
      model: "opus",
    },
    execution: {
      enabled: true,
      maxParallelAgents: 1,
      pollIntervalMs: 30_000,
      maxRetriesPerTicket: 3,
      runtime: "claude-code",
      fallbackRuntime: "codex",
      maxRetriesBeforeFallback: 2,
      mergeMode: "direct",
      checks: [
        { name: "TypeScript", command: "npm run typecheck" },
        { name: "Lint", command: "npm run lint" },
      ],
      worktreeSetup: ["[ -f package.json ] && npm install || true"],
      planner: { runtime: "claude-code", maxTurns: 20, maxBudgetUsd: 2 },
      coder: { runtime: "claude-code", maxTurns: 50, maxBudgetUsd: 5 },
      reviewer: { runtime: "claude-code", maxTurns: 15, maxBudgetUsd: 1 },
    },
    adversarial: {
      enabled: false,
      pollIntervalMs: 60_000,
      maxParallelTargets: 2,
      targetStrategy: "recent",
      targetsPerRun: 5,
      bugFinder: { runtime: "codex", maxTurns: 30, maxBudgetUsd: 3, aggressiveness: 0.8 },
      adversarialRefuter: { runtime: "claude-code", maxTurns: 10, maxBudgetUsd: 1 },
      referee: { runtime: "claude-code", maxTurns: 5, maxBudgetUsd: 0.5, model: "haiku" },
    },
  },
  runtimes: {
    "claude-code": { type: "claude-code" },
    codex: { type: "codex", approvalPolicy: "never", sandbox: "workspace-write" },
  },
  hitl: {
    notifyMethod: "terminal",
    webhookUrl: "",
    timeoutMinutes: 1440,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) {
    return (patch as T) ?? base;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = result[key];
    if (isRecord(existing) && isRecord(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function validateConfig(config: HarnessConfig, configPath: string): void {
  if (config.project.name.trim().length === 0) {
    throw new ConfigError("project.name cannot be empty", {
      configPath,
      field: "project.name",
    });
  }
  if (config.pipelines.execution.maxParallelAgents <= 0) {
    throw new ConfigError("execution.maxParallelAgents must be > 0", {
      configPath,
      field: "pipelines.execution.maxParallelAgents",
    });
  }
  if (config.pipelines.execution.pollIntervalMs < 1000) {
    throw new ConfigError("execution.pollIntervalMs must be >= 1000", {
      configPath,
      field: "pipelines.execution.pollIntervalMs",
    });
  }
  if (config.hitl.timeoutMinutes <= 0) {
    throw new ConfigError("hitl.timeoutMinutes must be > 0", {
      configPath,
      field: "hitl.timeoutMinutes",
    });
  }
}

export async function loadConfig(harnessRoot = process.cwd(), targetProject?: string): Promise<HarnessConfig> {
  const absRoot = resolve(harnessRoot);
  const configPath = join(absRoot, CONFIG_PATH);
  const localConfigPath = join(absRoot, CONFIG_LOCAL_PATH);

  // Check for project-local config first (created by `harness init`)
  const projectConfigPath = targetProject ? join(resolve(targetProject), ".harness/config.yaml") : undefined;

  if (!existsSync(configPath) && !(projectConfigPath && existsSync(projectConfigPath))) {
    throw new ConfigError(`Missing config file at ${configPath}`, { configPath });
  }

  let merged = DEFAULT_CONFIG;

  // Load harness-level config if it exists
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf8");
    const parsed = parse(raw) as unknown;
    merged = deepMerge(merged, parsed) as HarnessConfig;
  }

  // Load project-local config (overrides harness config)
  if (projectConfigPath && existsSync(projectConfigPath)) {
    const projectRaw = await readFile(projectConfigPath, "utf8");
    const projectParsed = parse(projectRaw) as unknown;
    merged = deepMerge(merged, projectParsed) as HarnessConfig;
  }

  if (existsSync(localConfigPath)) {
    const localRaw = await readFile(localConfigPath, "utf8");
    const localParsed = parse(localRaw) as unknown;
    merged = deepMerge(merged, localParsed) as HarnessConfig;
  }

  const effectiveRoot = targetProject ? resolve(targetProject) : absRoot;
  merged = deepMerge(merged, {
    project: {
      root: effectiveRoot,
      worktreeDir: resolve(effectiveRoot, merged.project.worktreeDir),
      stateDir: resolve(effectiveRoot, merged.project.stateDir),
      logDir: resolve(effectiveRoot, merged.project.logDir),
    },
  });

  validateConfig(merged, configPath);

  await Promise.all([
    mkdir(merged.project.worktreeDir, { recursive: true }),
    mkdir(merged.project.stateDir, { recursive: true }),
    mkdir(merged.project.logDir, { recursive: true }),
  ]);

  return merged;
}
