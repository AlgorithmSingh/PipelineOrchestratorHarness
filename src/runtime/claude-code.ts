import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { execa } from "execa";
import { RuntimeError } from "../errors.js";
import type { AgentResult, AgentRuntime, AgentRuntimeConfig } from "./types.js";

/** Env vars that trigger nested-session detection in Claude Code. */
const CLAUDE_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
];

interface ClaudeStreamEvent {
  type?: string;
  result?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  description?: unknown;
  model?: unknown;
  num_turns?: unknown;
  duration_ms?: unknown;
  total_cost_usd?: unknown;
  message?: unknown;
  error?: unknown;
}

function streamToLines(
  stream: Readable | null | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return Promise.resolve();

  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on("line", onLine);

  return new Promise((resolve, reject) => {
    lines.once("close", resolve);
    lines.once("error", reject);
  });
}

function coerceResultOutput(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (result === undefined) return undefined;
  if (result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function truncate(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

interface StreamFormatState {
  lastProgressText?: string;
  lastProgressAt?: number;
  lastRendered?: string;
  lastRenderedAt?: number;
}

function formatStreamEvent(event: ClaudeStreamEvent, state: StreamFormatState): string | null {
  const type = asString(event.type);
  switch (type) {
    case "system": {
      const subtype = asString(event.subtype);
      if (subtype === "init") {
        const model = asString(event.model);
        return model ? `[claude] init model=${model}` : "[claude] init";
      }
      if (subtype === "task_started") {
        const description = asString(event.description);
        return description ? `[claude] task: ${truncate(description)}` : "[claude] task started";
      }
      if (subtype === "task_progress") {
        const description = asString(event.description);
        if (!description) return null;
        const now = Date.now();
        if (state.lastProgressText === description && now - (state.lastProgressAt ?? 0) < 3_000) {
          return null;
        }
        state.lastProgressText = description;
        state.lastProgressAt = now;
        return `[claude] progress: ${truncate(description)}`;
      }
      if (subtype === "task_completed") {
        const description = asString(event.description);
        return description ? `[claude] task done: ${truncate(description)}` : "[claude] task done";
      }
      if (subtype === "hook_response") {
        const outcome = asString((event as Record<string, unknown>).outcome);
        if (outcome && outcome !== "success") {
          const hookName = asString((event as Record<string, unknown>).hook_name) ?? "hook";
          return `[claude] ${hookName} ${outcome}`;
        }
      }
      return null;
    }
    case "assistant": {
      if (!isRecord(event.message)) return null;
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (asString(block.type) === "tool_use") {
          const toolName = asString(block.name) ?? "unknown";
          return `[claude] tool: ${toolName}`;
        }
      }
      return null;
    }
    case "result": {
      const status = event.is_error === true ? "error" : "ok";
      const parts = [`[claude] result: ${status}`];
      const turns = asNumber(event.num_turns);
      const durationMs = asNumber(event.duration_ms);
      const costUsd = asNumber(event.total_cost_usd);
      if (turns !== undefined) parts.push(`turns=${turns}`);
      if (durationMs !== undefined) parts.push(`duration=${(durationMs / 1000).toFixed(1)}s`);
      if (costUsd !== undefined) parts.push(`cost=$${costUsd.toFixed(4)}`);
      return parts.join(" ");
    }
    case "error": {
      const message = asString(event.message) ?? asString(event.error);
      return message ? `[claude] error: ${truncate(message, 200)}` : "[claude] error";
    }
    default:
      return null;
  }
}

function renderStreamLine(line: string, state: StreamFormatState): void {
  const now = Date.now();
  if (state.lastRendered === line && now - (state.lastRenderedAt ?? 0) < 1_000) {
    return;
  }
  state.lastRendered = line;
  state.lastRenderedAt = now;
  process.stderr.write(`${line}\n`);
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name = "claude-code";

  async execute(prompt: string, config: AgentRuntimeConfig): Promise<AgentResult> {
    const started = Date.now();
    const shouldStream = config.streamOutput === true;

    try {
      const args = [
        "-p",
        "--dangerously-skip-permissions",
        "--max-turns",
        String(config.maxTurns),
      ];
      if (shouldStream) {
        args.push(
          "--output-format",
          "stream-json",
          "--verbose",
        );
      }

      // Remove all Claude env vars to avoid nested-session detection
      const env = { ...process.env, ...config.env };
      for (const key of CLAUDE_ENV_KEYS) {
        delete env[key];
      }

      const subprocess = execa("claude", args, {
        cwd: config.cwd,
        env,
        input: prompt,
        reject: false,
        timeout: 10 * 60 * 1000,
        cancelSignal: config.signal,
        ...(shouldStream && { stderr: "pipe" as const }),
      });

      let streamedResultOutput: string | undefined;
      let streamedErrorOutput: string | undefined;
      const streamParsers: Promise<void>[] = [];
      if (shouldStream) {
        const streamState: StreamFormatState = {};
        const handleLine = (line: string, source: "stderr" | "stdout"): void => {
          if (!line.trim()) return;

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            renderStreamLine(`[claude] ${truncate(line, 200)}`, streamState);
            return;
          }
          if (!isRecord(parsed)) return;
          const event = parsed as ClaudeStreamEvent;

          if (event.type === "result") {
            const parsed = coerceResultOutput(event.result);
            if (parsed !== undefined) streamedResultOutput = parsed;
            if (event.is_error === true) streamedErrorOutput = parsed;
          }

          const formatted = formatStreamEvent(event, streamState);
          if (formatted) renderStreamLine(formatted, streamState);
        };

        streamParsers.push(streamToLines(subprocess.stderr, (line) => handleLine(line, "stderr")));
        streamParsers.push(streamToLines(subprocess.stdout, (line) => handleLine(line, "stdout")));
      }

      const result = await subprocess;
      if (streamParsers.length > 0) await Promise.all(streamParsers);
      const rawOutput = shouldStream
        ? (streamedResultOutput ?? result.stdout ?? "")
        : result.stdout;

      // Detect if the process was killed by a signal (e.g. SIGINT from Ctrl+C)
      if (result.signal) {
        return {
          passed: false,
          output: {},
          rawOutput,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          exitReason: "aborted",
          error: `Process killed by signal: ${result.signal}`,
          durationMs: Date.now() - started,
        };
      }

      return {
        passed: result.exitCode === 0,
        output: { text: rawOutput },
        rawOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        exitReason: result.exitCode === 0 ? "completed" : "error",
        error: result.exitCode !== 0
          ? shouldStream
            ? `Exit code ${result.exitCode}${streamedErrorOutput ? `\n${streamedErrorOutput}` : ""}`
            : `Exit code ${result.exitCode}${result.stderr ? `\n${result.stderr}` : ""}`
          : undefined,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const isAbort =
        (error instanceof Error && error.name === "AbortError") ||
        config.signal?.aborted;
      return {
        passed: false,
        output: {},
        rawOutput: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        exitReason: isAbort ? "aborted" : "error",
        error: isAbort
          ? "Process aborted by orchestrator shutdown"
          : error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await execa("claude", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  costPer1kInput(): number {
    return 0.015;
  }
}

export function assertClaudeAvailable(available: boolean): void {
  if (!available) {
    throw new RuntimeError("Claude runtime is unavailable", { runtime: "claude-code" });
  }
}
