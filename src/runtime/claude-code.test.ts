import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { ClaudeCodeRuntime } from "./claude-code.js";
import type { AgentRuntimeConfig } from "./types.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const execaMock = vi.mocked(execa);

const baseConfig: AgentRuntimeConfig = {
  cwd: "/tmp",
  systemPrompt: "test",
  maxTurns: 5,
  maxBudgetUsd: 1,
};

type MockExecaResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
};

function createMockSubprocess(
  result: MockExecaResult,
  streamLines?: { stdout?: string[]; stderr?: string[] },
): Promise<MockExecaResult> & { stdout: PassThrough; stderr: PassThrough } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const promise = new Promise<MockExecaResult>((resolve) => {
    setImmediate(() => {
      for (const line of streamLines?.stdout ?? []) stdout.write(`${line}\n`);
      stdout.end();

      for (const line of streamLines?.stderr ?? []) stderr.write(`${line}\n`);
      stderr.end();

      resolve(result);
    });
  }) as Promise<MockExecaResult> & { stdout: PassThrough; stderr: PassThrough };

  Object.assign(promise, { stdout, stderr });
  return promise;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ClaudeCodeRuntime", () => {
  it("uses stream-json flags when streaming is enabled", async () => {
    execaMock.mockReturnValue(
      createMockSubprocess({ exitCode: 0, stdout: "", stderr: "", signal: null }) as never,
    );
    const runtime = new ClaudeCodeRuntime();

    await runtime.execute("hello", { ...baseConfig, streamOutput: true });

    expect(execaMock).toHaveBeenCalledTimes(1);
    const call = execaMock.mock.calls[0] as unknown[];
    const args = call[1] as string[];
    const options = call[2] as { stderr?: unknown } | undefined;
    expect(args).toEqual(expect.arrayContaining([
      "-p",
      "--dangerously-skip-permissions",
      "--max-turns",
      "5",
      "--output-format",
      "stream-json",
      "--verbose",
    ]));
    expect(options?.stderr).toBe("pipe");
  });

  it("extracts raw output from the final stream-json result event", async () => {
    const reviewerJson = "{\"verdict\":\"approve\"}";
    execaMock.mockReturnValue(createMockSubprocess(
      { exitCode: 0, stdout: "", stderr: "", signal: null },
      {
        stderr: [
          JSON.stringify({ type: "system", subtype: "init" }),
          JSON.stringify({ type: "result", result: reviewerJson }),
        ],
      },
    ) as never);
    const runtime = new ClaudeCodeRuntime();

    const result = await runtime.execute("review", { ...baseConfig, streamOutput: true });

    expect(result.passed).toBe(true);
    expect(result.exitReason).toBe("completed");
    expect(result.rawOutput).toBe(reviewerJson);
    expect(JSON.parse(result.rawOutput)).toEqual({ verdict: "approve" });
  });

  it("prints concise stream progress instead of raw JSON", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    execaMock.mockReturnValue(createMockSubprocess(
      { exitCode: 0, stdout: "", stderr: "", signal: null },
      {
        stderr: [
          JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6" }),
          JSON.stringify({ type: "system", subtype: "task_started", description: "Explore codebase structure" }),
          JSON.stringify({ type: "result", is_error: false, num_turns: 2, duration_ms: 1200, result: "done" }),
        ],
      },
    ) as never);
    const runtime = new ClaudeCodeRuntime();

    await runtime.execute("review", { ...baseConfig, streamOutput: true });

    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("[claude] init model=claude-sonnet-4-6");
    expect(printed).toContain("[claude] task: Explore codebase structure");
    expect(printed).toContain("[claude] result: ok turns=2 duration=1.2s");
    expect(printed).not.toContain("\"type\":\"system\"");
    writeSpy.mockRestore();
  });

  it("keeps text mode behavior when streaming is disabled", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "plain text output",
      stderr: "",
      signal: null,
    } as never);
    const runtime = new ClaudeCodeRuntime();

    const result = await runtime.execute("hello", { ...baseConfig, streamOutput: false });

    expect(result.passed).toBe(true);
    expect(result.rawOutput).toBe("plain text output");
    expect(result.output).toEqual({ text: "plain text output" });
    const call = execaMock.mock.calls[0] as unknown[];
    const args = call[1] as string[];
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("stream-json");
  });
});
