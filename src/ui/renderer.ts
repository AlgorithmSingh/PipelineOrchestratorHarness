import { Box, type Instance as InkInstance, render, Static, Text } from "ink";
import {
	type ComponentType,
	createElement,
	type ReactElement,
	type ReactNode,
} from "react";
import type {
	RunDisplayState,
	TicketDisplayStage,
	TicketDisplayState,
} from "./types.js";

const HEADER_REFRESH_MS = 500;
const MAX_LOG_LINES = 400;

interface ActivityEntry {
	id: number;
	line: string;
}

interface RendererSnapshot {
	runState: RunDisplayState | null;
	ticketOrder: string[];
	tickets: TicketDisplayState[];
	activityEntries: ActivityEntry[];
	runStartedAtMs: number | null;
	runEndedAtMs: number | null;
	focusedTicketId: string | null;
	nowMs: number;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return value.slice(0, maxLength);
	return `${value.slice(0, maxLength - 1)}…`;
}

function formatDuration(totalDurationMs: number): string {
	const safeMs = Number.isFinite(totalDurationMs)
		? Math.max(0, totalDurationMs)
		: 0;
	const totalSeconds = Math.floor(safeMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}

	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}

	return `${seconds}s`;
}

function iconForStatus(status: TicketDisplayState["status"]): string {
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "active":
			return "▸";
		case "retrying":
			return "↻";
		default:
			return "·";
	}
}

function stageLabel(stage?: TicketDisplayStage): string {
	return stage ?? "queue";
}

function compactTicketLine(ticket: TicketDisplayState, width: number): string {
	const icon = iconForStatus(ticket.status);
	const idPart = ticket.ticketId.split("-").slice(-1)[0] ?? ticket.ticketId;
	const title = truncate(ticket.title, 20);
	const costPart =
		ticket.status === "queued" ? "queued" : `$${ticket.cost.toFixed(2)}`;
	return truncate(
		`${icon} ${idPart} ${title} ${costPart}`,
		Math.max(20, width),
	);
}

function ticketLine(ticket: TicketDisplayState, width: number): string {
	const icon = iconForStatus(ticket.status);
	const duration =
		ticket.status === "queued"
			? "queued"
			: formatDuration(Math.max(0, ticket.durationMs));
	const failureSuffix =
		ticket.status === "failed" && ticket.failureReason
			? ` FAILED: ${truncate(ticket.failureReason, 32)}`
			: "";
	const titleMax = Math.max(16, width - 42);
	const title = truncate(ticket.title, titleMax);
	const line = `${icon} ${ticket.ticketId}  ${title.padEnd(titleMax)}  ${ticket.status === "queued" ? "" : `$${ticket.cost.toFixed(2)}  ${duration}`}${ticket.status === "queued" ? "queued" : ""}${failureSuffix}`;
	return truncate(line, width);
}

function buildProgressBar(done: number, total: number): string {
	const normalizedTotal = Math.max(1, total);
	const clampedDone = Math.min(Math.max(0, done), normalizedTotal);
	return `${"■".repeat(clampedDone)}${"□".repeat(normalizedTotal - clampedDone)}`;
}

function formatHeaderBox(content: string, width: number): string[] {
	const innerWidth = Math.max(20, width - 2);
	const top = `╭${"─".repeat(innerWidth)}╮`;
	const bottom = `╰${"─".repeat(innerWidth)}╯`;
	const body = `│${truncate(content.padEnd(innerWidth), innerWidth)}│`;
	return [top, body, bottom];
}

function orderedTickets(snapshot: RendererSnapshot): TicketDisplayState[] {
	const byId = new Map(
		snapshot.tickets.map((ticket) => [ticket.ticketId, ticket]),
	);
	if (snapshot.ticketOrder.length === 0) {
		return [...snapshot.tickets];
	}

	const ordered: TicketDisplayState[] = [];
	for (const ticketId of snapshot.ticketOrder) {
		const ticket = byId.get(ticketId);
		if (ticket) ordered.push(ticket);
	}

	for (const ticket of snapshot.tickets) {
		if (!ordered.some((entry) => entry.ticketId === ticket.ticketId)) {
			ordered.push(ticket);
		}
	}

	return ordered;
}

