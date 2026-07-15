import * as fs from "fs";
import * as path from "path";
import {
  wrapUntrusted,
  detectInjectionSignatures,
  buildInjectionWarning,
} from "../security/boundaries";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Memory type. */
export type MemoryType = "rule" | "project" | "preference";

/**
 * A single memory entry.
 *
 * **Rule**: a constraint the user set — why they required it, and when it
 * takes effect. Example: "Always use kebab-case for file names."
 *
 * **Project**: a fact or decision about the project — what happened, why
 * (constraint / deadline that drove it), and how the agent should apply it.
 * Example: "We switched from MySQL to PostgreSQL because of JSONB support."
 *
 * **Preference**: a user habit or style preference the LLM has observed — not
 * a hard constraint, but a pattern the user consistently prefers. Example:
 * "User prefers short, direct answers without boilerplate explanations."
 */
export interface Memory {
  /** Slug (kebab-case, used as filename). */
  name: string;
  /** One-line summary shown in the index. */
  description: string;
  /** Memory type. */
  type: MemoryType;
  /**
   * Markdown body. For rules: why + when. For projects: fact + why + how to
   * apply. For preferences: observed pattern + evidence (what the user said).
   */
  content: string;
  /**
   * ISO-8601 timestamp of the last `recall` access.
   * Used for LRU eviction — memories that haven't been recalled recently
   * are pruned first when the index exceeds limits.
   * Undefined for newly-created or never-recalled memories.
   */
  lastRecalledAt?: string;
}

/** Index entry stored in MEMORY.md (lightweight pointer). */
interface IndexEntry {
  name: string;
  description: string;
  type: MemoryType;
}

// ─── Limits ──────────────────────────────────────────────────────────────────

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25 * 1024; // 25 KB

// ─── MemoryManager ────────────────────────────────────────────────────────────

/**
 * Long-term memory manager (index + individual files).
 *
 * Storage layout:
 * ```
 * .k-memory/
 *   MEMORY.md          ← index (200 lines + 25 KB dual limit)
 *   <name>.md          ← individual memory files with frontmatter
 * ```
 *
 * Usage:
 * ```ts
 * const mem = new MemoryManager({ storageDir: ".k-memory" });
 * mem.add({ name: "use-kebab-case", description: "File naming convention",
 *           type: "rule", content: "...why and when..." });
 * // Later: inject into system prompt
 * const hint = mem.buildPromptHint();
 * ```
 */
export class MemoryManager {
  private index: IndexEntry[] = [];
  private storageDir: string;
  private indexFile: string;
  private lastLoadedMtime: number = 0;

