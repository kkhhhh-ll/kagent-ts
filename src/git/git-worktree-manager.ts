import { execFile, type ExecFileException } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ConsoleLogger } from "../logging/logger";
import type { Logger } from "../logging/logger";
import type {
  GitWorktreeConfig,
  GitWorktreeErrorCode,
  WorktreeInfo,
  WorktreeStatus,
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  WorktreeStatusResult,
  WorktreeSessionState,
} from "./git-types";
import { GitWorktreeError } from "./git-types";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Format a git command for display in error messages (never executed). */
function formatGitCmd(args: string[]): string {
  return `git ${args.join(" ")}`;
}

/**
 * Classify an execFile error + git stderr into a `GitWorktreeError`.
 */
function classifyGitError(
  error: ExecFileException,
  args: string[],
  stderr: string,
  worktreeId?: string,
): GitWorktreeError {
  const cmd = formatGitCmd(args);
  const combined = `${error.message}\n${stderr}`;

  // Git binary not found
  if (error.code === "ENOENT") {
    return new GitWorktreeError(
      `Git executable not found in PATH. Ensure git is installed and accessible.\nCommand: ${cmd}`,
      "GIT_NOT_FOUND",
      worktreeId,
    );
  }

  // Permission
  if (error.code === "EACCES" || error.code === "EPERM") {
    return new GitWorktreeError(
      `Permission denied when running: ${cmd}\n${stderr}`,
      "PERMISSION_DENIED",
      worktreeId,
    );
  }

  // Classify by stderr content
  const lower = combined.toLowerCase();

  if (lower.includes("already exists") || lower.includes("already checked out")) {
    return new GitWorktreeError(
      `Branch or worktree already exists.\nCommand: ${cmd}\n${stderr}`,
      "BRANCH_EXISTS",
      worktreeId,
    );
  }

  if (
    lower.includes("conflict") ||
    lower.includes("automerge failed") ||
    lower.includes("merge conflict")
  ) {
    return new GitWorktreeError(
      `Merge conflict during operation.\nCommand: ${cmd}\n${stderr}`,
      "MERGE_CONFLICT",
      worktreeId,
    );
  }

  if (
    lower.includes("not a worktree") ||
    lower.includes("not a working tree") ||
    lower.includes("is not a working tree")
  ) {
    return new GitWorktreeError(
      `Path is not a git worktree.\nCommand: ${cmd}\n${stderr}`,
      "WORKTREE_NOT_FOUND",
      worktreeId,
    );
  }

  if (
    lower.includes("dirty") ||
    lower.includes("uncommitted") ||
    lower.includes("untracked")
  ) {
    return new GitWorktreeError(
      `Worktree has uncommitted changes.\nCommand: ${cmd}\n${stderr}`,
      "WORKTREE_DIRTY",
      worktreeId,
    );
  }

  // Determine operation type for default error code
  const subcommand = args[0];
  const code: GitWorktreeErrorCode =
    subcommand === "worktree" && args[1] === "remove"
      ? "WORKTREE_REMOVE_FAILED"
      : subcommand === "worktree" && args[1] === "add"
        ? "WORKTREE_CREATE_FAILED"
        : "GIT_OPERATION_FAILED";

  return new GitWorktreeError(
    `Git command failed: ${cmd}\n${stderr}`,
    code,
    worktreeId,
  );
}

// ─── GitWorktreeManager ─────────────────────────────────────────────────────

/**
 * Manages isolated git worktree environments for sub-agent execution.
 *
 * Each worktree is a separate checkout of the repository on its own branch.
 * Sub-agents running in different worktrees cannot interfere with each other's
 * file changes.  When a node completes, the worktree's branch can optionally
 * be merged back and the worktree removed.
 *
 * ## Usage
 *
 * ```ts
 * const mgr = new GitWorktreeManager({ repoPath: "/path/to/repo" });
 * const wt = await mgr.createWorktree({ nodeId: "task-1" });
 * // sub-agent works in wt.path ...
 * await mgr.removeWorktree(wt.id, { mergeBack: true, deleteBranch: true });
 * ```
 *
 * ## Session persistence
 *
 * `buildSessionState()` and `restoreSessionState()` allow the orchestrator
 * to checkpoint worktree metadata so interrupted sessions can be resumed.
 */
