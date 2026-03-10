import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { CodexRuntime } from "./codex.js";
import type { AgentRuntimeConfig } from "./types.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const execaMock = vi.mocked(execa);

const baseConfig: AgentRuntimeConfig = {
  cwd: "/tmp",
  systemPrompt: "",
  maxTurns: 5,
  maxBudgetUsd: 1,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("CodexRuntime", () => {
  it("marks success when exit code is zero", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "{\"verdict\":\"pass\"}",
      stderr: "",
      signal: null,
    } as never);

    const runtime = new CodexRuntime();
    const result = await runtime.execute("prompt", baseConfig);

    expect(result.passed).toBe(true);
    expect(result.exitReason).toBe("completed");
    expect(result.output).toEqual({ verdict: "pass" });
  });

  it("marks failure when exit code is non-zero and includes stderr in error", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      signal: null,
    } as never);

    const runtime = new CodexRuntime();
    const result = await runtime.execute("prompt", baseConfig);

    expect(result.passed).toBe(false);
    expect(result.exitReason).toBe("error");
    expect(result.error).toContain("boom");
  });

  it("returns aborted when process is killed by signal", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "",
      signal: "SIGINT",
    } as never);

    const runtime = new CodexRuntime();
    const result = await runtime.execute("prompt", baseConfig);

    expect(result.passed).toBe(false);
    expect(result.exitReason).toBe("aborted");
  });

  it("handles spawn errors as runtime errors", async () => {
    execaMock.mockRejectedValue(new Error("spawn ENOENT"));
    const runtime = new CodexRuntime();

    const result = await runtime.execute("prompt", baseConfig);

    expect(result.passed).toBe(false);
    expect(result.exitReason).toBe("error");
    expect(result.error).toContain("spawn ENOENT");
  });
});