  constructor(storageDir?: string) {
    this.storageDir = path.resolve(storageDir ?? ".k-memory");
    this.indexFile = path.join(this.storageDir, "MEMORY.md");
    // Lazy init: don't create .k-memory/ until something is actually written.
    // loadIndex() is safe — it returns [] when the dir doesn't exist.
    this.loadIndex();
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  /**
   * Add or update a memory entry.
   *
   * If a memory with the same `name` already exists it is overwritten.
   * When the index exceeds the 200-line / 25 KB limit, the oldest entries
   * are silently removed to make room.
   */
  add(memory: Memory): void {
    this.ensureDir();
    // Write individual file
    const filePath = this.memoryPath(memory.name);
    const fileContent = this.formatFile(memory);
    fs.writeFileSync(filePath, fileContent, "utf-8");

    // Update in-memory index (upsert)
    const existing = this.index.findIndex((e) => e.name === memory.name);
    const entry: IndexEntry = {
      name: memory.name,
      description: memory.description,
      type: memory.type,
    };
    if (existing >= 0) {
      this.index[existing] = entry;
    } else {
      this.index.push(entry);
    }

    // Prune oldest if over limits
    this.pruneIfNeeded();
    this.persistIndex();
  }

  /**
   * Remove a memory by name.
   */
  remove(name: string): boolean {
    const idx = this.index.findIndex((e) => e.name === name);
    if (idx === -1) return false;

    try { fs.unlinkSync(this.memoryPath(name)); } catch { /* already gone */ }

    this.index.splice(idx, 1);
    this.persistIndex();
    return true;
  }

  /**
   * Update `lastRecalledAt` to now for a given memory.
   *
   * Called by the `recall` tool whenever memory content is loaded, so the
   * LRU eviction policy can preserve actively-used memories over stale ones.
   *
   * Returns `false` if the memory doesn't exist; `true` if updated.
   */
  touch(name: string): boolean {
    const memory = this.loadFile(name);
    if (!memory) return false;

    this.ensureDir();
    memory.lastRecalledAt = new Date().toISOString();
    const filePath = this.memoryPath(name);
    const fileContent = this.formatFile(memory);
    fs.writeFileSync(filePath, fileContent, "utf-8");
    return true;
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  /**
   * Check if a memory exists by name.
   */
  has(name: string): boolean {
    return this.index.some((e) => e.name === name);
  }

  /**
   * Get a single memory by name (loads full content from disk).
   */
  get(name: string): Memory | null {
    const entry = this.index.find((e) => e.name === name);
    if (!entry) return null;
    return this.loadFile(name);
  }

  /**
   * Get all memories (loads full content from disk).
   */
  getAll(): Memory[] {
    const results: Memory[] = [];
    for (const e of this.index) {
      const m = this.loadFile(e.name);
      if (m) results.push(m);
    }
    return results;
  }

  /**
   * Get memories by type.
   */
  getByType(type: MemoryType): Memory[] {
    return this.getAll().filter((m) => m.type === type);
  }

  /**
   * Total number of memories.
   */
  get count(): number {
    return this.index.length;
  }

  // ─── Prompt Injection ───────────────────────────────────────────────────

  /**
   * Build a compact system-prompt hint listing memory names + type badges.
   *
   * Full content is loaded on demand via the `recall` tool, keeping the
   * system prompt lean. Each line is ~50 chars so the full index of 200
   * entries stays under ~2500 tokens.
   *
   * The content is LLM-generated (via the `remember` tool), so it is
   * wrapped with {@link wrapUntrusted} boundary markers and scanned for
   * prompt-injection signatures before being returned. This prevents
   * the LLM from accidentally poisoning its own system prompt via
   * memory names.
   */
  buildPromptHint(): string {
    if (this.index.length === 0) return "";

    // Group by type with section headers for clarity
    const rules = this.index.filter((e) => e.type === "rule");
    const projects = this.index.filter((e) => e.type === "project");
    const prefs = this.index.filter((e) => e.type === "preference");

    const sections: string[] = [];
    if (rules.length > 0) {
      sections.push("📜 Rules", ...rules.map((e) => `- ${e.name}`));
    }
    if (projects.length > 0) {
      sections.push("📋 Project", ...projects.map((e) => `- ${e.name}`));
    }
    if (prefs.length > 0) {
      sections.push("💬 Preferences (observed habits — soft guidance)", ...prefs.map((e) => `- ${e.name}`));
    }

    const body =
      "## Long-Term Memories (" +
      this.index.length +
      " entries — use the `recall` tool to load full content)\n" +
      sections.join("\n");

    // Scan for prompt-injection signatures in LLM-generated content.
    // Memory names and descriptions are authored by the LLM via the
    // `remember` tool — they could contain injection text that would
    // poison future runs when re-injected into the system prompt.
    const patterns = detectInjectionSignatures(body);
    const warning = buildInjectionWarning(patterns, "memory index");

    // Wrap as untrusted data (LLM-authored, not user-authored)
    const wrapped = wrapUntrusted("memory-index", body);

    return "\n\n" + warning + wrapped;
  }

  /**
   * Re-read the MEMORY.md index from disk if it was modified since the
   * last load. Returns true when a reload occurred.
   *
   * Individual memory files are NOT reloaded — the index is lightweight,
   * and full memory content is fetched on demand via the `recall` tool.
   */
  reloadIfChanged(): boolean {
    try {
      const stat = fs.statSync(this.indexFile);
      if (stat.mtimeMs === this.lastLoadedMtime) return false;
      this.lastLoadedMtime = stat.mtimeMs;
      const raw = fs.readFileSync(this.indexFile, "utf-8");
      this.index = this.parseIndex(raw);
      return true;
    } catch {
      this.lastLoadedMtime = 0;
      this.index = [];
      return true; // file was deleted — prompt needs updating
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private memoryPath(name: string): string {
    return path.join(this.storageDir, `${name}.md`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private formatFile(memory: Memory): string {
    const frontmatter: string[] = [
      "---",
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
    ];
    if (memory.lastRecalledAt) {
      frontmatter.push(`lastRecalledAt: ${memory.lastRecalledAt}`);
    }
    frontmatter.push("---");
    frontmatter.push("");
    frontmatter.push(memory.content);
    return frontmatter.join("\n");
  }

  private loadFile(name: string): Memory | null {
    try {
      const raw = fs.readFileSync(this.memoryPath(name), "utf-8");
      return this.parseFile(raw);
    } catch {
      return null;
    }
  }

  private parseFile(raw: string): Memory | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) frontmatter[kv[1]] = kv[2];
    }

    const name = frontmatter["name"];
    const description = frontmatter["description"];
    const type = frontmatter["type"] as MemoryType;
    const content = match[2];
    const lastRecalledAt = frontmatter["lastRecalledAt"];

    if (!name || !description || !type) return null;
    if (type !== "rule" && type !== "project" && type !== "preference") return null;

    return { name, description, type, content, lastRecalledAt };
  }

  // ─── Index Persistence ──────────────────────────────────────────────────

  private persistIndex(): void {
    this.ensureDir();
    const lines: string[] = [];
    for (const e of this.index) {
      const line = `- [${e.name}](${e.name}.md) — ${e.description}`;
      lines.push(line);
    }
    const content = lines.join("\n") + (lines.length > 0 ? "\n" : "");
    fs.writeFileSync(this.indexFile, content, "utf-8");
  }

  private loadIndex(): void {
    try {
      const stat = fs.statSync(this.indexFile);
      this.lastLoadedMtime = stat.mtimeMs;
      const raw = fs.readFileSync(this.indexFile, "utf-8");
      this.index = this.parseIndex(raw);
    } catch {
      this.lastLoadedMtime = 0;
      this.index = [];
    }
  }

  private parseIndex(raw: string): IndexEntry[] {
    const entries: IndexEntry[] = [];
    const lines = raw.split("\n");
    for (const line of lines) {
      const match = line.match(/^- \[(.+?)\]\((.+?)\.md\) — (.+)$/);
      if (!match) continue;
      const name = match[1];
      const description = match[3];
      // Infer type from the individual file (fallback to "project" if unreadable)
      const type = this.inferType(name);
      entries.push({ name, description, type });
    }
    return entries;
  }

  private inferType(name: string): MemoryType {
    const m = this.loadFile(name);
    return m?.type ?? "project";
  }

  // ─── Limit Enforcement ──────────────────────────────────────────────────

  /**
   * LRU eviction: silently remove entries that haven't been recalled recently
   * (or never) until both the line and byte limits are satisfied.
   *
   * Sorting: `lastRecalledAt` ascending (undefined = oldest, never recalled).
   * Ties are broken by index position (earlier entries removed first).
   */
  private pruneIfNeeded(): void {
    let raw = this.buildIndexContent();
    let lines = raw.split("\n").length;
    let bytes = Buffer.byteLength(raw, "utf-8");

    while (this.index.length > 0 && (lines > MAX_INDEX_LINES || bytes > MAX_INDEX_BYTES)) {
      const toEvict = this.pickEvictionCandidate();
      if (!toEvict) break;

      this.index = this.index.filter((e) => e.name !== toEvict.name);
      try { fs.unlinkSync(this.memoryPath(toEvict.name)); } catch { /* ok */ }

      raw = this.buildIndexContent();
      lines = raw.split("\n").length;
      bytes = Buffer.byteLength(raw, "utf-8");
    }
  }

  /**
   * Pick the best eviction candidate: the entry least recently recalled.
   *
   * Priority (first evicted):
   * 1. Never recalled (`lastRecalledAt` undefined)
   * 2. Oldest `lastRecalledAt`
   * 3. Ties broken by index position (lower = older in insertion order)
   */
  private pickEvictionCandidate(): IndexEntry | null {
    if (this.index.length === 0) return null;

    let worst: { entry: IndexEntry; score: number } | null = null;

    for (let i = 0; i < this.index.length; i++) {
      const entry = this.index[i];
      const memory = this.loadFile(entry.name);
      const recalledAt = memory?.lastRecalledAt;

      let score: number;
      if (!recalledAt) {
        // Never recalled — highest eviction priority (lowest score)
        score = -1;
      } else {
        // Lower score = older = evicted first
        score = new Date(recalledAt).getTime();
      }

      if (!worst || score < worst.score || (score === worst.score && i < this.index.indexOf(worst.entry))) {
        worst = { entry, score };
      }
    }

    return worst?.entry ?? null;
  }

  private buildIndexContent(): string {
    const lines: string[] = [];
    for (const e of this.index) {
      lines.push(`- [${e.name}](${e.name}.md) — ${e.description}`);
    }
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }
}
