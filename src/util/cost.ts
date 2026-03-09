import type { AgentResult } from "../runtime/types.js";

export interface CostEstimate {
  input: number;
  output: number;
  total: number;
}

export function estimateCost(result: AgentResult, inputPer1kUsd: number, outputPer1kUsd: number): CostEstimate {
  const input = (result.tokenUsage.inputTokens / 1000) * inputPer1kUsd;
  const output = (result.tokenUsage.outputTokens / 1000) * outputPer1kUsd;
  return { input, output, total: input + output };
}
