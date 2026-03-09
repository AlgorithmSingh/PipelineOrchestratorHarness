import type { Logger } from "pino";
import type { HarnessConfig } from "../types.js";
import { PipelineError } from "../errors.js";
import { createBeadsClient } from "../beads/client.js";
import type { Ticket } from "../beads/types.js";
import { Semaphore } from "../util/semaphore.js";

export class ExecutionPipeline {
  private readonly beads;
  private readonly semaphore: Semaphore;

  constructor(
    private readonly config: HarnessConfig,
    private readonly logger: Logger,
  ) {
    this.beads = createBeadsClient(this.config.project.root);
    this.semaphore = new Semaphore(this.config.pipelines.execution.maxParallelAgents);
  }

  async runOnce(): Promise<void> {
    const pipelineLogger = this.logger.child({ pipeline: "execution" });
    const beadsAvailable = await this.beads.healthCheck();
    if (!beadsAvailable) {
      throw new PipelineError(
        "Beads CLI is unavailable. Install/configure `bd` before running execution pipeline.",
        { pipeline: "execution" },
      );
    }

    const tickets = await this.beads.ready({ label: "pipeline:execution" });
    pipelineLogger.info({ event: "tickets_polled", count: tickets.length }, "polled execution tickets");

    const selected = tickets.slice(0, this.config.pipelines.execution.maxParallelAgents);
    await Promise.all(
      selected.map(async (ticket) => {
        await this.semaphore.acquire();
        try {
          await this.processTicket(ticket);
        } finally {
          this.semaphore.release();
        }
      }),
    );
  }

  private async processTicket(ticket: Ticket): Promise<void> {
    const ticketLogger = this.logger.child({
      pipeline: "execution",
      ticketId: ticket.id,
    });
    try {
      await this.beads.claim(ticket.id, "harness-execution");
      ticketLogger.info({ event: "ticket_claimed", ticketId: ticket.id }, "ticket claimed");

      // Initial execution milestone:
      // full planner/coder/reviewer state-machine loop is not wired yet.
      await this.beads.update(ticket.id, {
        labels: [...(ticket.labels ?? []), "role:planner"],
      });
      ticketLogger.info({ event: "ticket_staged", ticketId: ticket.id }, "ticket staged for planner");
    } catch (error) {
      throw new PipelineError(`Execution pipeline failed for ticket ${ticket.id}`, {
        pipeline: "execution",
        ticketId: ticket.id,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}
