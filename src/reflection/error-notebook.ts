import * as fs from "fs";
import * as path from "path";
import {
  wrapUntrusted,
  detectInjectionSignatures,
  buildInjectionWarning,
} from "../security/boundaries";
import { Logger, ConsoleLogger } from "../logging/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Category of an error found during reflection.
 */
export type ReflectionErrorCategory =
  | "reasoning_error"       // flawed logic / incorrect deduction
  | "tool_misuse"           // used wrong tool or wrong parameters
  | "missed_optimization"   // could have been faster / cheaper
  | "incomplete_answer"     // answer missing key information
  | "hallucination"         // fabricated fact or API
  | "context_mismanagement" // lost important context / too much noise
  | "other";

/**
 * A single entry in the error notebook (错题本).
 */
export interface ErrorNotebookEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  category: ReflectionErrorCategory;
  description: string;
  cause: string;
  suggestion: string;
  userQuery?: string;
  /** The agent's final answer that was analyzed to produce this entry. */
  finalAnswer?: string;
  relatedTraceIds?: string[];
}

/**
 * Configuration for the ErrorNotebook.
 */
export interface ErrorNotebookConfig {
  /** Directory where notebook entries are stored. Default: ".error-notebook". */
  storageDir?: string;
  /** Max entries to keep. Default: 200. */
  maxEntries?: number;
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
}

// ─── Index entry (metadata only, written to index.json) ──────────────────────

