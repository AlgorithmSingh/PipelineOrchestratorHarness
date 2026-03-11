import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderMock, rerenderMock, unmountMock } = vi.hoisted(() => ({
	renderMock: vi.fn(),
	rerenderMock: vi.fn(),
	unmountMock: vi.fn(),
}));

vi.mock("ink", () => ({
	render: renderMock,
	Box: ({ children }: { children?: unknown }) => children ?? null,
	Text: ({ children }: { children?: unknown }) => children ?? null,
	Static: ({
		children,
		items,
	}: {
		children: (item: unknown, index: number) => unknown;
		items: unknown[];
	}) => items.map((item, index) => children(item, index)),
}));

import { TerminalRenderer } from "./renderer.js";

function createTestStream(): NodeJS.WriteStream {
	return process.stdout as unknown as NodeJS.WriteStream;
}

describe("TerminalRenderer (Ink)", () => {
	beforeEach(() => {
		renderMock.mockReset();
		rerenderMock.mockReset();
		unmountMock.mockReset();
		renderMock.mockImplementation(() => ({
			rerender: rerenderMock,
			unmount: unmountMock,
		}));
	});

	it("mounts Ink and rerenders on state updates", () => {
		const renderer = new TerminalRenderer(createTestStream());
		renderer.start();

		expect(renderMock).toHaveBeenCalledTimes(1);
		expect(rerenderMock).toHaveBeenCalled();

		renderer.updateRun({
			projectName: "todolist14",
			totalCost: 1.24,
			elapsedMs: 5_000,
			tickets: [
				{
					ticketId: "todolist14-abc",
					title: "JSON File Persistence",
					status: "active",
					stage: "coder",
					attempt: 0,
					cost: 0.22,
					durationMs: 2_000,
				},
			],
		});
		renderer.updateLastAction("todolist14-abc", "bash npm test");
		renderer.logStageResult("todolist14-abc", "code", "code block");

		expect(rerenderMock).toHaveBeenCalled();
		renderer.stop();
	});

	it("unmounts on pause and remounts on resume", () => {
		const renderer = new TerminalRenderer(createTestStream());
		renderer.start();
		renderer.pause();

		expect(unmountMock).toHaveBeenCalledTimes(1);

		renderer.resume();
		expect(renderMock).toHaveBeenCalledTimes(2);
		renderer.stop();
	});

	it("unmounts Ink instance on stop", () => {
		const renderer = new TerminalRenderer(createTestStream());
		renderer.start();
		renderer.stop();

		expect(unmountMock).toHaveBeenCalled();
	});
});
