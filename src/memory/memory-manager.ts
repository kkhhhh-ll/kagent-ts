import * as fs from "fs";
import * as path from "path";
import {
  wrapUntrusted,
  detectInjectionSignatures,
  buildInjectionWarning,
} from "../security/boundaries";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Memory type. */
export type MemoryType = "rule" | "project";

/**
 * A single memory entry.
 *
 * **Rule**: a constraint the user set — why they required it, and when it
 * takes effect. Example: "Always use kebab-case for file names."
 *
 * **Project**: a fact or decision about the project — what happened, why
 * (constraint / deadline that drove it), and how the agent should apply it.
 * Example: "We switched from MySQL to PostgreSQL because of JSONB support."
 */
export interface Memory {
  /** Slug (kebab-case, used as filename). */
  name: string;
  /** One-line summary shown in the index. */
  description: string;
  /** Memory type. */
  type: MemoryType;
  /** Markdown body. For rules: why + when. For projects: fact + why + how to apply. */
  content: string;
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
 * .memory/
 *   MEMORY.md          ← index (200 lines + 25 KB dual limit)
 *   <name>.md          ← individual memory files with frontmatter
 * ```
 *
 * Usage:
 * ```ts
 * const mem = new MemoryManager({ storageDir: ".memory" });
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
    this.storageDir = path.resolve(storageDir ?? ".memory");
    this.indexFile = path.join(this.storageDir, "MEMORY.md");
    this.ensureDir();
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

    const names = this.index.map((e) => `- ${e.name} (\`${e.type}\`)`);
    const body =
      "## Long-Term Memories (" +
      this.index.length +
      " entries — use the `recall` tool to load full content)\n" +
      names.join("\n");

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
    return [
      "---",
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      "---",
      "",
      memory.content,
    ].join("\n");
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

    if (!name || !description || !type) return null;
    if (type !== "rule" && type !== "project") return null;

    return { name, description, type, content };
  }

  // ─── Index Persistence ──────────────────────────────────────────────────

  private persistIndex(): void {
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
   * Silently remove the oldest entries until both the line and byte limits
   * are satisfied. Index entries are ordered oldest-first, so we shift from
   * the front until the computed index content fits.
   */
  private pruneIfNeeded(): void {
    let raw = this.buildIndexContent();
    let lines = raw.split("\n").length;
    let bytes = Buffer.byteLength(raw, "utf-8");

    while (this.index.length > 0 && (lines > MAX_INDEX_LINES || bytes > MAX_INDEX_BYTES)) {
      const removed = this.index.pop()!;
      try { fs.unlinkSync(this.memoryPath(removed.name)); } catch { /* ok */ }
      raw = this.buildIndexContent();
      lines = raw.split("\n").length;
      bytes = Buffer.byteLength(raw, "utf-8");
    }
  }

  private buildIndexContent(): string {
    const lines: string[] = [];
    for (const e of this.index) {
      lines.push(`- [${e.name}](${e.name}.md) — ${e.description}`);
    }
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }
}
