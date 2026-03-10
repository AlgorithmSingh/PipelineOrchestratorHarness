import { execa } from "execa";
import { BeadsError } from "../errors.js";
import type { Ticket, TicketFilter } from "./types.js";

interface RawTicket extends Omit<Ticket, "type"> {
  issue_type?: string;
  type?: string;
}

function normalizeTicket(raw: RawTicket): Ticket {
  return {
    ...raw,
    type: raw.issue_type ?? raw.type ?? "task",
    status: raw.status,
  };
}

function parseJson<T>(stdout: string, context: string): T {
  if (stdout.trim().length === 0) {
    throw new BeadsError(`Empty output from bd ${context}`, { command: context });
  }
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new BeadsError(`Invalid JSON output from bd ${context}`, {
      command: context,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export interface BeadsClient {
  healthCheck(): Promise<boolean>;
  ready(filter?: TicketFilter): Promise<Ticket[]>;
  create(opts: {
    title: string;
    body: string;
    type: "task" | "bug" | "epic";
    priority: number;
    labels?: string[];
    parent?: string;
    blocks?: string[];
  }): Promise<Ticket>;
  claim(ticketId: string, agent: string): Promise<void>;
  update(ticketId: string, updates: { status?: string; labels?: string[]; body?: string }): Promise<void>;
  close(ticketId: string, resolution: string): Promise<void>;
  get(ticketId: string): Promise<Ticket>;
  list(filter?: TicketFilter): Promise<Ticket[]>;
  addDependency(from: string, to: string, type: "blocks"): Promise<void>;
  checkCycles(): Promise<string[]>;
}

export function createBeadsClient(cwd: string): BeadsClient {
  async function runBd(args: string[], context: string): Promise<string> {
    try {
      const { stdout } = await execa("bd", args, { cwd });
      return stdout;
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new BeadsError(`bd ${context} failed`, {
        command: `bd ${args.join(" ")} :: ${details}`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  return {
    async healthCheck() {
      try {
        await execa("bd", ["--version"], { cwd });
        return true;
      } catch {
        return false;
      }
    },

    async ready(filter) {
      const args = ["ready", "--json"];
      if (filter?.label) {
        args.push("--label", filter.label);
      }
      const stdout = await runBd(args, "ready");
      const raw = parseJson<RawTicket[]>(stdout, "ready");
      return raw.map(normalizeTicket);
    },

    async create(opts) {
      const args = [
        "create",
        opts.title,
        "--json",
        "--type",
        opts.type,
        "--priority",
        String(opts.priority),
        "--description",
        opts.body,
      ];
      if (opts.parent) {
        args.push("--parent", opts.parent);
      }
      if (opts.labels && opts.labels.length > 0) {
        args.push("--labels", opts.labels.join(","));
      }
      const stdout = await runBd(args, "create");
      const created = parseJson<RawTicket>(stdout, "create");

      if (opts.blocks && opts.blocks.length > 0) {
        for (const blockedTicket of opts.blocks) {
          await runBd(["depend", "add", created.id, blockedTicket, "--type", "blocks"], "depend add");
        }
      }

      return normalizeTicket(created);
    },

    async claim(ticketId, _agent) {
      await runBd(["update", ticketId, "--claim"], `claim ${ticketId}`);
    },

    async update(ticketId, updates) {
      const args = ["update", ticketId];
      if (updates.status) args.push("--status", updates.status);
      if (updates.body) args.push("--description", updates.body);
      if (updates.labels) {
        for (const label of updates.labels) {
          args.push("--add-label", label);
        }
      }
      await runBd(args, `update ${ticketId}`);
    },

    async close(ticketId, resolution) {
      await runBd(["close", ticketId, "--reason", resolution], `close ${ticketId}`);
    },

    async get(ticketId) {
      const stdout = await runBd(["show", ticketId, "--json"], `show ${ticketId}`);
      const rows = parseJson<RawTicket[]>(stdout, `show ${ticketId}`);
      const first = rows[0];
      if (!first) {
        throw new BeadsError(`Ticket not found: ${ticketId}`, { command: `show ${ticketId}` });
      }
      return normalizeTicket(first);
    },

    async list(filter) {
      const args = ["list", "--json"];
      if (filter?.status) args.push("--status", filter.status);
      if (filter?.type) args.push("--type", filter.type);
      if (filter?.label) args.push("--label", filter.label);
      const stdout = await runBd(args, "list");
      const rows = parseJson<RawTicket[]>(stdout, "list");
      return rows.map(normalizeTicket);
    },

    async addDependency(from, to, type) {
      await runBd(["depend", "add", from, to, "--type", type], "depend add");
    },

    async checkCycles() {
      const stdout = await runBd(["depend", "cycles", "--json"], "depend cycles");
      return parseJson<string[]>(stdout, "depend cycles");
    },
  };
}
