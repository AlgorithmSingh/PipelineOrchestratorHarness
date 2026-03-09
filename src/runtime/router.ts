import { RuntimeError } from "../errors.js";
import type { AgentRuntime, AgentRuntimeConfig, AgentResult } from "./types.js";

export interface RoutingPolicy {
  defaultRuntime: string;
  fallbackRuntime: string;
  maxRetriesBeforeFallback: number;
  roleOverrides?: Record<string, string>;
}

export class RuntimeRouter {
  private readonly runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.name, runtime);
  }

  get(name: string): AgentRuntime {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new RuntimeError(`Runtime not registered: ${name}`, { runtime: name });
    }
    return runtime;
  }

  pick(policy: RoutingPolicy, role?: string): AgentRuntime {
    const roleRuntime = role ? policy.roleOverrides?.[role] : undefined;
    return this.get(roleRuntime ?? policy.defaultRuntime);
  }

  async executeWithFallback(
    prompt: string,
    config: AgentRuntimeConfig,
    policy: RoutingPolicy,
    role?: string,
  ): Promise<{ runtime: string; result: AgentResult }> {
    const primary = this.pick(policy, role);
    const fallback = this.get(policy.fallbackRuntime);

    const primaryHealthy = await primary.healthCheck();
    if (!primaryHealthy) {
      const fallbackResult = await fallback.execute(prompt, config);
      return { runtime: fallback.name, result: fallbackResult };
    }

    for (let attempt = 1; attempt <= policy.maxRetriesBeforeFallback; attempt += 1) {
      const result = await primary.execute(prompt, config);
      if (result.passed) {
        return { runtime: primary.name, result };
      }
    }

    const fallbackHealthy = await fallback.healthCheck();
    if (!fallbackHealthy) {
      throw new RuntimeError("Primary and fallback runtimes are unavailable", {
        runtime: `${primary.name},${fallback.name}`,
      });
    }

    const fallbackResult = await fallback.execute(prompt, config);
    return { runtime: fallback.name, result: fallbackResult };
  }
}
