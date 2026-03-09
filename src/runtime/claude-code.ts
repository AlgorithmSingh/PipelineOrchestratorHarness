import { execa } from "execa";
import { RuntimeError } from "../errors.js";
import type { AgentResult, AgentRuntime, AgentRuntimeConfig } from "./types.js";

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name = "claude-code";

  async execute(prompt: string, config: AgentRuntimeConfig): Promise<AgentResult> {
    const started = Date.now();
    try {
      const { stdout } = await execa(
        "claude",
        ["--print", prompt],
        {
          cwd: config.cwd,
          env: config.env,
          reject: false,
        },
      );

      let output: Record<string, unknown> = {};
      try {
        output = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        output = { text: stdout };
      }

      return {
        passed: true,
        output,
        rawOutput: stdout,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        exitReason: "completed",
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        passed: false,
        output: {},
        rawOutput: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        exitReason: "error",
        error: error instanceof Error ? error.message : String(error),
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
