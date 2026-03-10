import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, validateExecutionReadiness } from "./config.js";
import { ConfigError } from "./errors.js";

describe("DEFAULT_CONFIG", () => {
  it("uses direct merge mode by default", () => {
    expect(DEFAULT_CONFIG.pipelines.execution.mergeMode).toBe("direct");
  });

  it("enables execution pipeline and disables plan/adversarial by default", () => {
    expect(DEFAULT_CONFIG.pipelines.execution.enabled).toBe(true);
    expect(DEFAULT_CONFIG.pipelines.planGeneration.enabled).toBe(false);
    expect(DEFAULT_CONFIG.pipelines.adversarial.enabled).toBe(false);
  });
});

describe("validateExecutionReadiness", () => {
  it("throws when checks are empty and execution is enabled", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      pipelines: {
        ...DEFAULT_CONFIG.pipelines,
        execution: { ...DEFAULT_CONFIG.pipelines.execution, checks: [] },
      },
    };
    expect(() => validateExecutionReadiness(cfg)).toThrow(ConfigError);
  });

  it("throws when a check has an empty name", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      pipelines: {
        ...DEFAULT_CONFIG.pipelines,
        execution: { ...DEFAULT_CONFIG.pipelines.execution, checks: [{ name: "", command: "npm test" }] },
      },
    };
    expect(() => validateExecutionReadiness(cfg)).toThrow(ConfigError);
  });

  it("throws when a check has an empty command", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      pipelines: {
        ...DEFAULT_CONFIG.pipelines,
        execution: { ...DEFAULT_CONFIG.pipelines.execution, checks: [{ name: "Tests", command: "" }] },
      },
    };
    expect(() => validateExecutionReadiness(cfg)).toThrow(ConfigError);
  });

  it("passes when execution is disabled even with empty checks", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      pipelines: {
        ...DEFAULT_CONFIG.pipelines,
        execution: { ...DEFAULT_CONFIG.pipelines.execution, enabled: false, checks: [] },
      },
    };
    expect(() => validateExecutionReadiness(cfg)).not.toThrow();
  });

  it("passes when checks are valid", () => {
    const cfg = DEFAULT_CONFIG;
    expect(() => validateExecutionReadiness(cfg)).not.toThrow();
  });
});
