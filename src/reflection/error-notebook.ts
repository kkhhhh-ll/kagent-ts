import * as fs from "fs";
import * as path from "path";
import {
  wrapUntrusted,
  detectInjectionSignatures,
  buildInjectionWarning,
} from "../security/boundaries";
import { Logger, ConsoleLogger } from "../logging/logger";
import { parseFrontmatter } from "../skills/file-skill-loader";
import type { AgentScenario } from "../intent/signal-detector";

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
  | "code_issue_found"      // pre-existing bug / design flaw discovered in project code
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
  /** The task scenarios in which this error occurred (multi-label from intent detection). */
  scenarios?: AgentScenario[];
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

// ─── Index entry (metadata only, written to README.md) ───────────────────────

interface IndexEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  category: ReflectionErrorCategory;
  description: string;
  scenarios?: AgentScenario[];
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

/**
 * Serialize a frontmatter record into YAML-like text.
 * Only supports simple string values (no nesting, no arrays).
 */
function formatFrontmatter(fm: Record<string, string>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined || value === "") continue;
    // Escape values that contain newlines or leading/trailing whitespace
    if (value.includes("\n") || value !== value.trim()) {
      lines.push(`${key}: |`);
      for (const line of value.split("\n")) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

const CATEGORY_EMOJI: Record<ReflectionErrorCategory, string> = {
  reasoning_error: "🧠",
  tool_misuse: "🔧",
  missed_optimization: "⚡",
  incomplete_answer: "📝",
  hallucination: "💭",
  context_mismanagement: "📋",
  code_issue_found: "🐛",
  other: "❓",
};

const SCENARIO_EMOJI: Record<AgentScenario, string> = {
  "file-search": "🔍",
  "code-read": "📖",
  "code-write": "✏️",
  refactoring: "🔨",
  debugging: "🐛",
  deployment: "🚀",
  testing: "🧪",
  configuration: "⚙️",
};

/**
 * Parse a frontmatter `scenarios` value into a validated array.
 *
 * Handles both legacy single-value (`scenario: "debugging"`) and new
 * comma-separated (`scenarios: "debugging, code-write"`) formats.
 * Invalid scenario strings are silently dropped.
 */
function parseScenarios(raw?: string): AgentScenario[] | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const valid = new Set<AgentScenario>([
    "file-search", "code-read", "code-write", "refactoring",
    "debugging", "deployment", "testing", "configuration",
  ]);
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AgentScenario => valid.has(s as AgentScenario));
  return items.length > 0 ? items : undefined;
}

/**
 * Parse scenario tags from an index-line suffix.
 *
 * Format: `🔍[file-search] 🐛[debugging]` — space-separated
 * `emoji[tag]` pairs. Returns validated scenarios.
 */
function parseScenariosFromSuffix(suffix: string): AgentScenario[] {
  if (!suffix) return [];
  const valid = new Set<AgentScenario>([
    "file-search", "code-read", "code-write", "refactoring",
    "debugging", "deployment", "testing", "configuration",
  ]);
  const re = /\[(\w[-\w]*)\]/g;
  const results: AgentScenario[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(suffix)) !== null) {
    const tag = match[1] as AgentScenario;
    if (valid.has(tag)) results.push(tag);
  }
  return results;
}

// ─── ErrorNotebook ───────────────────────────────────────────────────────────

