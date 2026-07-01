import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { MemoryManager } from "../../src/memory/memory-manager";
import { createRememberTool, createRecallTool } from "../../src/tools/builtin";

// ============================================================================
// MemoryManager
// ============================================================================

describe("MemoryManager", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kagent-memory-test-"));
    mm = new MemoryManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic CRUD ──────────────────────────────────────────────────────────

  describe("add / get / has / remove", () => {
    it("adds a memory and retrieves it", () => {
      mm.add({
        name: "test-rule",
        description: "A test rule",
        type: "rule",
        content: "Always use tabs.",
      });

      expect(mm.has("test-rule")).toBe(true);
      expect(mm.count).toBe(1);

      const m = mm.get("test-rule");
      expect(m).not.toBeNull();
      expect(m!.name).toBe("test-rule");
      expect(m!.type).toBe("rule");
      expect(m!.content).toBe("Always use tabs.");
    });

    it("upserts by name (overwrites on same name)", () => {
      mm.add({
        name: "convention",
        description: "First version",
        type: "rule",
        content: "Use kebab-case.",
      });

      mm.add({
        name: "convention",
        description: "Updated version",
        type: "rule",
        content: "Use camelCase instead.",
      });

      expect(mm.count).toBe(1);
      const m = mm.get("convention");
      expect(m!.description).toBe("Updated version");
      expect(m!.content).toBe("Use camelCase instead.");
    });

    it("removes a memory", () => {
      mm.add({
        name: "temp-rule",
        description: "Temporary",
        type: "rule",
        content: "...",
      });

      expect(mm.remove("temp-rule")).toBe(true);
      expect(mm.has("temp-rule")).toBe(false);
      expect(mm.count).toBe(0);
    });

    it("returns null for missing memory", () => {
      expect(mm.get("nonexistent")).toBeNull();
    });

    it("adds and retrieves a preference type memory", () => {
      mm.add({
        name: "user-likes-short",
        description: "User prefers short answers",
        type: "preference",
        content: "Observed pattern: user says 'be brief'.\n\nEvidence: ...",
      });

      expect(mm.count).toBe(1);
      const m = mm.get("user-likes-short");
      expect(m!.type).toBe("preference");
      expect(m!.description).toBe("User prefers short answers");
    });

    it("getByType returns only matching type", () => {
      mm.add({ name: "rule-1", description: "R1", type: "rule", content: "r" });
      mm.add({ name: "proj-1", description: "P1", type: "project", content: "p" });
      mm.add({ name: "pref-1", description: "F1", type: "preference", content: "f" });

      expect(mm.getByType("rule").length).toBe(1);
      expect(mm.getByType("project").length).toBe(1);
      expect(mm.getByType("preference").length).toBe(1);
      expect(mm.getByType("rule")[0].name).toBe("rule-1");
      expect(mm.getByType("preference")[0].name).toBe("pref-1");
    });
  });

  // ── lastRecalledAt persistence ──────────────────────────────────────────

  describe("lastRecalledAt", () => {
    it("is undefined for a newly-created memory", () => {
      mm.add({
        name: "fresh",
        description: "Fresh memory",
        type: "project",
        content: "Some fact.",
      });

      const m = mm.get("fresh");
      expect(m!.lastRecalledAt).toBeUndefined();
    });

    it("touch() sets lastRecalledAt", () => {
      mm.add({
        name: "to-touch",
        description: "Will be touched",
        type: "rule",
        content: "...",
      });

      const before = Date.now();
      mm.touch("to-touch");
      const after = Date.now();

      const m = mm.get("to-touch");
      expect(m!.lastRecalledAt).toBeDefined();

      const ts = new Date(m!.lastRecalledAt!).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after + 100); // small tolerance
    });

    it("touch() returns false for nonexistent memory", () => {
      expect(mm.touch("nonexistent")).toBe(false);
    });

    it("touch() returns true for existing memory", () => {
      mm.add({ name: "exist", description: "x", type: "rule", content: "x" });
      expect(mm.touch("exist")).toBe(true);
    });

    it("lastRecalledAt survives reload from disk", () => {
      mm.add({
        name: "persist",
        description: "Persist test",
        type: "rule",
        content: "...",
      });

      mm.touch("persist");
      const expected = mm.get("persist")!.lastRecalledAt;

      // Simulate reload by creating a new MemoryManager reading the same dir
      const mm2 = new MemoryManager(tmpDir);
      const m2 = mm2.get("persist");
      expect(m2!.lastRecalledAt).toBe(expected);
    });

    it("recall tool bumps lastRecalledAt", async () => {
      mm.add({
        name: "recall-touch",
        description: "Test recall touch",
        type: "rule",
        content: "Content here.",
      });

      const recall = createRecallTool(mm);
      await recall.execute({ name: "recall-touch" });

      const m = mm.get("recall-touch");
      expect(m!.lastRecalledAt).toBeDefined();
    });

    it("recall 'all' bumps lastRecalledAt for every memory", async () => {
      mm.add({ name: "a", description: "A", type: "rule", content: "A" });
      mm.add({ name: "b", description: "B", type: "project", content: "B" });

      const recall = createRecallTool(mm);
      await recall.execute({ name: "all" });

      expect(mm.get("a")!.lastRecalledAt).toBeDefined();
      expect(mm.get("b")!.lastRecalledAt).toBeDefined();
    });
  });

  // ── LRU Eviction ────────────────────────────────────────────────────────

  describe("LRU eviction", () => {
    /**
     * Helper: configure a tiny limit so eviction triggers quickly.
     * We set MAX_INDEX_LINES very low by temporarily patching.
     * Alternative: add many memories until the limit bites.
     */
    it("evicts never-recalled memories before recalled ones", () => {
      // Add 2 memories: one recalled, one not
      mm.add({
        name: "recalled",
        description: "This one was recalled",
        type: "rule",
        content: "R",
      });
      mm.add({
        name: "never-recalled",
        description: "Never touched",
        type: "rule",
        content: "N",
      });

      mm.touch("recalled");

      // Manually trigger pruning by adding memories with loooong
      // descriptions until we hit the 200-line or 25KB limit.
      // The 25KB limit is easier to hit reliably.
      const longDesc = "x".repeat(500); // ~500 bytes per entry
      for (let i = 0; i < 100; i++) {
        mm.add({
          name: `bulk-${i}`,
          description: longDesc,
          type: "project",
          content: "B",
        });
        // If the never-recalled one is already gone, stop
        if (!mm.has("never-recalled")) break;
      }

      // "recalled" should survive, "never-recalled" should be evicted first
      const surviving = mm.getAll().map((m) => m.name);
      if (surviving.includes("recalled")) {
        // If recalled survived, never-recalled must be gone
        expect(mm.has("never-recalled")).toBe(false);
      }
      // At minimum, recalled should outlive never-recalled
      // (if both got evicted, that's fine too — but recalled shouldn't
      // be evicted *before* never-recalled)
      if (mm.has("never-recalled")) {
        // If never-recalled somehow survived, recalled must also survive
        expect(mm.has("recalled")).toBe(true);
      }
    });

    it("evicts older lastRecalledAt before newer ones", () => {
      const now = Date.now();

      mm.add({
        name: "older",
        description: "Touched earlier",
        type: "rule",
        content: "O",
      });
      mm.add({
        name: "newer",
        description: "Touched later",
        type: "rule",
        content: "N",
      });

      // Simulate older touch
      mm.touch("older");
      // Manually set older's timestamp back
      const olderFile = path.join(tmpDir, "older.md");
      const olderRaw = fs.readFileSync(olderFile, "utf-8");
      const olderPatched = olderRaw.replace(
        /lastRecalledAt: .+/,
        `lastRecalledAt: ${new Date(now - 3600000).toISOString()}`,
      );
      fs.writeFileSync(olderFile, olderPatched, "utf-8");

      // Touch newer with current time
      mm.touch("newer");

      // Add bulk to trigger eviction
      const longDesc = "x".repeat(500);
      for (let i = 0; i < 100; i++) {
        mm.add({
          name: `bulk-${i}`,
          description: longDesc,
          type: "project",
          content: "B",
        });
        if (!mm.has("older")) break;
      }

      // If older was evicted, newer should survive
      if (mm.has("older")) {
        expect(mm.has("newer")).toBe(true);
      }
    });
  });

  // ── Supersedes (remember tool) ──────────────────────────────────────────

  describe("supersedes via remember tool", () => {
    it("removes superseded memories when writing a new one", async () => {
      mm.add({
        name: "old-rule",
        description: "Old convention",
        type: "rule",
        content: "Use kebab-case.",
      });
      mm.add({
        name: "another-old",
        description: "Another old one",
        type: "rule",
        content: "Use tabs.",
      });

      const remember = createRememberTool(mm);
      const result = await remember.execute({
        name: "new-rule",
        type: "rule",
        description: "New convention",
        content: "Use camelCase.",
        supersedes: ["old-rule", "another-old"],
      });

      expect(mm.has("old-rule")).toBe(false);
      expect(mm.has("another-old")).toBe(false);
      expect(mm.has("new-rule")).toBe(true);
      expect(result).toContain("Superseded:");
      expect(result).toContain("old-rule");
      expect(result).toContain("another-old");
    });

    it("does not remove the new memory itself even if listed in supersedes", async () => {
      const remember = createRememberTool(mm);
      await remember.execute({
        name: "self-ref",
        type: "rule",
        description: "Self reference",
        content: "Content.",
        supersedes: ["self-ref"], // silly but shouldn't break
      });

      expect(mm.has("self-ref")).toBe(true);
    });

    it("supersedes silently ignores nonexistent names", async () => {
      const remember = createRememberTool(mm);
      const result = await remember.execute({
        name: "only-one",
        type: "project",
        description: "Only one",
        content: "Content.",
        supersedes: ["does-not-exist", "also-fake"],
      });

      expect(mm.has("only-one")).toBe(true);
      expect(result).not.toContain("Superseded");
    });

    it("upsert (same name) is a no-op for supersedes", async () => {
      mm.add({
        name: "style",
        description: "Style rule v1",
        type: "rule",
        content: "Use tabs.",
      });

      const remember = createRememberTool(mm);
      await remember.execute({
        name: "style",
        type: "rule",
        description: "Style rule v2",
        content: "Use spaces.",
      });

      expect(mm.count).toBe(1);
      const m = mm.get("style");
      expect(m!.content).toBe("Use spaces.");
    });

    it("saves a preference type memory via remember tool", async () => {
      const remember = createRememberTool(mm);
      await remember.execute({
        name: "user-prefers-pnpm",
        type: "preference",
        description: "User likes pnpm",
        content: "Observed pattern: user mentions pnpm in every setup.\n\nEvidence: ...",
      });

      expect(mm.has("user-prefers-pnpm")).toBe(true);
      const m = mm.get("user-prefers-pnpm");
      expect(m!.type).toBe("preference");
    });
  });

  // ── buildPromptHint() grouping ──────────────────────────────────────────

  describe("buildPromptHint grouping", () => {
    it("groups memories by type with section headers", () => {
      mm.add({ name: "hard-rule", description: "H", type: "rule", content: "h" });
      mm.add({ name: "proj-fact", description: "P", type: "project", content: "p" });
      mm.add({ name: "user-pref", description: "U", type: "preference", content: "u" });

      const hint = mm.buildPromptHint();

      expect(hint).toContain("📜 Rules");
      expect(hint).toContain("hard-rule");
      expect(hint).toContain("📋 Project");
      expect(hint).toContain("proj-fact");
      expect(hint).toContain("💬 Preferences");
      expect(hint).toContain("user-pref");
    });

    it("omits empty groups", () => {
      mm.add({ name: "only-rule", description: "R", type: "rule", content: "r" });

      const hint = mm.buildPromptHint();

      expect(hint).toContain("📜 Rules");
      expect(hint).not.toContain("📋 Project");
      expect(hint).not.toContain("💬 Preferences");
    });
  });

  // ── Recall tool badge ───────────────────────────────────────────────────

  describe("recall tool badges", () => {
    it("uses correct badge for preference type", async () => {
      mm.add({
        name: "pref-test",
        description: "A preference",
        type: "preference",
        content: "Observed: user prefers X.",
      });

      const recall = createRecallTool(mm);
      const result = await recall.execute({ name: "pref-test" });

      expect(result).toContain("💬 Preference");
      expect(result).not.toContain("📜 Rule");
      expect(result).not.toContain("📋 Project");
    });

    it("uses correct badge for rule type", async () => {
      mm.add({
        name: "rule-test",
        description: "A rule",
        type: "rule",
        content: "Always X.",
      });

      const recall = createRecallTool(mm);
      const result = await recall.execute({ name: "rule-test" });

      expect(result).toContain("📜 Rule");
    });
  });
});
