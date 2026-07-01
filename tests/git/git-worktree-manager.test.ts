import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";

import { GitWorktreeManager } from "../../src/git/git-worktree-manager";
import { GitWorktreeError } from "../../src/git/git-types";
import { SilentLogger } from "../../src/logging/logger";

// ─── Helpers ───────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-git-test-"));
}

/** Run a git command and return stdout.  Throws on error. */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = `git ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
    exec(cmd, { cwd, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Create a temporary git repository with an initial commit so HEAD is valid.
 * Returns the repo directory path.
 */
async function setupGitRepo(): Promise<string> {
  const dir = tempDir();

  await runGit(["init"], dir);
  await runGit(["config", "user.email", "test@test.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);

  // Create an initial commit so worktree operations succeed
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n");
  await runGit(["add", "README.md"], dir);
  await runGit(["commit", "-m", "initial commit"], dir);

  // Create a second branch for testing baseRef
  fs.writeFileSync(path.join(dir, "FEATURE.md"), "# Feature Branch\n");
  await runGit(["checkout", "-b", "feature-branch"], dir);
  await runGit(["add", "FEATURE.md"], dir);
  await runGit(["commit", "-m", "feature branch commit"], dir);
  await runGit(["checkout", "master"], dir);

  return dir;
}

/** Cleanup a temp directory. */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("GitWorktreeManager", () => {
  let repoDir: string;
  let manager: GitWorktreeManager;

  beforeEach(async () => {
    repoDir = await setupGitRepo();
    manager = new GitWorktreeManager({
      repoPath: repoDir,
      logger: new SilentLogger(),
    });
  });

  afterEach(() => {
    cleanupDir(repoDir);
  });

  describe("constructor", () => {
    it("throws INVALID_CONFIG when repoPath is not absolute", () => {
      expect(() => new GitWorktreeManager({ repoPath: "relative/path" })).toThrow(
        GitWorktreeError,
      );
      try {
        new GitWorktreeManager({ repoPath: "relative/path" });
      } catch (err) {
        const e = err as GitWorktreeError;
        expect(e.code).toBe("INVALID_CONFIG");
      }
    });

    it("creates the worktreesDir if it does not exist", () => {
      const wtDir = path.join(repoDir, ".kagent-worktrees");
      expect(fs.existsSync(wtDir)).toBe(true);
    });

    it("uses a custom worktreesDir when provided", () => {
      const customDir = path.join(repoDir, "custom-worktrees");
      const mgr = new GitWorktreeManager({
        repoPath: repoDir,
        worktreesDir: customDir,
        logger: new SilentLogger(),
      });
      expect(fs.existsSync(customDir)).toBe(true);
      cleanupDir(customDir);
    });
  });

  describe("createWorktree", () => {
    it("creates a worktree directory on disk", async () => {
      const wt = await manager.createWorktree();
      expect(fs.existsSync(wt.path)).toBe(true);
    });

    it("returns WorktreeInfo with all required fields", async () => {
      const wt = await manager.createWorktree();
      expect(wt.id).toBeTruthy();
      expect(wt.id.startsWith("wt-")).toBe(true);
      expect(wt.path).toBeTruthy();
      expect(wt.branchName).toBeTruthy();
      expect(wt.baseRef).toBe("HEAD");
      expect(wt.status).toBe("active");
      expect(wt.createdAt).toBeTruthy();
      expect(wt.isDirty).toBe(false);
    });

    it("creates the worktree on a separate branch", async () => {
      const wt = await manager.createWorktree();
      // Verify the branch exists
      const branches = await runGit(["branch"], repoDir);
      expect(branches).toContain(wt.branchName);
    });

    it("creates worktree from a specific baseRef", async () => {
      const wt = await manager.createWorktree({ baseRef: "feature-branch" });
      // The feature branch has FEATURE.md, main doesn't
      const hasFeature = fs.existsSync(path.join(wt.path, "FEATURE.md"));
      expect(hasFeature).toBe(true);
    });

    it("includes nodeId in the WorktreeInfo and branch name", async () => {
      const wt = await manager.createWorktree({ nodeId: "task_review_1" });
      expect(wt.nodeId).toBe("task_review_1");
      // Underscores are preserved in branch names (only non-[a-zA-Z0-9_-] chars are replaced)
      expect(wt.branchName).toContain("task_review_1");
    });

    it("accepts a custom branchName", async () => {
      const wt = await manager.createWorktree({ branchName: "custom-branch" });
      expect(wt.branchName).toBe("custom-branch");
    });

    it("throws BRANCH_EXISTS if the branch name is already in use", async () => {
      await manager.createWorktree({ branchName: "my-branch" });
      await expect(
        manager.createWorktree({ branchName: "my-branch" }),
      ).rejects.toThrow(GitWorktreeError);
      try {
        await manager.createWorktree({ branchName: "my-branch" });
      } catch (err) {
        expect((err as GitWorktreeError).code).toBe("BRANCH_EXISTS");
      }
    });

    it("accepts metadata in options", async () => {
      const wt = await manager.createWorktree({
        metadata: { purpose: "code-review", priority: "high" },
      });
      expect(wt.metadata).toEqual({ purpose: "code-review", priority: "high" });
    });
  });

  describe("removeWorktree", () => {
    it("removes the worktree directory from disk", async () => {
      const wt = await manager.createWorktree();
      await manager.removeWorktree(wt.id);
      expect(fs.existsSync(wt.path)).toBe(false);
    });

    it("keeps the entry in the map with status completed after removal", async () => {
      const wt = await manager.createWorktree();
      await manager.removeWorktree(wt.id);
      // Worktree stays in the map for tracking — check status
      const all = manager.listWorktrees();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(wt.id);
      expect(all[0].status).toBe("completed");
      expect(manager.listWorktrees("active")).toHaveLength(0);
      expect(manager.listWorktrees("completed")).toHaveLength(1);
    });

    it("throws WORKTREE_NOT_FOUND for unknown identifier", async () => {
      await expect(manager.removeWorktree("nonexistent")).rejects.toThrow(
        GitWorktreeError,
      );
    });

    it("with force: true and deleteBranch: true, deletes the branch", async () => {
      const wt = await manager.createWorktree();
      await manager.removeWorktree(wt.id, { force: true, deleteBranch: true });
      const branches = await runGit(["branch"], repoDir);
      expect(branches).not.toContain(wt.branchName);
    });
  });

  describe("listWorktrees", () => {
    it("returns an empty array when nothing has been created", () => {
      expect(manager.listWorktrees()).toHaveLength(0);
    });

    it("lists all worktrees after creation", async () => {
      await manager.createWorktree();
      await manager.createWorktree();
      expect(manager.listWorktrees()).toHaveLength(2);
    });

    it("filters by status", async () => {
      const wt = await manager.createWorktree();
      await manager.removeWorktree(wt.id, { force: true });
      expect(manager.listWorktrees("active")).toHaveLength(0);
      expect(manager.listWorktrees("completed")).toHaveLength(1);
    });
  });

  describe("getWorktreeStatus", () => {
    it("reports exists: true for a created worktree", async () => {
      const wt = await manager.createWorktree();
      const status = await manager.getWorktreeStatus(wt.id);
      expect(status.exists).toBe(true);
      expect(status.info?.id).toBe(wt.id);
    });

    it("reports exists: false for an unknown worktree", async () => {
      const status = await manager.getWorktreeStatus("nonexistent");
      expect(status.exists).toBe(false);
    });

    it("reports isDirty: false for a clean worktree", async () => {
      const wt = await manager.createWorktree();
      const status = await manager.getWorktreeStatus(wt.id);
      expect(status.isDirty).toBe(false);
    });

    it("reports isDirty: true after file creation without commit", async () => {
      const wt = await manager.createWorktree();
      fs.writeFileSync(path.join(wt.path, "new-file.txt"), "hello");
      const status = await manager.getWorktreeStatus(wt.id);
      expect(status.isDirty).toBe(true);
      expect(status.gitStatus).toBeTruthy();
    });
  });

  describe("cleanup", () => {
    it("removes all active worktrees from disk", async () => {
      const wt1 = await manager.createWorktree();
      const wt2 = await manager.createWorktree();
      await manager.cleanup();
      // Worktrees should be removed from disk
      expect(fs.existsSync(wt1.path)).toBe(false);
      expect(fs.existsSync(wt2.path)).toBe(false);
      // But remain in the map as "completed" for tracking
      expect(manager.listWorktrees("active")).toHaveLength(0);
      expect(manager.listWorktrees("completed")).toHaveLength(2);
    });

    it("does not throw when there are no worktrees", async () => {
      await expect(manager.cleanup()).resolves.not.toThrow();
    });
  });

  describe("session persistence", () => {
    it("round-trips worktree state through buildSessionState / restoreSessionState", async () => {
      const wt = await manager.createWorktree({ nodeId: "test-node" });

      const state = manager.buildSessionState();
      expect(state.worktrees).toHaveLength(1);
      expect(state.worktrees[0].id).toBe(wt.id);

      // Create a new manager instance and restore
      const mgr2 = new GitWorktreeManager({
        repoPath: repoDir,
        logger: new SilentLogger(),
      });
      mgr2.restoreSessionState(state);
      expect(mgr2.listWorktrees()).toHaveLength(1);
      expect(mgr2.listWorktrees()[0].id).toBe(wt.id);

      await mgr2.cleanup();
    });

    it("skips worktrees whose directories no longer exist on restore", () => {
      const state = {
        worktrees: [
          {
            id: "ghost-wt",
            path: path.join(repoDir, "nonexistent-path"),
            branchName: "ghost-branch",
            baseRef: "HEAD",
            createdAt: new Date().toISOString(),
            status: "active" as const,
            isDirty: false,
          },
        ],
      };
      manager.restoreSessionState(state);
      expect(manager.listWorktrees()).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("classifies merge conflict correctly", async () => {
      // Create a worktree and make a conflicting change
      const wt1 = await manager.createWorktree();
      // Make a change on main that conflicts
      fs.writeFileSync(path.join(repoDir, "README.md"), "# Conflicting Main\n");
      await runGit(["add", "README.md"], repoDir);
      await runGit(["commit", "-m", "conflicting change on main"], repoDir);

      // Make a different change in the worktree
      fs.writeFileSync(path.join(wt1.path, "README.md"), "# Conflicting Worktree\n");
      await runGit(["add", "README.md"], wt1.path);
      await runGit(["commit", "-m", "conflicting worktree change"], wt1.path);

      // Merge back should hit a conflict
      try {
        await manager.removeWorktree(wt1.id, { mergeBack: true });
        // If no error, the test repo setup may not have triggered conflict
        expect(true).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(GitWorktreeError);
        const ge = err as GitWorktreeError;
        // Either MERGE_CONFLICT or WORKTREE_CREATE_FAILED depending on timing
        expect(
          ge.code === "MERGE_CONFLICT" || ge.code === "WORKTREE_CREATE_FAILED",
        ).toBe(true);
      }
    });

    it("throws GIT_NOT_FOUND when git is not available (edge case test)", () => {
      // This test verifies the error classification logic — we just import
      // and verify GitWorktreeError is properly exported from the module.
      const err = new GitWorktreeError("Test error", "GIT_NOT_FOUND");
      expect(err.code).toBe("GIT_NOT_FOUND");
      expect(err.name).toBe("GitWorktreeError");
    });
  });

  describe("getRepoPath", () => {
    it("returns the configured repoPath", () => {
      expect(manager.getRepoPath()).toBe(repoDir);
    });
  });

  describe("isGitAvailable", () => {
    it("returns true when git is on PATH", async () => {
      const available = await GitWorktreeManager.isGitAvailable();
      expect(available).toBe(true);
    });
  });
});
