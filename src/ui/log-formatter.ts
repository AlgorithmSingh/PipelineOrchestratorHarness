import type { CheckResult } from "../pipelines/execution-types.js";

export interface StageData {
	summary: string;
	details?: string[];
}

function prefix(stage: string): string {
	return ` ${stage.padEnd(6)}│ `;
}

function detailPrefix(stage: string): string {
	return ` ${"".padEnd(stage.length, " ").padEnd(6)}│ `;
}

function tailLines(text: string, limit = 5): string[] {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	if (lines.length <= limit) return lines;
	return lines.slice(lines.length - limit);
}

export function formatTicketDivider(ticketId: string, title: string): string {
	const cleanTitle = title.trim().length > 0 ? title.trim() : "(no title)";
	return `─── ${ticketId} ─── ${cleanTitle} ─────────────────────────`;
}

export function formatStageBlock(
	ticketId: string,
	stage: string,
	data: StageData,
): string {
	const summary =
		data.summary.trim().length > 0 ? data.summary.trim() : `ticket ${ticketId}`;
	const lines = [`${prefix(stage)}${summary}`];
	for (const detail of data.details ?? []) {
		lines.push(`${detailPrefix(stage)}${detail}`);
	}
	return lines.join("\n");
}

export function formatCheckResults(results: CheckResult[]): string {
	if (results.length === 0) {
		return formatStageBlock("", "check", { summary: "no checks configured" });
	}

	const summary = results
		.map((result) => `${result.passed ? "✓" : "✗"} ${result.name}`)
		.join("  ");
	return formatStageBlock("", "check", { summary });
}

export function formatRetryBlock(
	attempt: number,
	reason: string,
	failureOutput?: string,
): string {
	const details: string[] = [];
	if (failureOutput && failureOutput.trim().length > 0) {
		details.push("failure output (last 5 lines):");
		for (const line of tailLines(failureOutput, 5)) {
			details.push(line);
		}
	}
	details.push(
		`reason: ${reason.trim().length > 0 ? reason.trim() : "unspecified"}`,
	);
	return formatStageBlock("", "retry", {
		summary: `↻ retry ${attempt} — reinjecting with failure context`,
		details,
	});
}
