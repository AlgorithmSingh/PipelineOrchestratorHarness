import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execa } from "execa";
import { stringify } from "yaml";
import type { CheckCommand } from "../types.js";

export interface InitProjectOptions {
  beadsPrefix?: string;
  beadsDatabase?: string;
  beadsServerHost?: string;
  beadsServerPort?: number;
  projectType?: "node" | "python";
  checks?: string[];
}

function normalizePrefix(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "bd";
}

function expectedDatabaseName(prefix: string): string {
  return prefix.replace(/-/g, "_");
}

function parseMissingDatabase(errorText: string): string | undefined {
  const match = errorText.match(/database not found:\s*([a-zA-Z0-9_]+)/i);
  return match?.[1];
}

function parseHostPort(errorText: string): { host: string; port: number } | undefined {
  const match = errorText.match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return { host: match[1], port };
}

async function detectRunningDoltServers(): Promise<Array<{ host: string; port: number }>> {
  try {
    const { stdout } = await execa("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    const servers: Array<{ host: string; port: number }> = [];
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (!line.toLowerCase().includes("dolt")) continue;
      const match = line.match(/(?:127\.0\.0\.1|localhost|\*|::1|\[::1\]):(\d{2,5})\s+\(LISTEN\)/i);
      if (!match?.[1]) continue;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      servers.push({ host: "127.0.0.1", port });
    }
    return servers;
  } catch {
    return [];
  }
}

function pushUniqueServer(
  list: Array<{ host: string; port: number }>,
  host: string | undefined,
  port: number | undefined,
): void {
  if (!host || port === undefined) return;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
  if (list.some((entry) => entry.host === host && entry.port === port)) return;
  list.push({ host, port });
}

function parseCheckFlag(value: string): CheckCommand {
  const raw = value.trim();
  const [rawName = "", ...rest] = raw.split("=");
  if (rest.length === 0) {
    throw new Error(`Invalid --check value '${value}'. Use the form Name=command.`);
  }
  const name = rawName.trim();
  const command = rest.join("=").trim();
  if (!name) {
    throw new Error(`Invalid --check value '${value}': name is empty.`);
  }
  if (!command) {
    throw new Error(`Invalid --check value '${value}': command is empty.`);
  }
  return { name, command };
}

type CapabilityDetectionResult = { checks: CheckCommand[]; log: string[] };
type CapabilityDetector = (projectRoot: string) => Promise<CapabilityDetectionResult>;

async function readFileIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

