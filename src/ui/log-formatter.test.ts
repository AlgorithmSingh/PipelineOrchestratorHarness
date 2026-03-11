import { describe, expect, it } from "vitest";
import {
	formatCheckResults,
	formatRetryBlock,
	formatStageBlock,
	formatTicketDivider,
} from "./log-formatter.js";

describe("log formatter", () => {
	it("formats ticket dividers", () => {
		expect(formatTicketDivider("abc-123", "Todo CLI Interface")).toContain(
			"abc-123",
		);
	});

	it("formats stage blocks with details", () => {
		const out = formatStageBlock("abc-123", "plan", {
			summary: "files: src/a.ts, src/b.ts",
			details: ["approach: implement parser"],
		});

		expect(out).toContain("plan");
		expect(out).toContain("files: src/a.ts, src/b.ts");
		expect(out).toContain("approach: implement parser");
	});

	it("formats check results summary", () => {
		const out = formatCheckResults([
			{ name: "Typecheck", passed: true, exitCode: 0, durationMs: 200 },
			{ name: "Lint", passed: false, exitCode: 1, durationMs: 300 },
		]);

		expect(out).toContain("✓ Typecheck");
		expect(out).toContain("✗ Lint");
	});

	it("formats retry block with failure output tail", () => {
		const out = formatRetryBlock(2, "lint_failed", "line1\nline2\nline3");
		expect(out).toContain("retry 2");
		expect(out).toContain("reason: lint_failed");
		expect(out).toContain("line3");
	});
});
