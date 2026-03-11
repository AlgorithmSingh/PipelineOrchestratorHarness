interface ClaudeStreamEvent {
	type?: unknown;
	subtype?: unknown;
	message?: unknown;
	name?: unknown;
	tool_name?: unknown;
	input?: unknown;
	command?: unknown;
	exit_code?: unknown;
	exitCode?: unknown;
	duration_ms?: unknown;
	durationMs?: unknown;
	start_line?: unknown;
	end_line?: unknown;
	result?: unknown;
}

interface CodexJsonEvent {
	type?: unknown;
	event?: unknown;
	tool?: unknown;
	name?: unknown;
	tool_name?: unknown;
	input?: unknown;
	command?: unknown;
	exit_code?: unknown;
	exitCode?: unknown;
	duration_ms?: unknown;
	durationMs?: unknown;
	result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function truncate(value: string, max = 60): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function readPath(input: Record<string, unknown>): string | null {
	return (
		asString(input.path) ??
		asString(input.file_path) ??
		asString(input.filePath) ??
		null
	);
}

function countLines(content: string): number {
	if (content.length === 0) return 0;
	return content.split(/\r?\n/).length;
}

function formatToolUse(
	name: string,
	input: Record<string, unknown>,
): string | null {
	switch (name.toLowerCase()) {
		case "bash": {
			const command = asString(input.command) ?? asString(input.cmd);
			if (!command) return "bash";
			return `bash ${truncate(command)}`;
		}
		case "write": {
			const path = readPath(input);
			const content = asString(input.content) ?? asString(input.text);
			const lineDelta = content === undefined ? null : countLines(content);
			if (!path) return null;
			if (lineDelta === null) return `write ${path}`;
			return `write ${path} (+${lineDelta} lines)`;
		}
		case "edit": {
			const path = readPath(input);
			if (!path) return null;
			const start = asNumber(input.start_line) ?? asNumber(input.startLine);
			const end = asNumber(input.end_line) ?? asNumber(input.endLine);
			if (start !== undefined && end !== undefined) {
				return `edit ${path} (lines ${start}-${end})`;
			}
			if (start !== undefined) {
				return `edit ${path} (line ${start})`;
			}
			return `edit ${path}`;
		}
		case "read": {
			const path = readPath(input);
			if (!path) return null;
			return `read ${path}`;
		}
		case "glob":
		case "find": {
			const pattern =
				asString(input.pattern) ??
				asString(input.query) ??
				asString(input.path);
			if (!pattern) return "search";
			return `search ${truncate(pattern)}`;
		}
		case "agent": {
			const task =
				asString(input.task) ??
				asString(input.description) ??
				asString(input.prompt);
			if (!task) return "agent";
			return `agent "${truncate(task)}"`;
		}
		default:
			return null;
	}
}

function formatBashResult(
	command: string | undefined,
	exitCode: number,
	durationMs?: number,
): string {
	const commandPart = command ? `bash ${truncate(command)}` : "bash";
	const durationPart =
		durationMs !== undefined ? ` (${formatDuration(durationMs)})` : "";
	return `${commandPart} → exit ${exitCode}${durationPart}`;
}

function formatToolResult(event: Record<string, unknown>): string | null {
	const topLevelName = asString(event.tool_name) ?? asString(event.name);
	const result = isRecord(event.result) ? event.result : null;
	const toolName =
		topLevelName ??
		(result
			? (asString(result.tool_name) ?? asString(result.name))
			: undefined);
	if (toolName?.toLowerCase() !== "bash") return null;

	const exitCode =
		asNumber(event.exit_code) ??
		asNumber(event.exitCode) ??
		(result
			? (asNumber(result.exit_code) ?? asNumber(result.exitCode))
			: undefined);
	if (exitCode === undefined) return null;

	const command =
		asString(event.command) ??
		(result
			? (asString(result.command) ??
				(isRecord(result.input)
					? (asString(result.input.command) ?? asString(result.input.cmd))
					: undefined))
			: undefined);
	const durationMs =
		asNumber(event.duration_ms) ??
		asNumber(event.durationMs) ??
		(result
			? (asNumber(result.duration_ms) ?? asNumber(result.durationMs))
			: undefined);

	return formatBashResult(command, exitCode, durationMs);
}

function firstToolUseFromAssistantMessage(
	event: Record<string, unknown>,
): string | null {
	const message = isRecord(event.message) ? event.message : null;
	if (!message) return null;
	const content = Array.isArray(message.content) ? message.content : null;
	if (!content) return null;

	for (const block of content) {
		if (!isRecord(block)) continue;
		if (asString(block.type) !== "tool_use") continue;
		const name = asString(block.name);
		const input = isRecord(block.input) ? block.input : null;
		if (!name || !input) continue;
		const formatted = formatToolUse(name, input);
		if (formatted) return formatted;
	}

	return null;
}

function formatDirectToolUse(event: Record<string, unknown>): string | null {
	const name =
		asString(event.name) ?? asString(event.tool_name) ?? asString(event.tool);
	if (!name) return null;
	const input = isRecord(event.input) ? event.input : null;
	if (!input) return null;
	return formatToolUse(name, input);
}

export function formatClaudeAction(event: unknown): string | null {
	if (!isRecord(event)) return null;
	const typedEvent = event as ClaudeStreamEvent;
	const type = asString(typedEvent.type);

	if (type === "assistant") {
		return firstToolUseFromAssistantMessage(event);
	}

	if (type === "tool_result" || type === "tool_use_result") {
		return formatToolResult(event);
	}

	return formatDirectToolUse(event);
}

export function formatCodexAction(event: unknown): string | null {
	if (!isRecord(event)) return null;
	const typedEvent = event as CodexJsonEvent;
	const type = asString(typedEvent.type) ?? asString(typedEvent.event);

	if (type === "tool_result" || type === "tool_use_result") {
		return formatToolResult(event);
	}

	const direct = formatDirectToolUse(event);
	if (direct) return direct;

	const command = asString(typedEvent.command);
	if (!command) return null;
	const exitCode =
		asNumber(typedEvent.exit_code) ?? asNumber(typedEvent.exitCode);
	if (exitCode !== undefined) {
		const durationMs =
			asNumber(typedEvent.duration_ms) ?? asNumber(typedEvent.durationMs);
		return formatBashResult(command, exitCode, durationMs);
	}
	return `bash ${truncate(command)}`;
}
