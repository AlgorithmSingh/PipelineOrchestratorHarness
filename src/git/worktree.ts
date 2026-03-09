import { execa } from "execa";
import { join } from "node:path";
import { WorktreeError } from "../errors.js";

export interface WorktreeInfo {
  ticketId: string;
  branch: string;
  path: string;
  createdAt: Date;
}

interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
}

async function runGit(
  repoRoot: string,
  args: string[],
  context?: { worktreePath?: string; branchName?: string },
): Promise<string> {
  try {
    const { stdout } = await execa("git", args, { cwd: repoRoot });
    return stdout;
  } catch (error) {
    throw new WorktreeError(`git ${args.join(" ")} failed`, {
      worktreePath: context?.worktreePath,
      branchName: context?.branchName,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function parseWorktreeOutput(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.trim().split("\n\n");
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    const lines = block.trim().split("\n");
    let path = "";
    let head = "";
    let branch = "";
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
    }
    if (path.length > 0) {
      entries.push({ path, head, branch });
    }
  }
  return entries;
}

export class WorktreeManager {
  constructor(
    private readonly repoRoot: string,
    private readonly baseDir: string,
    private readonly baseBranch: string,
  ) {}

  async create(ticketId: string): Promise<WorktreeInfo> {
    const path = join(this.baseDir, ticketId);
    const branch = `agent/${ticketId}`;
    await runGit(this.repoRoot, ["worktree", "add", "-b", branch, path, this.baseBranch], {
      worktreePath: path,
      branchName: branch,
    });
    return {
      ticketId,
      branch,
      path,
      createdAt: new Date(),
    };
  }

  async setup(ticketId: string, commands: string[]): Promise<void> {
    const path = join(this.baseDir, ticketId);
    for (const command of commands) {
      const [bin, ...args] = command.split(" ");
      if (!bin) continue;
      await execa(bin, args, { cwd: path, shell: true });
    }
  }

  async list(): Promise<WorktreeInfo[]> {
    const stdout = await runGit(this.repoRoot, ["worktree", "list", "--porcelain"]);
    const rows = parseWorktreeOutput(stdout);
    return rows
      .filter((row) => row.path.startsWith(this.baseDir))
      .map((row) => {
        const ticketId = row.branch.replace(/^agent\//, "");
        return {
          ticketId,
          branch: row.branch,
          path: row.path,
          createdAt: new Date(),
        };
      });
  }

  async cleanup(ticketId: string): Promise<void> {
    const path = join(this.baseDir, ticketId);
    const branch = `agent/${ticketId}`;
    try {
      await runGit(this.repoRoot, ["worktree", "remove", "--force", path], {
        worktreePath: path,
        branchName: branch,
      });
    } catch {
      // best effort
    }
    try {
      await runGit(this.repoRoot, ["branch", "-D", branch], {
        branchName: branch,
      });
    } catch {
      // best effort
    }
  }

  async isBranchMerged(branch: string): Promise<boolean> {
    try {
      await runGit(this.repoRoot, ["merge-base", "--is-ancestor", branch, this.baseBranch], {
        branchName: branch,
      });
      return true;
    } catch {
      return false;
    }
  }
}
