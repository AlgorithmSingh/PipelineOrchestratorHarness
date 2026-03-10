export interface HITLRequest {
  type: "cascade_failure" | "merge_conflict" | "max_retries";
  ticketId: string;
  summary: string;
  retryCount: number;
  contractJson?: string;
  failureContext?: string;
}

export interface HITLResponse {
  decision: "approve" | "edit" | "reject" | "abort";
  editedContract?: string;
  humanNotes?: string;
}
