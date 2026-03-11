import { describe, expect, it } from "vitest";
import { formatClaudeAction, formatCodexAction } from "./action-formatter.js";

describe("formatClaudeAction", () => {
	it("formats Bash tool-use commands", () => {
		const action = formatClaudeAction({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Bash",
						input: { command: "npm test" },
					},
				],
			},
		});

		expect(action).toBe("bash npm test");
	});

	it("formats Write actions with line counts", () => {
		const action = formatClaudeAction({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Write",
						input: {
							file_path: "src/store.ts",
							content: "line1\nline2\nline3",
						},
					},
				],
			},
		});

		expect(action).toBe("write src/store.ts (+3 lines)");
	});

	it("formats Agent task actions", () => {
		const action = formatClaudeAction({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Agent",
						input: { task: "Explore codebase structure" },
					},
				],
			},
		});

		expect(action).toBe('agent "Explore codebase structure"');
	});

	it("formats Bash tool-result exit code and duration", () => {
		const action = formatClaudeAction({
			type: "tool_result",
			tool_name: "Bash",
			command: "npm test",
			exit_code: 0,
			duration_ms: 1300,
		});

		expect(action).toBe("bash npm test → exit 0 (1.3s)");
	});

	it("returns null when no tool-use data is present", () => {
		expect(formatClaudeAction({ type: "system", subtype: "init" })).toBeNull();
	});
});

describe("formatCodexAction", () => {
	it("formats command events", () => {
		const action = formatCodexAction({ command: "npm run lint" });
		expect(action).toBe("bash npm run lint");
	});

	it("formats command result events", () => {
		const action = formatCodexAction({
			command: "npm run lint",
			exit_code: 1,
			duration_ms: 2200,
		});
		expect(action).toBe("bash npm run lint → exit 1 (2.2s)");
	});
});
