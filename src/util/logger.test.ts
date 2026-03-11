import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHarnessLogFilePath, createLogger } from "./logger.js";

describe("logger utilities", () => {
	it("builds harness NDJSON file path", () => {
		const path = buildHarnessLogFilePath(
			"/tmp/logs",
			new Date("2026-03-10T12:30:00.000Z"),
		);
		expect(path).toContain("/tmp/logs/harness-2026-03-10T12-30-00-000Z.ndjson");
	});

	it("writes NDJSON logs to file in pretty ui mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-logger-"));
		const logDir = join(root, "logs");
		await mkdir(logDir, { recursive: true });
		const logPath = join(logDir, "harness-test.ndjson");

		const logger = createLogger({ uiMode: "pretty", logFilePath: logPath });
		logger.info({ pipeline: "execution", event: "test_event" }, "test message");

		await new Promise((resolve) => setTimeout(resolve, 50));
		const raw = await readFile(logPath, "utf8");
		expect(raw).toContain('"event":"test_event"');
		expect(raw).toContain('"msg":"test message"');
	});
});
