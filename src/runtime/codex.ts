import { execa } from "execa";
import type { AgentResult, AgentRuntime, AgentRuntimeConfig } from "./types.js";

export class CodexRuntime implements AgentRuntime {
  readonly name = "codex";

  async execute(prompt: string, config: AgentRuntimeConfig): Promise<AgentResult> {
    const started = Date.now();
    try {
      const { stdout } = await execa(
        "codex",
        ["exec", "--full-auto", "--sandbox", "workspace-write", prompt],
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
      await execa("codex", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  costPer1kInput(): number {
    return 0.01;
  }
}
