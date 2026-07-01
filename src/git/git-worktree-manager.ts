import { exec } from "child_process";
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

/** Quote a string argument if it contains spaces. */
function quoteArg(arg: string): string {
  if (arg.includes(" ") && !arg.startsWith('"')) {
    return `"${arg}"`;
  }
  return arg;
}

/** Build a shell-safe git command string from an args array. */
function buildGitCmd(args: string[]): string {
  return `git ${args.map(quoteArg).join(" ")}`;
}

/**
 * Classify a child_process exec error + git stderr into a `GitWorktreeError`.
 */
function classifyGitError(
  error: Error & { code?: number | string; killed?: boolean },
  args: string[],
  stderr: string,
  worktreeId?: string,
): GitWorktreeError {
  const cmd = buildGitCmd(args);
  const combined = `${error.message}\n${stderr}`;

  // Git binary not found
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return new GitWorktreeError(
      `Git executable not found in PATH. Ensure git is installed and accessible.\nCommand: ${cmd}`,
      "GIT_NOT_FOUND",
      worktreeId,
    );
  }

  // Permission
  if (
    (error as NodeJS.ErrnoException).code === "EACCES" ||
    (error as NodeJS.ErrnoException).code === "EPERM"
  ) {
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
        : "WORKTREE_CREATE_FAILED";

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
  private autoCleanup: boolean;
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
    this.autoCleanup = config.autoCleanup ?? true;
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
      exec("git --version", { timeout: 10_000 }, (error) => {
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
        worktreePath,
        "-b", branchName,
        baseRef,
        "--no-track",
      ]);
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

    // Update status before removal
    info.status = "completed";

    // Optional: merge the branch back before removing
    if (options.mergeBack) {
      const mergeTarget = options.mergeTarget ?? info.baseRef;
      this.logger.info(
        "GitWorktree",
        `Merging branch "${info.branchName}" into "${mergeTarget}"…`,
      );

      // First, fetch the latest from the merge target
      try {
        await this.runGit(["checkout", mergeTarget], this.repoPath);
      } catch {
        // If checkout fails (e.g. dirty main repo), try merge directly
        this.logger.warn("GitWorktree", `Could not checkout "${mergeTarget}" — attempting merge anyway.`);
      }

      try {
        await this.runGit(
          ["merge", info.branchName, "--no-edit"],
          this.repoPath,
        );
        this.logger.info("GitWorktree", `Merged "${info.branchName}" → "${mergeTarget}".`);

        // Optional: push
        if (options.pushAfterMerge) {
          await this.runGit(["push", "origin", mergeTarget], this.repoPath);
          this.logger.info("GitWorktree", `Pushed "${mergeTarget}" to origin.`);
        }
      } catch (err: unknown) {
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
      await this.runGit(rmArgs, this.repoPath);
    } catch (err: unknown) {
      if (options.force && err instanceof GitWorktreeError) {
        // Last resort: rm -rf the directory, then prune
        this.logger.warn("GitWorktree", `Force-removing worktree directory: ${info.path}`);
        try {
          fs.rmSync(info.path, { recursive: true, force: true });
          await this.runGit(["worktree", "prune"], this.repoPath);
        } catch {
          // Prune failure is non-fatal
        }
      } else {
        throw err;
      }
    }

    // Delete the branch
    if (options.deleteBranch) {
      try {
        await this.runGit(["branch", "-D", info.branchName], this.repoPath);
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

    const worktreePath = info?.path ?? identifier;
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
          );
          gitStatus = stdout;
          isDirty = stdout.trim().length > 0;

          if (info?.branchName) {
            try {
              await this.runGit(
                ["rev-parse", "--verify", info.branchName],
                this.repoPath,
                5_000,
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
    const active = Array.from(this.worktrees.values()).filter(
      (w) => w.status === "active",
    );

    if (active.length === 0) return;

    this.logger.info("GitWorktree", `Cleaning up ${active.length} active worktree(s)…`);

    for (const wt of active) {
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
    this.worktrees.clear();
    for (const wt of state.worktrees) {
      // Only restore worktrees whose directories still exist on disk
      if (fs.existsSync(wt.path)) {
        this.worktrees.set(wt.id, { ...wt });
      } else {
        this.logger.warn(
          "GitWorktree",
          `Worktree "${wt.id}" at ${wt.path} no longer exists — skipping.`,
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
   * Run a git command via `child_process.exec`.
   *
   * @returns Parsed { stdout, stderr }.
   * @throws GitWorktreeError on any failure.
   */
  private runGit(
    args: string[],
    cwd?: string,
    timeoutMs = 30_000,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const cmd = buildGitCmd(args);
      exec(
        cmd,
        { cwd: cwd ?? this.repoPath, timeout: timeoutMs },
        (error, stdout, stderr) => {
          if (error) {
            reject(classifyGitError(error, args, stderr));
            return;
          }
          resolve({
            stdout: stdout?.trim() ?? "",
            stderr: stderr?.trim() ?? "",
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
        ["rev-parse", "--verify", branchName],
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
   */
  private findWorktree(identifier: string): WorktreeInfo {
    // Try by ID first
    const byId = this.worktrees.get(identifier);
    if (byId) return byId;

    // Try by path
    for (const wt of this.worktrees.values()) {
      if (wt.path === identifier || wt.path === path.resolve(identifier)) {
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
      return `${this.branchPrefix}/${sanitized}-${ts}`;
    }
    const rand = Math.floor(Math.random() * 0x1000)
      .toString(16)
      .padStart(3, "0");
    return `${this.branchPrefix}/task-${ts}-${rand}`;
  }
}