function headerLines(
	snapshot: RendererSnapshot,
	stream: NodeJS.WriteStream,
): string[] {
	const width = stream.columns ?? 120;
	const tickets = orderedTickets(snapshot);
	const completed = tickets.filter(
		(ticket) => ticket.status === "completed",
	).length;
	const failed = tickets.filter((ticket) => ticket.status === "failed").length;
	const done = completed + failed;
	const total = tickets.length;
	const bar = buildProgressBar(done, total);
	const elapsedMs =
		snapshot.runEndedAtMs && snapshot.runStartedAtMs
			? snapshot.runEndedAtMs - snapshot.runStartedAtMs
			: snapshot.runStartedAtMs
				? snapshot.nowMs - snapshot.runStartedAtMs
				: (snapshot.runState?.elapsedMs ?? 0);
	const projectName = snapshot.runState?.projectName ?? "harness";
	const totalCost =
		snapshot.runState?.totalCost ??
		tickets.reduce((sum, ticket) => sum + ticket.cost, 0);
	const line = ` HARNESS  ${projectName}  ${bar} ${done}/${Math.max(total, 1)} tickets  $${totalCost.toFixed(2)}  ${formatDuration(Math.max(0, elapsedMs))}`;
	const header = formatHeaderBox(line, width);
	const lines = [...header, ""];

	const compact = width < 80;
	if (!(compact && tickets.length === 1)) {
		for (const ticket of tickets) {
			lines.push(
				compact ? compactTicketLine(ticket, width) : ticketLine(ticket, width),
			);
		}
	}

	const activeTickets = tickets.filter(
		(ticket) => ticket.status === "active" || ticket.status === "retrying",
	);
	let focused = activeTickets.find(
		(ticket) => ticket.ticketId === snapshot.focusedTicketId,
	);
	if (!focused) {
		focused = activeTickets[0];
	}

	if (focused) {
		const extraActive = Math.max(0, activeTickets.length - 1);
		const progress = focused.stageProgress
			? `${"█".repeat(Math.min(10, focused.stageProgress.current))}${"░".repeat(Math.max(0, 10 - focused.stageProgress.current))} turn ${focused.stageProgress.current}/${focused.stageProgress.max}`
			: `${formatDuration(Math.max(0, focused.durationMs))}`;
		const activeLine = ` ${iconForStatus(focused.status)} ${focused.ticketId} │ ${stageLabel(focused.stage)} │ ${progress}${extraActive > 0 ? ` │ +${extraActive} active` : ""}`;
		lines.push("", truncate(activeLine, width));
		if (focused.lastAction) {
			lines.push(
				`   last: ${truncate(focused.lastAction, Math.max(20, width - 9))}`,
			);
		}
	}

	lines.push("");
	return lines;
}

const StaticList = Static as unknown as ComponentType<{
	items: ActivityEntry[];
	children?: (item: ActivityEntry, index: number) => ReactNode;
}>;

function RendererView(props: {
	snapshot: RendererSnapshot;
	stream: NodeJS.WriteStream;
}): ReactElement {
	const lines = headerLines(props.snapshot, props.stream);

	return createElement(
		Box,
		{ flexDirection: "column" },
		...lines.map((line, index) =>
			createElement(Text, { key: `header-${index}` }, line),
		),
		createElement(StaticList, { items: props.snapshot.activityEntries }, ((
			entry: ActivityEntry,
		) =>
			createElement(
				Text,
				{ key: `log-${entry.id}` },
				entry.line,
			)) as unknown as ReactNode),
	);
}

export class TerminalRenderer {
	private runState: RunDisplayState | null = null;
	private ticketOrder: string[] = [];
	private readonly ticketMap = new Map<string, TicketDisplayState>();
	private readonly activityEntries: ActivityEntry[] = [];
	private nextActivityId = 1;
	private refreshTimer: NodeJS.Timeout | null = null;
	private running = false;
	private paused = false;
	private runStartedAtMs: number | null = null;
	private runEndedAtMs: number | null = null;
	private focusedTicketId: string | null = null;
	private inkApp: InkInstance | null = null;

