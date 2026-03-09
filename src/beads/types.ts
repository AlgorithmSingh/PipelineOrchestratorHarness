export interface Ticket {
  id: string;
  title: string;
  status: "open" | "in-progress" | "closed" | (string & {});
  priority: number;
  type: "task" | "bug" | "epic" | (string & {});
  description?: string;
  labels?: string[];
  blocks?: string[];
  blockedBy?: string[];
}

export interface TicketFilter {
  label?: string;
  status?: string;
  type?: string;
}
