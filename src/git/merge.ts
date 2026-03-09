import { execa } from "execa";
import { MergeError } from "../errors.js";
import { Semaphore } from "../util/semaphore.js";

export interface MergeResult {
  success: boolean;
  conflicts?: string[];
  commitSha?: string;
}

const mergeSemaphore = new Semaphore(1);

export class MergeCoordinator {
  constructor(private readonly repoRoot: string, private readonly targetBranch: string) {}

  async dryRun(branch: string): Promise<MergeResult> {
    try {
      const { stdout: mergeBase } = await execa("git", ["merge-base", this.targetBranch, branch], {
        cwd: this.repoRoot,
      });
      const { stdout } = await execa(
        "git",
        ["merge-tree", mergeBase.trim(), this.targetBranch, branch],
        { cwd: this.repoRoot },
      );
      if (stdout.includes("<<<<<<<")) {
        return { success: false };
      }
      return { success: true };
    } catch (error) {
      throw new MergeError(`Dry-run merge failed for ${branch}`, {
        branchName: branch,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async merge(branch: string): Promise<MergeResult> {
    await mergeSemaphore.acquire();
    try {
      const { stdout: currentBranchStdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.repoRoot,
      });
      const currentBranch = currentBranchStdout.trim();

      try {
        await execa("git", ["checkout", this.targetBranch], { cwd: this.repoRoot });
        await execa("git", ["merge", "--no-ff", "--no-edit", branch], {
          cwd: this.repoRoot,
        });
        const { stdout: sha } = await execa("git", ["rev-parse", "HEAD"], { cwd: this.repoRoot });
        return { success: true, commitSha: sha.trim() };
      } catch {
        const { stdout: conflictFiles } = await execa(
          "git",
          ["diff", "--name-only", "--diff-filter=U"],
          { cwd: this.repoRoot },
        );
        try {
          await execa("git", ["merge", "--abort"], { cwd: this.repoRoot });
        } catch {
          // best effort
        }
        return {
          success: false,
          conflicts: conflictFiles
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        };
      } finally {
        await execa("git", ["checkout", currentBranch], { cwd: this.repoRoot });
      }
    } catch (error) {
      throw new MergeError(`Merge failed for ${branch}`, {
        branchName: branch,
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      mergeSemaphore.release();
    }
  }
}