	constructor(private readonly stream: NodeJS.WriteStream) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.mountInk();
		this.refreshTimer = setInterval(() => {
			this.renderNow();
		}, HEADER_REFRESH_MS);
		this.refreshTimer.unref();
		this.renderNow();
	}

	stop(): void {
		if (!this.running) return;
		this.runEndedAtMs = Date.now();
		this.running = false;
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.paused = false;
		this.renderNow();
		this.unmountInk();
	}

	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.unmountInk();
	}

	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		if (this.running) {
			this.mountInk();
			this.renderNow();
		}
	}

	updateRun(state: RunDisplayState): void {
		if (this.runStartedAtMs === null && state.tickets.length > 0) {
			this.runStartedAtMs = Date.now() - Math.max(0, state.elapsedMs);
		}

		this.runState = {
			...state,
			tickets: state.tickets.map((ticket) => ({ ...ticket })),
		};
		this.ticketOrder = state.tickets.map((ticket) => ticket.ticketId);
		for (const ticket of state.tickets) {
			const existing = this.ticketMap.get(ticket.ticketId);
			this.ticketMap.set(ticket.ticketId, {
				...existing,
				...ticket,
			});
		}
		this.renderNow();
	}

	updateTicket(ticketId: string, update: Partial<TicketDisplayState>): void {
		const previous = this.ticketMap.get(ticketId) ?? {
			ticketId,
			title: ticketId,
			status: "queued" as const,
			attempt: 0,
			cost: 0,
			durationMs: 0,
		};
		const merged: TicketDisplayState = { ...previous, ...update };
		this.ticketMap.set(ticketId, merged);
		if (!this.ticketOrder.includes(ticketId)) {
			this.ticketOrder.push(ticketId);
		}
		if (merged.status === "active" || merged.status === "retrying") {
			this.focusedTicketId = ticketId;
		}
		this.renderNow();
	}

	updateLastAction(ticketId: string, action: string): void {
		this.updateTicket(ticketId, { lastAction: action });
	}

	logStageResult(ticketId: string, _stage: string, content: string): void {
		void ticketId;
		this.appendLogBlock(content);
	}

	logCheckFailure(ticketId: string, checkName: string, output: string): void {
		void ticketId;
		this.appendLogBlock(
			` check  │ ✗ ${checkName}\n        │ ${truncate(output, 240)}`,
		);
	}

	logRetry(ticketId: string, attempt: number, reason: string): void {
		void ticketId;
		this.appendLogBlock(` retry  │ ↻ attempt ${attempt} — ${reason}`);
	}

	logTicketComplete(
		ticketId: string,
		sha: string,
		cost: number,
		duration: string,
	): void {
		void ticketId;
		this.appendLogBlock(
			` merge  │ ✓ ${sha}  │  $${cost.toFixed(2)}  │  ${duration}`,
		);
	}

	logTicketFailed(ticketId: string, reason: string): void {
		void ticketId;
		this.appendLogBlock(` merge  │ ✗ failed — ${reason}`);
	}

	private appendLogBlock(content: string): void {
		for (const line of content.split(/\r?\n/)) {
			this.activityEntries.push({ id: this.nextActivityId, line });
			this.nextActivityId += 1;
		}
		while (this.activityEntries.length > MAX_LOG_LINES) {
			this.activityEntries.shift();
		}
		this.renderNow();
	}

	private snapshot(): RendererSnapshot {
		return {
			runState: this.runState,
			ticketOrder: [...this.ticketOrder],
			tickets: Array.from(this.ticketMap.values()).map((ticket) => ({
				...ticket,
			})),
			activityEntries: [...this.activityEntries],
			runStartedAtMs: this.runStartedAtMs,
			runEndedAtMs: this.runEndedAtMs,
			focusedTicketId: this.focusedTicketId,
			nowMs: Date.now(),
		};
	}

	private renderNow(): void {
		if (!this.running || this.paused) return;
		this.mountInk();
		if (!this.inkApp) return;
		this.inkApp.rerender(
			createElement(RendererView, {
				snapshot: this.snapshot(),
				stream: this.stream,
			}),
		);
	}

	private mountInk(): void {
		if (this.inkApp || this.paused) return;
		this.inkApp = render(
			createElement(RendererView, {
				snapshot: this.snapshot(),
				stream: this.stream,
			}),
			{
				stdout: this.stream,
				stderr: process.stderr,
				exitOnCtrlC: false,
			},
		);
	}

	private unmountInk(): void {
		if (!this.inkApp) return;
		this.inkApp.unmount();
		this.inkApp = null;
	}
}
