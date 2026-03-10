import * as readline from "node:readline";
import type { HITLRequest, HITLResponse } from "./types.js";

export class HITLGate {
  private readonly timeoutMs: number;

  constructor(timeoutMinutes: number) {
    this.timeoutMs = timeoutMinutes * 60 * 1000;
  }

  async prompt(request: HITLRequest): Promise<HITLResponse> {
    process.stdout.write("\n========================================\n");
    process.stdout.write("  HUMAN INTERVENTION REQUIRED\n");
    process.stdout.write("========================================\n\n");
    process.stdout.write(`Ticket:  ${request.ticketId}\n`);
    process.stdout.write(`Type:    ${request.type}\n`);
    process.stdout.write(`Retries: ${request.retryCount}\n`);
    process.stdout.write(`Summary: ${request.summary}\n`);

    if (request.failureContext) {
      process.stdout.write(`\nFailure Context:\n${request.failureContext}\n`);
    }

    process.stdout.write("\nOptions:\n");
    process.stdout.write("  [a] approve — retry with current contract\n");
    process.stdout.write("  [e] edit    — provide updated contract\n");
    process.stdout.write("  [r] reject  — mark ticket as failed\n");
    process.stdout.write("  [x] abort   — abort and cleanup\n\n");

    const answer = await this.ask("Decision (a/e/r/x): ");

    switch (answer.trim().toLowerCase()) {
      case "a":
        return { decision: "approve" };
      case "e": {
        const notes = await this.ask("Enter notes/guidance for retry: ");
        return { decision: "edit", humanNotes: notes };
      }
      case "r":
        return { decision: "reject" };
      case "x":
        return { decision: "abort" };
      default:
        process.stdout.write("Invalid choice, defaulting to abort.\n");
        return { decision: "abort" };
    }
  }

  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const timer = setTimeout(() => {
        rl.close();
        process.stdout.write("\nHITL timeout reached. Auto-aborting.\n");
        resolve("x");
      }, this.timeoutMs);

      rl.question(question, (answer) => {
        clearTimeout(timer);
        rl.close();
        resolve(answer);
      });
    });
  }
}