/**
 * Error Notebook (错题本) — persistent record of mistakes discovered
 * during post-execution reflection.
 *
 * Storage layout (consistent with the memory system):
 * ```
 * .error-notebook/
 *   README.md            ← lightweight index (markdown link list)
 *   entries/
 *     nb_xxx.md          ← full entry, one file per entry (frontmatter + markdown body)
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
    this.indexFile = path.join(this.storageDir, "README.md");
    this.maxEntries = config?.maxEntries ?? 200;
    this.logger = config?.logger ?? new ConsoleLogger();
    this.ensureDirs();
    this.loadIndex();
    this.cleanupOrphans();
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  /**
   * Add an entry to the notebook.
   *
   * Each entry is persisted as a markdown file under `entries/nb_<id>.md`
   * with YAML frontmatter for structured fields and a markdown body for
   * narrative content (cause, suggestion, etc.).
   *
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

    // Write individual entry file as frontmatter + markdown
    const filePath = this.entryPath(full.id);
    const fileContent = this.formatEntryFile(full);
    fs.writeFileSync(filePath, fileContent, "utf-8");

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
      scenarios: full.scenarios,
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
   * Get entries by scenario (intent).
   */
  getByScenario(scenario: AgentScenario): ErrorNotebookEntry[] {
    const matches = this.index.filter(
      (e) => e.scenarios?.includes(scenario),
    );
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

  /**
   * Build a compact prompt section scoped to the given scenarios.
   *
   * Only entries matching ANY of the given scenarios are included.
   * This keeps the prompt lean and contextually relevant — errors from
   * file-search tasks won't clutter a code-write session.
   *
   * @param scenarios  The current task's scenarios (multi-label).
   * @param maxEntries Max entries to include (default 5).
   * @param minRepetitions  Min occurrences before an entry is shown (default 1).
   */
  buildScenarioPrompt(
    scenarios: AgentScenario[],
    maxEntries: number = 5,
    minRepetitions: number = 1,
  ): string {
    // Filter index to entries that match ANY of the given scenarios
    const scenarioSet = new Set(scenarios);
    const scenarioEntries = this.index.filter(
      (e) => e.scenarios?.some((s) => scenarioSet.has(s)),
    );
    if (scenarioEntries.length === 0) return "";

    // Group by (category, description) to count repetitions
    const grouped = new Map<string, { entry: IndexEntry; count: number }>();
    for (const e of scenarioEntries) {
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

    const scenarioLabel = scenarios.map(formatScenarioLabel).join(" + ");
    const lines = [
      `=== Past Mistakes in Similar Tasks (错题回顾: ${scenarioLabel}) ===`,
      "These mistakes were made during previous sessions with the same scenario. Learn from them.",
      "",
    ];

    for (const { entry, count } of filtered) {
      const full = this.loadEntry(entry.id);
      const cat = formatCategory(entry.category);
      const rep = count > 1 ? ` (×${count})` : "";
      lines.push(`**${cat}${rep}**: ${full?.suggestion ?? entry.description}`);
    }

    const body = lines.join("\n");

    const patterns = detectInjectionSignatures(body);
    const warning = buildInjectionWarning(patterns, "error notebook (scenario)");
    const wrapped = wrapUntrusted("error-notebook-scenario", body);

    return "\n\n" + warning + wrapped;
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private entryPath(id: string): string {
    return path.join(this.entriesDir, `${id}.md`);
  }

  private ensureDirs(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    if (!fs.existsSync(this.entriesDir)) {
      fs.mkdirSync(this.entriesDir, { recursive: true });
    }
  }

  // ─── Entry file format (frontmatter + markdown body) ────────────────────

  /**
   * Serialize an entry to a markdown file with YAML frontmatter.
   */
  private formatEntryFile(entry: ErrorNotebookEntry): string {
    // Structured fields go into frontmatter
    const fm: Record<string, string> = {
      id: entry.id,
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      category: entry.category,
      description: entry.description,
    };
    if (entry.scenarios && entry.scenarios.length > 0) {
      fm.scenarios = entry.scenarios.join(", ");
    }
    if (entry.userQuery) {
      fm.userQuery = entry.userQuery;
    }

    // Narrative fields go into the markdown body
    const bodyParts: string[] = [];
    bodyParts.push(`## Cause\n\n${entry.cause}`);
    bodyParts.push(`## Suggestion\n\n${entry.suggestion}`);
    if (entry.finalAnswer) {
      bodyParts.push(`## Final Answer (analyzed)\n\n${entry.finalAnswer}`);
    }
    if (entry.relatedTraceIds && entry.relatedTraceIds.length > 0) {
      bodyParts.push(
        `## Related Traces\n\n${entry.relatedTraceIds.map((t) => `- ${t}`).join("\n")}`,
      );
    }

    return formatFrontmatter(fm) + "\n\n" + bodyParts.join("\n\n");
  }

  /**
   * Parse an entry markdown file back into an ErrorNotebookEntry.
   * Returns null if the file is missing or malformed.
   */
  private loadEntry(id: string): ErrorNotebookEntry | null {
    try {
      const raw = fs.readFileSync(this.entryPath(id), "utf-8");
      return this.parseEntryFile(raw);
    } catch {
      return null;
    }
  }

  /**
   * Parse entry file content (frontmatter + markdown body).
   */
  private parseEntryFile(raw: string): ErrorNotebookEntry | null {
    const { frontmatter, body } = parseFrontmatter(raw);

    const id = frontmatter.id;
    const sessionId = frontmatter.sessionId;
    const timestamp = frontmatter.timestamp;
    const category = frontmatter.category as ReflectionErrorCategory;
    const description = frontmatter.description;
    const scenarioRaw = frontmatter.scenarios || frontmatter.scenario || undefined;
    const userQuery = frontmatter.userQuery || undefined;

    if (!id || !sessionId || !timestamp || !category || !description) {
      return null;
    }

    // Validate category
    const validCategories: ReflectionErrorCategory[] = [
      "reasoning_error", "tool_misuse", "missed_optimization",
      "incomplete_answer", "hallucination", "context_mismanagement",
      "code_issue_found", "other",
    ];
    if (!validCategories.includes(category)) return null;

    // Parse scenarios — supports both legacy single `scenario` and new
    // comma-separated `scenarios` frontmatter field.
    const scenarios = parseScenarios(scenarioRaw);

    // Parse body sections
    const cause = extractSection(body, "Cause");
    const suggestion = extractSection(body, "Suggestion");
    const finalAnswer = extractSection(body, "Final Answer (analyzed)") || undefined;
    const relatedTracesRaw = extractSection(body, "Related Traces");

    if (!cause || !suggestion) return null;

    let relatedTraceIds: string[] | undefined;
    if (relatedTracesRaw) {
      relatedTraceIds = relatedTracesRaw
        .split("\n")
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
      if (relatedTraceIds.length === 0) relatedTraceIds = undefined;
    }

    return {
      id, sessionId, timestamp, category, description,
      scenarios, cause, suggestion, userQuery, finalAnswer, relatedTraceIds,
    };
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

  // ─── Index persistence (markdown link list) ─────────────────────────────

  /**
   * Write the in-memory index to README.md as a markdown link list.
   */
  private persistIndex(): void {
    this.ensureDirs();
    const lines: string[] = [
      "# Error Notebook (错题本)",
      "",
      `*${this.index.length} entries — mistakes discovered during post-execution reflection.*`,
      "",
    ];
    for (const e of this.index) {
      const emoji = CATEGORY_EMOJI[e.category] ?? "❓";
      const label = formatCategoryLabel(e.category);
      const scenarioTag = e.scenarios && e.scenarios.length > 0
        ? ` ${e.scenarios.map((s) => `${SCENARIO_EMOJI[s] ?? ""}[${s}]`).join(" ")}`
        : "";
      const line = `- [${emoji} ${label}] ${e.description} (\`${e.id}\` — ${e.sessionId})${scenarioTag}`;
      lines.push(line);
    }
    fs.writeFileSync(this.indexFile, lines.join("\n") + "\n", "utf-8");
  }

  /**
   * Load the index from README.md.
   */
  private loadIndex(): void {
    try {
      const raw = fs.readFileSync(this.indexFile, "utf-8");
      this.index = this.parseIndex(raw);
    } catch {
      this.index = [];
    }
  }

  /**
   * Parse the README.md index into IndexEntry records.
   *
   * Expected format (one per line):
   * ```
   * - [🔧 Tool Misuse] Used wrong tool. (`nb_xxx` — sess-1) 🔍[file-search] 🐛[debugging]
   * ```
   * Supports both single and multiple scenario tags. The trailing
   * scenario tags are optional.
   */
  private parseIndex(raw: string): IndexEntry[] {
    const entries: IndexEntry[] = [];
    for (const line of raw.split("\n")) {
      // Match: "- [🫀 Category] description (`id` — sessionId)"
      // followed by optional " emoji[scenario]" repeated 0+ times.
      const match = line.match(
        /^- \[(.+?)\] (.+?) \(`(nb_\w+)` — (.+?)\)(.*)$/,
      );
      if (!match) continue;

      const emojiAndLabel = match[1];
      const description = match[2];
      const id = match[3];
      const sessionId = match[4];
      const scenarioSuffix = match[5].trim();

      // Infer category from the emoji+label prefix
      const category = inferCategoryFromLabel(emojiAndLabel);
      if (!category) continue;

      // Parse multiple scenario tags from the suffix
      // Format: "🔍[file-search] 🐛[debugging]" (space-separated)
      const scenarios = parseScenariosFromSuffix(scenarioSuffix);

      // We don't have timestamp in the index line, so we use a placeholder.
      // Timestamp will be loaded from the full entry file when needed.
      entries.push({
        id,
        sessionId,
        timestamp: "", // loaded from entry file on demand
        category,
        description,
        scenarios: scenarios.length > 0 ? scenarios : undefined,
      });
    }
    return entries;
  }

  // ─── Pruning ─────────────────────────────────────────────────────────────

  /**
   * Prune the oldest entries if over maxEntries.
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

    const referenced = new Set(this.index.map((e) => `${e.id}.md`));
    for (const file of entryFiles) {
      if (!file.endsWith(".md")) continue;
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
  const emoji = CATEGORY_EMOJI[cat] ?? "❓";
  const label = formatCategoryLabel(cat);
  return `${emoji} ${label}`;
}

/** Short label used in prompt output and index links. */
function formatCategoryLabel(cat: ReflectionErrorCategory): string {
  switch (cat) {
    case "reasoning_error":       return "Reasoning Error";
    case "tool_misuse":           return "Tool Misuse";
    case "missed_optimization":   return "Missed Optimization";
    case "incomplete_answer":     return "Incomplete Answer";
    case "hallucination":         return "Hallucination";
    case "context_mismanagement": return "Context Mismanagement";
    case "code_issue_found":      return "Code Issue Found";
    case "other":                 return "Other";
  }
}

/** Human-readable label for a scenario. */
function formatScenarioLabel(scenario: AgentScenario): string {
  switch (scenario) {
    case "file-search":    return "File Search";
    case "code-read":      return "Code Reading";
    case "code-write":     return "Code Writing";
    case "refactoring":    return "Refactoring";
    case "debugging":      return "Debugging";
    case "deployment":     return "Deployment";
    case "testing":        return "Testing";
    case "configuration":  return "Configuration";
  }
}

/**
 * Infer the category from a combined emoji+label index token
 * (e.g. "🧠 Reasoning Error" → "reasoning_error").
 */
function inferCategoryFromLabel(emojiAndLabel: string): ReflectionErrorCategory | null {
  const labelPart = emojiAndLabel.replace(/^[^\s]+\s*/, "").trim();
  switch (labelPart) {
    case "Reasoning Error":        return "reasoning_error";
    case "Tool Misuse":            return "tool_misuse";
    case "Missed Optimization":    return "missed_optimization";
    case "Incomplete Answer":      return "incomplete_answer";
    case "Hallucination":          return "hallucination";
    case "Context Mismanagement":  return "context_mismanagement";
    case "Code Issue Found":       return "code_issue_found";
    case "Other":                  return "other";
    default:                       return null;
  }
}

// ─── Body Section Extraction ─────────────────────────────────────────────────

/**
 * Extract a named `## Section` from a markdown body.
 *
 * Matches a level-2 heading, then captures everything up to the next
 * same-or-higher-level heading or EOF.
 */
function extractSection(body: string, heading: string): string | null {
  // Escape heading text for regex, then match ## HEADING followed by content
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const match = body.match(pattern);
  if (!match) return null;
  return match[1].trim();
}