export class GitWorktreeManager {
  // ── Configuration ─────────────────────────────────────────────────────

  private repoPath: string;
  private worktreesDir: string;
  private defaultBaseRef: string;
  private branchPrefix: string;
  private logger: Logger;

  // ── State ──────────────────────────────────────────────────────────────

  /** In-memory registry of all worktrees managed by this instance. */
  private worktrees: Map<string, WorktreeInfo> = new Map();

  constructor(config: GitWorktreeConfig) {
    if (!config.repoPath || !path.isAbsolute(config.repoPath)) {
      throw new GitWorktreeError(
        `repoPath must be an absolute path. Got: "${config.repoPath}"`,
        "INVALID_CONFIG",
      );
    }

    this.repoPath = config.repoPath;
    this.worktreesDir = config.worktreesDir ?? path.join(this.repoPath, ".kagent-worktrees");
    this.defaultBaseRef = config.defaultBaseRef ?? "HEAD";
    this.branchPrefix = config.branchPrefix ?? "kagent";
    this.logger = config.logger ?? new ConsoleLogger();

    // Ensure worktreesDir exists early — if we can't write here, fail fast.
    try {
      fs.mkdirSync(this.worktreesDir, { recursive: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GitWorktreeError(
        `Cannot create worktree directory "${this.worktreesDir}": ${message}`,
        "PERMISSION_DENIED",
      );
    }
  }

  // ─── Static Methods ───────────────────────────────────────────────────

  /**
   * Check whether `git` is available on the system PATH.
   */
  static async isGitAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile("git", ["--version"], { timeout: 10_000 }, (error) => {
        resolve(error === null || error === undefined);
      });
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Create a new git worktree on its own branch.
   *
   * 1. Generates or uses the provided branch name.
   * 2. Runs `git worktree add <path> -b <branch> <baseRef>`.
   * 3. Records metadata in the in-memory map.
   */
  async createWorktree(options: CreateWorktreeOptions = {}): Promise<WorktreeInfo> {
    const branchName = options.branchName ?? this.generateBranchName(options.nodeId);
    const baseRef = options.baseRef ?? this.defaultBaseRef;
    const id = this.generateWorktreeId();
    const worktreePath = path.join(this.worktreesDir, id);

    // Validate externally-provided branch names (auto-generated ones are already safe)
    if (options.branchName) {
      this.validateBranchName(options.branchName);
    }

    // Check for branch name collision in git
    const existingBranch = await this.branchExists(branchName);
    if (existingBranch) {
      throw new GitWorktreeError(
        `Branch "${branchName}" already exists.`,
        "BRANCH_EXISTS",
        id,
      );
    }

    this.logger.info(
      "GitWorktree",
      `Creating worktree "${id}" on branch "${branchName}" from "${baseRef}"…`,
    );

    try {
      await this.runGit([
        "worktree", "add",
        "--no-track",
        "-b", branchName,
        worktreePath,
        baseRef,
      ], undefined, undefined, id);
    } catch (err: unknown) {
      // Clean up partial state on failure
      this.worktrees.delete(id);
      throw err;
    }

    const info: WorktreeInfo = {
      id,
      path: worktreePath,
      branchName,
      baseRef,
      nodeId: options.nodeId,
      createdAt: new Date().toISOString(),
      status: "active",
      isDirty: false,
      metadata: options.metadata,
    };

    this.worktrees.set(id, info);
    this.logger.info("GitWorktree", `Worktree "${id}" created at ${worktreePath}.`);

    return { ...info };
  }

  /**
   * Remove a worktree from disk.
   *
   * @param identifier — Worktree ID or absolute path.
   * @param options    — Control merge-back, force, branch deletion.
   */
  async removeWorktree(
    identifier: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<void> {
    const info = this.findWorktree(identifier);

    // Optional: merge the branch back before removing.
    // The entire merge block is wrapped in a single try-catch so that ANY
    // exception (including unexpected ones from runGit) sets mergeFailed.
    // This prevents the branch from being deleted when the merge didn't
    // actually succeed.
    let mergeFailed = false;
    if (options.mergeBack) {
      const mergeTarget = options.mergeTarget ?? info.baseRef;
      this.logger.info(
        "GitWorktree",
        `Merging branch "${info.branchName}" into "${mergeTarget}"…`,
      );

      // originalBranch is declared here so the catch block can access it for
      // restoration.  It's only set if we successfully determine the branch.
      let originalBranch: string | undefined;

      try {
        // Save the current branch so we can restore it on failure.
        const { stdout: origOut } = await this.runGit(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          this.repoPath,
          undefined,
          info.id,
        );
        originalBranch = origOut.trim();

        // Guard: check the worktree itself for uncommitted changes before
        // merging — only committed changes on the worktree branch will be
        // carried into the merge target.
        const { stdout: wtStatusOut } = await this.runGit(
          ["status", "--porcelain"],
          info.path,
          undefined,
          info.id,
        );
        if (wtStatusOut.trim().length > 0) {
          throw new GitWorktreeError(
            `Cannot merge: worktree "${info.id}" has uncommitted changes. ` +
            `Commit or stash them in the worktree first, or use force to discard.`,
            "WORKTREE_DIRTY",
            info.id,
          );
        }

        // Guard: refuse to checkout if the main repo has uncommitted changes.
        //
        // NOTE: there is an inherent TOCTOU window between this check and the
        // checkout below — another process could modify the working tree in
        // between.  This is a fundamental limitation of doing the merge inside
        // the main repository rather than in a dedicated temporary worktree.
        // A future refactor should consider using `git worktree add` to stage
        // the merge in isolation, then pushing the result.
        const { stdout: statusOut } = await this.runGit(
          ["status", "--porcelain"],
          this.repoPath,
          undefined,
          info.id,
        );
        if (statusOut.trim().length > 0) {
          throw new GitWorktreeError(
            `Cannot merge: main repository has uncommitted changes. Please commit or stash them first.`,
            "WORKTREE_DIRTY",
            info.id,
          );
        }

        // Checkout the merge target branch in the main repo
        await this.runGit(["checkout", mergeTarget], this.repoPath, undefined, info.id);

        // Merge the worktree branch
        await this.runGit(
          ["merge", info.branchName, "--no-edit"],
          this.repoPath,
          undefined,
          info.id,
        );
        this.logger.info("GitWorktree", `Merged "${info.branchName}" → "${mergeTarget}".`);

        // Optional: push.  Push failure does NOT invalidate the local merge —
        // the merge is already committed locally.  Log a warning so the caller
        // can decide whether to retry the push separately.
        if (options.pushAfterMerge) {
          try {
            await this.runGit(["push", "origin", mergeTarget], this.repoPath, undefined, info.id);
            this.logger.info("GitWorktree", `Pushed "${mergeTarget}" to origin.`);
          } catch (pushErr: unknown) {
            this.logger.warn(
              "GitWorktree",
              `Merge committed locally but push to origin/${mergeTarget} failed: ` +
              `${pushErr instanceof Error ? pushErr.message : String(pushErr)}. ` +
              `Push must be retried manually.`,
            );
          }
        }
      } catch (err: unknown) {
        mergeFailed = true;

        // Restore the original branch before throwing so the main repo is not
        // left stranded on the merge target.  Only possible if we successfully
        // determined originalBranch above.
        if (originalBranch) {
          try {
            await this.runGit(["checkout", originalBranch], this.repoPath, undefined, info.id);
          } catch {
            this.logger.warn(
              "GitWorktree",
              `Failed to restore original branch "${originalBranch}" after merge failure. ` +
              `Main repo may be left on "${mergeTarget}".`,
            );
          }
        }

        // Leave the worktree in place so the user can inspect the conflict
        info.status = "failed";
        if (err instanceof GitWorktreeError) throw err;
        throw new GitWorktreeError(
          `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
          "MERGE_CONFLICT",
          info.id,
        );
      }
    }

    // Remove the worktree directory + git metadata
    try {
      const rmArgs = ["worktree", "remove"];
      if (options.force) rmArgs.push("--force");
      rmArgs.push(info.path);
      await this.runGit(rmArgs, this.repoPath, undefined, info.id);
      info.status = "completed";
    } catch (err: unknown) {
      if (options.force && err instanceof GitWorktreeError) {
        // Last resort: rm -rf the directory, then prune
        this.logger.warn("GitWorktree", `Force-removing worktree directory: ${info.path}`);
        try {
          fs.rmSync(info.path, { recursive: true, force: true });
          await this.runGit(["worktree", "prune"], this.repoPath, undefined, info.id);
          info.status = "completed";
        } catch {
          info.status = "failed";
          this.logger.warn("GitWorktree", `Failed to force-remove worktree "${info.id}".`);
        }
      } else {
        info.status = "failed";
        throw err;
      }
    }

    // Delete the branch — skip only when the merge itself failed (we keep the
    // branch for inspection).  If the merge succeeded but worktree removal
    // failed, the branch was already merged and can be safely deleted.
    if (options.deleteBranch && !mergeFailed) {
      try {
        await this.runGit(["branch", "-D", info.branchName], this.repoPath, undefined, info.id);
        this.logger.info("GitWorktree", `Deleted branch "${info.branchName}".`);
      } catch {
        this.logger.warn("GitWorktree", `Could not delete branch "${info.branchName}".`);
      }
    }

    // Keep the entry in the map for tracking (status = "completed").
    // Use `listWorktrees("completed")` to find removed worktrees.
    this.logger.info("GitWorktree", `Worktree "${info.id}" removed.`);
  }

  /**
   * List worktrees managed by this instance, optionally filtered by status.
   */
  listWorktrees(status?: WorktreeStatus): WorktreeInfo[] {
    const all = Array.from(this.worktrees.values());
    if (status) {
      return all.filter((w) => w.status === status);
    }
    return all;
  }

  /**
   * Remove completed and failed entries from the in-memory registry.
   *
   * Without this, the `worktrees` Map grows unboundedly in a long-running
   * process.  Call periodically or after a batch of worktree operations.
   *
   * @param olderThanMs — Only prune entries whose `createdAt` is older than
   *   this many milliseconds.  Omit to prune all completed/failed entries.
   * @returns Number of entries removed.
   */
  prune(olderThanMs?: number): number {
    let removed = 0;
    const cutoff = olderThanMs != null ? Date.now() - olderThanMs : 0;

    for (const [id, wt] of this.worktrees) {
      if (wt.status === "active") continue;
      if (olderThanMs != null) {
        const created = new Date(wt.createdAt).getTime();
        if (created >= cutoff) continue;
      }
      this.worktrees.delete(id);
      removed++;
    }

    if (removed > 0) {
      this.logger.info("GitWorktree", `Pruned ${removed} worktree entry(s) from registry.`);
    }
    return removed;
  }

  /**
   * Get detailed status of a specific worktree by ID or path.
   */
  async getWorktreeStatus(identifier: string): Promise<WorktreeStatusResult> {
    // Try to find in our map first
    let info: WorktreeInfo | undefined;
    try {
      info = this.findWorktree(identifier);
    } catch {
      // Not tracked by us; check disk anyway
    }

    // Resolve relative paths against cwd so fs.existsSync works regardless of
    // what directory the process happens to be in.
    const worktreePath = info?.path ?? path.resolve(identifier);
    const exists = fs.existsSync(worktreePath);

    let branchExists = false;
    let isDirty = false;
    let gitStatus = "";

    if (exists) {
      // Check if it's a git worktree by looking for .git
      const dotGit = path.join(worktreePath, ".git");
      if (fs.existsSync(dotGit)) {
        try {
          const { stdout } = await this.runGit(
            ["status", "--porcelain"],
            worktreePath,
            undefined,
            info?.id,
          );
          gitStatus = stdout;
          isDirty = stdout.trim().length > 0;

          if (info?.branchName) {
            try {
              await this.runGit(
                ["rev-parse", "--verify", info.branchName],
                this.repoPath,
                5_000,
                info.id,
              );
              branchExists = true;
            } catch {
              branchExists = false;
            }
          }
        } catch {
          // Non-fatal — status check failed for some reason
        }
      }
    }

    return {
      exists,
      info: info ? { ...info, isDirty } : undefined,
      branchExists,
      isDirty,
      gitStatus,
    };
  }

  /**
   * Return the main repository path.
   */
  getRepoPath(): string {
    return this.repoPath;
  }

  /**
   * Clean up all active worktrees managed by this instance.
   *
   * Called during shutdown / cancellation.  Failed worktrees are preserved
   * on disk for debugging; active ones are force-removed.
   */
  async cleanup(): Promise<void> {
    // Clean up both "active" and "failed" worktrees — "failed" worktrees may
    // still have disk directories that would leak if we skip them.
    const toClean = Array.from(this.worktrees.values()).filter(
      (w) => w.status === "active" || w.status === "failed",
    );

    if (toClean.length === 0) return;

    this.logger.info("GitWorktree", `Cleaning up ${toClean.length} worktree(s)…`);

    for (const wt of toClean) {
      try {
        await this.removeWorktree(wt.id, {
          force: true,
          deleteBranch: true,
        });
      } catch (err: unknown) {
        this.logger.warn(
          "GitWorktree",
          `Failed to clean up worktree "${wt.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ─── Session Persistence ──────────────────────────────────────────────

  /**
   * Build a serializable session state snapshot for checkpointing.
   */
  buildSessionState(): WorktreeSessionState {
    return {
      worktrees: Array.from(this.worktrees.values()).map((w) => ({ ...w })),
    };
  }

  /**
   * Restore worktree state from a saved session checkpoint.
   */
  restoreSessionState(state: WorktreeSessionState): void {
    if (this.worktrees.size > 0) {
      this.logger.warn(
        "GitWorktree",
        `Restoring session state while ${this.worktrees.size} existing worktree(s) ` +
        `are still in the registry.  Consider calling cleanup() first to avoid ` +
        `leaking disk resources from the previous session.`,
      );
    }
    this.worktrees.clear();
    for (const wt of state.worktrees) {
      // Only restore worktrees whose directories AND .git file still exist
      // (a worktree's .git is a text file pointing to the main repo; without
      // it the directory is not a valid worktree).
      const dotGit = path.join(wt.path, ".git");
      if (fs.existsSync(wt.path) && fs.existsSync(dotGit)) {
        this.worktrees.set(wt.id, { ...wt });
      } else {
        const reason = !fs.existsSync(wt.path)
          ? "directory missing"
          : ".git file missing (not a valid worktree)";
        this.logger.warn(
          "GitWorktree",
          `Worktree "${wt.id}" at ${wt.path} ${reason} — skipping.`,
        );
      }
    }
    this.logger.info(
      "GitWorktree",
      `Restored ${this.worktrees.size} worktree(s) from session.`,
    );
  }

  // ─── Private Methods ──────────────────────────────────────────────────

  /**
   * Run a git command via `child_process.execFile` (no shell — safe from injection).
   *
   * @returns Parsed { stdout, stderr }.
   * @throws GitWorktreeError on any failure.
   */
  private runGit(
    args: string[],
    cwd?: string,
    timeoutMs = 30_000,
    worktreeId?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: cwd ?? this.repoPath, timeout: timeoutMs },
        (error, stdout, stderr) => {
          if (error) {
            reject(classifyGitError(error, args, stderr, worktreeId));
            return;
          }
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
        },
      );
    });
  }

  /**
   * Check whether a branch name exists in the repository.
   */
  private async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.runGit(
        ["show-ref", "--verify", `refs/heads/${branchName}`],
        this.repoPath,
        5_000,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Look up a worktree by ID or path.
   *
   * Tries (in order): exact ID match, exact path match, cwd-relative
   * resolved path, and worktreesDir-relative resolved path.
   */
  private findWorktree(identifier: string): WorktreeInfo {
    // Try by ID first
    const byId = this.worktrees.get(identifier);
    if (byId) return byId;

    // Try by path (exact, cwd-relative, worktreesDir-relative)
    for (const wt of this.worktrees.values()) {
      if (
        wt.path === identifier ||
        wt.path === path.resolve(identifier) ||
        wt.path === path.resolve(this.worktreesDir, identifier)
      ) {
        return wt;
      }
    }

    throw new GitWorktreeError(
      `Worktree "${identifier}" not found in manager registry.`,
      "WORKTREE_NOT_FOUND",
    );
  }

  /**
   * Generate a unique worktree ID.
   */
  private generateWorktreeId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
    return `wt-${ts}-${rand}`;
  }

  /**
   * Generate a branch name for a new worktree.
   *
   * Format: `{prefix}/{nodeId}-{timestamp}` or `{prefix}/task-{timestamp}-{random}`
   */
  private generateBranchName(nodeId?: string): string {
    const ts = Date.now().toString(36);
    if (nodeId) {
      // Sanitize nodeId for branch name use (only letters, digits, hyphens, underscores)
      const sanitized = nodeId.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
      // If the entire nodeId consisted of special characters, sanitized will
      // be empty (or just "-").  Fall back to "task" to avoid an invalid name.
      const safePart = sanitized.replace(/^-+|-+$/g, "") || "task";
      return `${this.branchPrefix}/${safePart}-${ts}`;
    }
    const rand = Math.floor(Math.random() * 0x1000)
      .toString(16)
      .padStart(3, "0");
    return `${this.branchPrefix}/task-${ts}-${rand}`;
  }

  /**
   * Validate that a branch name only contains safe characters.
   *
   * Allows alphanumerics, hyphens, underscores, forward slashes, and dots —
   * the characters git itself considers safe for refnames.  Throws on
   * shell metacharacters or other potentially dangerous sequences so that
   * even if the execution layer has a defect, a malicious branch name
   * cannot inject commands.
   */
  private validateBranchName(branchName: string): void {
    // git refname rules + defense-in-depth block on shell metacharacters
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/.test(branchName)) {
      throw new GitWorktreeError(
        `Invalid branch name: "${branchName}". Branch names must start with an alphanumeric character and contain only alphanumerics, dots, hyphens, underscores, and forward slashes.`,
        "INVALID_CONFIG",
      );
    }

    // Block shell metacharacters even if they sneak past the regex above
    if (/[$`;|&!\\<>(){}[\]'"*?~]/.test(branchName)) {
      throw new GitWorktreeError(
        `Invalid branch name: "${branchName}". Branch names must not contain shell metacharacters.`,
        "INVALID_CONFIG",
      );
    }

    // Reject branch names that look like command-line flags
    if (branchName.startsWith("-")) {
      throw new GitWorktreeError(
        `Invalid branch name: "${branchName}". Branch names must not start with a hyphen.`,
        "INVALID_CONFIG",
      );
    }
  }
}
