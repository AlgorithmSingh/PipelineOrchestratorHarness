import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";

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