interface IndexEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  category: ReflectionErrorCategory;
  description: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "nb_";
  for (let i = 0; i < 12; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function nowISO(): string {
  return new Date().toISOString();
}

// ─── ErrorNotebook ───────────────────────────────────────────────────────────

/**
 * Error Notebook (错题本) — persistent record of mistakes discovered
 * during post-execution reflection.
 *
 * Storage layout:
 * ```
 * .error-notebook/
 *   index.json          ← lightweight index (id, sessionId, category, description)
 *   entries/
 *     nb_xxx.json        ← full entry, one file per entry
 * ```
 *
 * The index is always kept in memory and written on every mutation.
 * Individual entry files are loaded lazily (only when querying by session,
 * category, or building the rules prompt).
 */
export class ErrorNotebook {
  private index: IndexEntry[] = [];
  private storageDir: string;
  private entriesDir: string;
  private indexFile: string;
  private maxEntries: number;
  private logger: Logger;

  constructor(config?: ErrorNotebookConfig) {
    this.storageDir = path.resolve(config?.storageDir ?? ".error-notebook");
    this.entriesDir = path.join(this.storageDir, "entries");
    this.indexFile = path.join(this.storageDir, "index.json");
    this.maxEntries = config?.maxEntries ?? 200;
    this.logger = config?.logger ?? new ConsoleLogger();
    this.ensureDirs();
    this.loadIndex();
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  /**
   * Add an entry to the notebook.
   *
   * Each entry is persisted as a JSON file under `entries/nb_<id>.json`.
   * The in-memory index is updated immediately so {@link getAll} and
   * friends reflect the new entry without re-reading from disk.
   */
  add(entry: Omit<ErrorNotebookEntry, "id" | "timestamp">): ErrorNotebookEntry {
    const full: ErrorNotebookEntry = {
      ...entry,
      id: generateId(),
      timestamp: nowISO(),
    };

    // Ensure dirs exist before writing (fire-and-forget reflection may run
    // after the original working directory has been cleaned up)
    this.ensureDirs();

    // Write individual entry file
    const filePath = this.entryPath(full.id);
    fs.writeFileSync(filePath, JSON.stringify(full, null, 2), "utf-8");

    // Log what was recorded so there's a human-readable trail of *why*
    // each entry was created (category + description + triggering query).
    const querySuffix = full.userQuery
      ? ` — query: "${full.userQuery.slice(0, 80)}${full.userQuery.length > 80 ? "…" : ""}"`
      : "";
    this.logger.info(
      "ErrorNotebook",
      `+${full.id} [${full.category}] ${full.description}${querySuffix}`,
    );

    // Update in-memory index
    this.index.push({
      id: full.id,
      sessionId: full.sessionId,
      timestamp: full.timestamp,
      category: full.category,
      description: full.description,
    });

    // Prune oldest if over limit
    this.pruneIfNeeded();

    // Persist index
    this.persistIndex();

    return full;
  }

  /**
   * Add multiple entries at once.
   */
  addMany(entries: Array<Omit<ErrorNotebookEntry, "id" | "timestamp">>): void {
    for (const e of entries) this.add(e);
  }

  /**
   * Remove an entry by ID.
   */
  remove(id: string): boolean {
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx === -1) return false;

    // Remove individual file
    try { fs.unlinkSync(this.entryPath(id)); } catch { /* already gone */ }

    // Remove from index
    this.index.splice(idx, 1);
    this.persistIndex();
    return true;
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  /**
   * Get all entries (loads full data from disk).
   */
  getAll(): ErrorNotebookEntry[] {
    return this.loadFullEntries(this.index);
  }

  /**
   * Get entries for a specific session.
   */
  getBySession(sessionId: string): ErrorNotebookEntry[] {
    const matches = this.index.filter((e) => e.sessionId === sessionId);
    return this.loadFullEntries(matches);
  }

  /**
   * Get recent entries (most recent first).
   */
  getRecent(limit: number = 20): ErrorNotebookEntry[] {
    const recent = [...this.index]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
    return this.loadFullEntries(recent);
  }

  /**
   * Get entries by category.
   */
  getByCategory(category: ReflectionErrorCategory): ErrorNotebookEntry[] {
    const matches = this.index.filter((e) => e.category === category);
    return this.loadFullEntries(matches);
  }

  /**
   * Total number of entries.
   */
  get count(): number {
    return this.index.length;
  }

  /**
   * Category distribution.
   */
  getCategoryStats(): Record<ReflectionErrorCategory, number> {
    const stats: Record<string, number> = {};
    for (const e of this.index) {
      stats[e.category] = (stats[e.category] || 0) + 1;
    }
    return stats as Record<ReflectionErrorCategory, number>;
  }

  // ─── Prompt Injection ───────────────────────────────────────────────────

  /**
   * Build a compact prompt section from recent entries.
   *
   * The content is LLM-generated (via ReflectionAgent), so it is wrapped
   * with {@link wrapUntrusted} boundary markers and scanned for prompt-
   * injection signatures before being returned. This prevents the LLM
   * from accidentally poisoning its own system prompt via the notebook.
   */
  buildRulesPrompt(maxEntries: number = 10, minRepetitions: number = 1): string {
    // Group by (category, description) to count repetitions — uses index only
    const grouped = new Map<string, { entry: IndexEntry; count: number }>();
    for (const e of this.index) {
      const key = `${e.category}::${e.description}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(key, { entry: e, count: 1 });
      }
    }

    const filtered = Array.from(grouped.values())
      .filter((g) => g.count >= minRepetitions)
      .slice(-maxEntries)
      .reverse();

    if (filtered.length === 0) return "";

    const lines = [
      "=== Error Notebook (错题本) ===",
      "These mistakes were discovered during previous sessions. Learn from them.",
      "",
    ];

    for (const { entry, count } of filtered) {
      // Load full entry to get the suggestion
      const full = this.loadEntry(entry.id);
      const cat = formatCategory(entry.category);
      const rep = count > 1 ? ` (×${count})` : "";
      lines.push(`**${cat}${rep}**: ${full?.suggestion ?? entry.description}`);
    }

    const body = lines.join("\n");

    // Scan for prompt-injection signatures in LLM-generated content.
    // The notebook is authored by the LLM itself — it could accidentally
    // (or adversarially) produce injection text that poisons future runs.
    const patterns = detectInjectionSignatures(body);
    const warning = buildInjectionWarning(patterns, "error notebook");

    // Wrap as untrusted data (LLM-authored, not user-authored)
    const wrapped = wrapUntrusted("error-notebook", body);

    return "\n\n" + warning + wrapped;
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private entryPath(id: string): string {
    return path.join(this.entriesDir, `${id}.json`);
  }

  private ensureDirs(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    if (!fs.existsSync(this.entriesDir)) {
      fs.mkdirSync(this.entriesDir, { recursive: true });
    }
  }

  private persistIndex(): void {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2), "utf-8");
  }

  private loadIndex(): void {
    try {
      const raw = fs.readFileSync(this.indexFile, "utf-8");
      this.index = JSON.parse(raw);
    } catch {
      this.index = [];
    }
  }

  /**
   * Load a single full entry from its individual file.
   * Returns null if the file is missing or corrupt.
   */
  private loadEntry(id: string): ErrorNotebookEntry | null {
    try {
      const raw = fs.readFileSync(this.entryPath(id), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Load full entry data for a slice of the index.
   */
  private loadFullEntries(subset: IndexEntry[]): ErrorNotebookEntry[] {
    const results: ErrorNotebookEntry[] = [];
    for (const idx of subset) {
      const full = this.loadEntry(idx.id);
      if (full) results.push(full);
    }
    return results;
  }

  /**
   * Prune the oldest entries if over maxEntries.
   * Also cleans up orphaned individual entry files that aren't referenced
   * by the current index.
   */
  private pruneIfNeeded(): void {
    const excess = this.index.length - this.maxEntries;
    if (excess <= 0) return;

    // Index is append-only, so oldest entries are at the front
    const toRemove = this.index.splice(0, excess);

    for (const { id } of toRemove) {
      try { fs.unlinkSync(this.entryPath(id)); } catch { /* ok */ }
    }
  }

  /**
   * Clean up orphaned entry files (files not referenced by the index).
   * Call this during construction to recover from partial writes.
   */
  private cleanupOrphans(): void {
    let entryFiles: string[];
    try {
      entryFiles = fs.readdirSync(this.entriesDir);
    } catch {
      return;
    }

    const referenced = new Set(this.index.map((e) => `${e.id}.json`));
    for (const file of entryFiles) {
      if (!file.endsWith(".json")) continue;
      if (!referenced.has(file)) {
        try { fs.unlinkSync(path.join(this.entriesDir, file)); } catch { /* ok */ }
      }
    }
  }

  // ─── Markdown Report ─────────────────────────────────────────────────────

  /**
   * Generate a human-readable markdown report.
   */
  generateMarkdownReport(): string {
    const entries = this.getRecent(100);
    if (entries.length === 0) {
      return "# Error Notebook Report\n\n*No errors recorded. Keep up the good work!*\n";
    }

    const stats = this.getCategoryStats();
    let report = `# Error Notebook Report (错题本)\n\n`;
    report += `- **Total entries:** ${this.count}\n`;
    report += `- **Generated:** ${nowISO()}\n\n`;

    report += `## Category Distribution\n\n| Category | Count |\n|----------|------|\n`;
    for (const [cat, count] of Object.entries(stats)) {
      report += `| ${formatCategory(cat as ReflectionErrorCategory)} | ${count} |\n`;
    }

    report += `\n---\n\n## Recent Entries\n\n`;
    for (const e of entries) {
      report += `### ${e.id} — ${formatCategory(e.category)}\n\n`;
      report += `- **Session:** \`${e.sessionId}\`\n`;
      report += `- **Time:** ${e.timestamp}\n`;
      report += `- **Description:** ${e.description}\n`;
      report += `- **Cause:** ${e.cause}\n`;
      report += `- **Suggestion:** ${e.suggestion}\n`;
      if (e.userQuery) report += `- **User Query:** ${e.userQuery}\n`;
      if (e.finalAnswer) {
        report += `- **Final Answer (analyzed):** ${e.finalAnswer.slice(0, 200)}${e.finalAnswer.length > 200 ? "…" : ""}\n`;
      }
      if (e.relatedTraceIds?.length) {
        report += `- **Related Traces:** ${e.relatedTraceIds.join(", ")}\n`;
      }
      report += `\n`;
    }

    return report;
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatCategory(cat: ReflectionErrorCategory): string {
  switch (cat) {
    case "reasoning_error":       return "🧠 Reasoning Error";
    case "tool_misuse":           return "🔧 Tool Misuse";
    case "missed_optimization":   return "⚡ Missed Optimization";
    case "incomplete_answer":     return "📝 Incomplete Answer";
    case "hallucination":         return "💭 Hallucination";
    case "context_mismanagement": return "📋 Context Mismanagement";
    case "other":                 return "❓ Other";
  }
}
