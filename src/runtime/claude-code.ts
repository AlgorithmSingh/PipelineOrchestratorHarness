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
        // When streaming, let stderr flow directly to the terminal so
        // Claude's progress indicator and tool calls are visible in real-time.
        // Claude only writes progress to stderr when it detects a TTY.
        ...(shouldStream && { stderr: "inherit" }),
      });

      const result = await subprocess;

      // Detect if the process was killed by a signal (e.g. SIGINT from Ctrl+C)
      if (result.signal) {
        return {
          passed: false,
          output: {},
          rawOutput: result.stdout ?? "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          exitReason: "aborted",
          error: `Process killed by signal: ${result.signal}`,
          durationMs: Date.now() - started,
        };
      }

      return {
        passed: result.exitCode === 0,
        output: { text: result.stdout },
        rawOutput: result.stdout,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        exitReason: result.exitCode === 0 ? "completed" : "error",
        error: result.exitCode !== 0
          ? `Exit code ${result.exitCode}${result.stderr ? `\n${result.stderr}` : ""}`
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
