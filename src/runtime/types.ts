export interface AgentResult {
  passed: boolean;
  output: Record<string, unknown>;
  rawOutput: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  exitReason: "completed" | "max_turns" | "max_budget" | "error" | "aborted";
  error?: string;
  durationMs: number;
}

export interface AgentRuntimeConfig {
  cwd: string;
  systemPrompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  logger?: import("pino").Logger;
  streamOutput?: boolean;
}

export interface AgentRuntime {
  readonly name: string;
  execute(prompt: string, config: AgentRuntimeConfig): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
  costPer1kInput(): number;
}