async function detectNodeChecks(projectRoot: string): Promise<CapabilityDetectionResult> {
  const pkgPath = `${projectRoot}/package.json`;
  if (!existsSync(pkgPath)) {
    throw new Error(
      [
        "No usable check commands detected in package.json scripts.",
        "Looked for: test, typecheck, lint",
        "Either add scripts to package.json or pass --check explicitly:",
        "  harness init <path> --project-type node --check \"Tests=npm test\"",
      ].join("\n"),
    );
  }

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch (error) {
    throw new Error(`Failed to parse package.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const checks: CheckCommand[] = [];
  const log: string[] = [];

  if (scripts.typecheck) {
    checks.push({ name: "Typecheck", command: "npm run typecheck" });
    log.push("Detected typecheck script -> Typecheck: npm run typecheck");
  }
  if (scripts.lint) {
    checks.push({ name: "Lint", command: "npm run lint" });
    log.push("Detected lint script -> Lint: npm run lint");
  }
  if (scripts.test) {
    const testScript = scripts.test.trim();
    const defaultStub = /^echo\s+\"?Error:\s+no\s+test\s+specified\"?\s+&&\s+exit\s+1$/i;
    if (!defaultStub.test(testScript)) {
      checks.push({ name: "Tests", command: "npm test" });
      log.push("Detected test script -> Tests: npm test");
    } else {
      log.push("Skipped default npm test stub");
    }
  }

  if (checks.length === 0) {
    throw new Error(
      [
        "No usable check commands detected in package.json scripts.",
        "Looked for: test, typecheck, lint",
        "Either add scripts to package.json or pass --check explicitly:",
        "  harness init <path> --project-type node --check \"Tests=npm test\"",
      ].join("\n"),
    );
  }

  return { checks, log };
}

function containsRequirement(text: string | null, name: string): boolean {
  if (!text) return false;
  const pattern = new RegExp(`(^|\\n)\\s*${name}(\\b|==|>=|<=|~=|\\s)`, "i");
  return pattern.test(text);
}

async function detectPythonChecks(projectRoot: string): Promise<CapabilityDetectionResult> {
  const pyproject = await readFileIfExists(`${projectRoot}/pyproject.toml`);
  const setupCfg = await readFileIfExists(`${projectRoot}/setup.cfg`);
  const toxIni = existsSync(`${projectRoot}/tox.ini`);
  const requirementsFiles = [
    await readFileIfExists(`${projectRoot}/requirements.txt`),
    await readFileIfExists(`${projectRoot}/requirements-dev.txt`),
    await readFileIfExists(`${projectRoot}/dev-requirements.txt`),
  ].filter(Boolean) as string[];
  const requirementsCombined = requirementsFiles.join("\n");

  const checks: CheckCommand[] = [];
  const log: string[] = [];

  const hasMypy = (pyproject?.includes("[tool.mypy]") ?? false)
    || (setupCfg?.match(/\[mypy\]/i) ? true : false)
    || containsRequirement(requirementsCombined, "mypy");
  if (hasMypy) {
    checks.push({ name: "Typecheck", command: "python -m mypy ." });
    log.push("Detected mypy config/dependency -> Typecheck: python -m mypy .");
  }

  const hasRuff = (pyproject?.includes("[tool.ruff]") ?? false)
    || containsRequirement(requirementsCombined, "ruff");
  if (hasRuff) {
    checks.push({ name: "Lint", command: "ruff check ." });
    log.push("Detected ruff config/dependency -> Lint: ruff check .");
  }

  const testsDirExists = existsSync(`${projectRoot}/tests`);
  const hasPytestConfig = (pyproject?.includes("[tool.pytest.ini_options]") ?? false)
    || containsRequirement(requirementsCombined, "pytest")
    || (setupCfg?.match(/\[tool:pytest\]/i) ? true : false);
  if (hasPytestConfig || testsDirExists) {
    checks.push({ name: "Tests", command: "python -m pytest" });
    log.push("Detected pytest signals -> Tests: python -m pytest");
  }

  if (toxIni) {
    checks.push({ name: "Tests (tox)", command: "tox" });
    log.push("Detected tox.ini -> Tests (tox): tox");
  }

  if (checks.length === 0) {
    throw new Error(
      [
        "No usable check commands detected for python project.",
        "Looked for: mypy config or dependency, ruff config or dependency, pytest config/dependency/tests/, tox.ini",
        "Either add tooling or pass --check explicitly:",
        "  harness init <path> --project-type python --check \"Tests=python -m pytest\"",
      ].join("\n"),
    );
  }

  return { checks, log };
}

const capabilityDetectors: Record<NonNullable<InitProjectOptions["projectType"]>, CapabilityDetector> = {
  node: detectNodeChecks,
  python: detectPythonChecks,
};

async function resolveChecks(projectRoot: string, options: InitProjectOptions): Promise<CapabilityDetectionResult> {
  const explicitChecks = options.checks ?? [];
  if (explicitChecks.length > 0) {
    const checks = explicitChecks.map(parseCheckFlag);
    return { checks, log: ["Using explicit --check flags; skipping capability detection."] };
  }

  if (!options.projectType) {
    throw new Error("Specify --project-type <node|python> or provide --check to define deterministic checks.");
  }

  const detector = capabilityDetectors[options.projectType];
  if (!detector) {
    throw new Error(`Unsupported project type '${options.projectType}'.`);
  }

  return detector(projectRoot);
}

function buildInitArgs(params: {
  prefix: string;
  database?: string;
  host?: string;
  port?: number;
}): string[] {
  const args = ["init", "--prefix", params.prefix];
  if (params.database) {
    args.push("--database", params.database);
  }
  if (params.host) {
    args.push("--server-host", params.host);
  }
  if (params.port !== undefined) {
    args.push("--server-port", String(params.port));
  }
  return args;
}

async function runBdInit(cwd: string, args: string[]): Promise<void> {
  await execa("bd", args, { cwd });
}

export async function initProject(targetPath: string, options: InitProjectOptions = {}): Promise<void> {
  const absPath = resolve(targetPath);
  const projectName = basename(absPath);
  const beadsPrefix = normalizePrefix(options.beadsPrefix ?? projectName);
  const beadsDatabase = options.beadsDatabase ?? process.env.BEADS_DATABASE;
  const beadsServerHost = options.beadsServerHost ?? process.env.BEADS_SERVER_HOST;
  const beadsServerPortRaw = options.beadsServerPort ?? (process.env.BEADS_SERVER_PORT ? Number(process.env.BEADS_SERVER_PORT) : undefined);
  const beadsServerPort = Number.isFinite(beadsServerPortRaw) ? beadsServerPortRaw : undefined;
  const detectedServers = await detectRunningDoltServers();

  // 1. Create directory if needed
  if (!existsSync(absPath)) {
    await mkdir(absPath, { recursive: true });
    log(`Created directory: ${absPath}`);
  }

  // 2. Git init
  if (!existsSync(`${absPath}/.git`)) {
    await execa("git", ["init"], { cwd: absPath });
    log("Initialized git repository");
  }

  // Ensure we're on main
  try {
    const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: absPath });
    if (stdout.trim() !== "main") {
      await execa("git", ["branch", "-M", "main"], { cwd: absPath });
    }
  } catch {
    // No commits yet, branch rename will happen after first commit
  }

  // 3. .gitignore
  const gitignoreEntries = [
    "node_modules/",
    "dist/",
    ".harness/worktrees/",
    ".harness/state/",
    ".harness/logs/",
  ];
  const gitignorePath = `${absPath}/.gitignore`;
  let existingIgnore = "";
  if (existsSync(gitignorePath)) {
    existingIgnore = await readFile(gitignorePath, "utf8");
  }
  const missing = gitignoreEntries.filter((e) => !existingIgnore.includes(e));
  if (missing.length > 0) {
    const append = `${missing.join("\n")}\n`;
    await writeFile(gitignorePath, existingIgnore + (existingIgnore.endsWith("\n") ? "" : "\n") + append, "utf8");
    log("Updated .gitignore");
  }

  // 4. Create .harness/ dirs
  await mkdir(`${absPath}/.harness/state`, { recursive: true });
  await mkdir(`${absPath}/.harness/logs`, { recursive: true });
  await mkdir(`${absPath}/.harness/worktrees`, { recursive: true });

  const capability = await resolveChecks(absPath, options);
  for (const entry of capability.log) {
    log(entry);
  }

  // 5. Write default harness config
  const configPath = `${absPath}/.harness/config.yaml`;
  if (!existsSync(configPath)) {
    const defaultConfig = {
      project: {
        name: projectName,
        root: ".",
        worktreeDir: ".harness/worktrees",
        stateDir: ".harness/state",
        logDir: ".harness/logs",
        canonicalBranch: "main",
      },
      pipelines: {
        execution: {
          enabled: true,
          maxParallelAgents: 1,
          pollIntervalMs: 30_000,
          maxRetriesPerTicket: 3,
          runtime: "claude-code",
          fallbackRuntime: "codex",
          maxRetriesBeforeFallback: 2,
          mergeMode: "direct",
          checks: capability.checks,
          worktreeSetup: ["[ -f package.json ] && npm install || true"],
          planner: { runtime: "claude-code", maxTurns: 20, maxBudgetUsd: 2 },
          coder: { runtime: "claude-code", maxTurns: 50, maxBudgetUsd: 5 },
          reviewer: { runtime: "claude-code", maxTurns: 15, maxBudgetUsd: 1 },
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
    await writeFile(configPath, stringify(defaultConfig), "utf8");
    log("Created .harness/config.yaml");
  }

  // 6. Init Beads if not already initialized
  if (!existsSync(`${absPath}/.beads`)) {
    try {
      await execa("bd", ["--version"]);
    } catch {
      throw new Error("Beads CLI (bd) is not installed. Install it first: npm install -g @beads/bd");
    }
    const initArgs = buildInitArgs({
      prefix: beadsPrefix,
      database: beadsDatabase,
      host: beadsServerHost,
      port: beadsServerPort,
    });
    try {
      await runBdInit(absPath, initArgs);
      log("Initialized Beads database");
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const dbGuess = expectedDatabaseName(beadsPrefix);
      const missingDb = parseMissingDatabase(details);
      if (!beadsDatabase && missingDb) {
        const parsedAddress = parseHostPort(details);
        const candidateServers: Array<{ host: string; port: number }> = [];
        pushUniqueServer(candidateServers, beadsServerHost, beadsServerPort);
        pushUniqueServer(candidateServers, parsedAddress?.host, parsedAddress?.port);
        for (const server of detectedServers) {
          pushUniqueServer(candidateServers, server.host, server.port);
        }
        pushUniqueServer(candidateServers, "127.0.0.1", 3307);

        const createDbQuery = `CREATE DATABASE IF NOT EXISTS \`${missingDb}\`;`;
        let lastRetryError = "";
        for (const server of candidateServers) {
          try {
            log(`Beads server is missing database '${missingDb}'. Trying ${server.host}:${server.port}...`);
            await execa(
              "dolt",
              ["--host", server.host, "--port", String(server.port), "sql", "-q", createDbQuery],
              { cwd: absPath },
            );
            const retryArgs = buildInitArgs({
              prefix: beadsPrefix,
              database: missingDb,
              host: server.host,
              port: server.port,
            });
            await runBdInit(absPath, retryArgs);
            log("Initialized Beads database");
            return;
          } catch (retryError) {
            lastRetryError = retryError instanceof Error ? retryError.message : String(retryError);
          }
        }
        throw new Error(
          [
            `Beads init failed: bd ${initArgs.join(" ")}`,
            `Prefix: ${beadsPrefix}`,
            `Expected database (default mapping): ${dbGuess}`,
            `Auto-fix attempted: create database '${missingDb}' and retry on detected Dolt servers`,
            "",
            "Original error:",
            details,
            "",
            "Last auto-fix error:",
            lastRetryError,
          ].join("\n"),
        );
      } else {
        throw new Error(
          [
            `Beads init failed: bd ${initArgs.join(" ")}`,
            `Prefix: ${beadsPrefix}`,
            `Expected database (default mapping): ${dbGuess}`,
            "",
            details,
          ].join("\n"),
        );
      }
    }
  } else {
    log("Beads already initialized");
  }

  // 7. Ensure at least one commit on main
  try {
    await execa("git", ["rev-parse", "HEAD"], { cwd: absPath });
  } catch {
    await execa("git", ["add", "-A"], { cwd: absPath });
    await execa("git", ["commit", "-m", "chore: initialize project"], { cwd: absPath });
    await execa("git", ["branch", "-M", "main"], { cwd: absPath });
    log("Created initial commit on main");
  }

  log("");
  log(`Project initialized at ${absPath}`);
  log("");
  log("Next steps:");
  log(`  cd ${absPath}`);
  log('  bd create "Your task" --labels "pipeline:execution" --description "contract..."');
  log(`  harness start --project ${absPath}`);
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}
