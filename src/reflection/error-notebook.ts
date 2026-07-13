import {
  wrapUntrusted,
  detectInjectionSignatures,
  buildInjectionWarning,
} from "../security/boundaries";
import { Logger, ConsoleLogger } from "../logging/logger";
import { parseFrontmatter } from "../skills/file-skill-loader";
import type { AgentScenario } from "../intent/signal-detector";
import {
  ErrorNotebookStore,
  FileSystemErrorNotebookStore,
} from "./error-notebook-store";

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
  /**
   * Storage backend. When provided, `storageDir` is ignored.
   * Omit to use the default file-system store.
   */
  store?: ErrorNotebookStore;
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
 * Storage layout (default FileSystem store):
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
  private store: ErrorNotebookStore;
  private maxEntries: number;
  private logger: Logger;

  constructor(config?: ErrorNotebookConfig) {
    this.store =
      config?.store ??
      new FileSystemErrorNotebookStore(config?.storageDir ?? ".error-notebook");
    this.maxEntries = config?.maxEntries ?? 200;
    this.logger = config?.logger ?? new ConsoleLogger();
    this.store.ensureDirs();
    this.loadIndex();
    this.cleanupOrphans();
  }

  /**
   * Get the underlying storage backend.
   * Useful for host systems that need direct access (e.g. admin UIs).
   */
  getStore(): ErrorNotebookStore {
    return this.store;
  }

  /**
   * Backward-compatible accessor for the storage directory.
   * @deprecated Use `getStore().getDir()` instead.
   */
  get storageDir(): string {
    return this.store.getDir();
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  /**
   * Add an entry to the notebook.
   */
  add(entry: Omit<ErrorNotebookEntry, "id" | "timestamp">): ErrorNotebookEntry {
    const full: ErrorNotebookEntry = {
      ...entry,
      id: generateId(),
      timestamp: nowISO(),
    };

    // Ensure dirs exist before writing (fire-and-forget reflection may run
    // after the original working directory has been cleaned up)
    this.store.ensureDirs();

    // Write individual entry file as frontmatter + markdown
    const fileContent = this.formatEntryFile(full);
    this.store.writeEntry(full.id, fileContent);

    // Log what was recorded
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

    this.store.deleteEntry(id);

    // Remove from index
    this.index.splice(idx, 1);
    this.persistIndex();
    return true;
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  getAll(): ErrorNotebookEntry[] {
    return this.loadFullEntries(this.index);
  }

  getBySession(sessionId: string): ErrorNotebookEntry[] {
    const matches = this.index.filter((e) => e.sessionId === sessionId);
    return this.loadFullEntries(matches);
  }

  getRecent(limit: number = 20): ErrorNotebookEntry[] {
    const recent = [...this.index]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
    return this.loadFullEntries(recent);
  }

  getByCategory(category: ReflectionErrorCategory): ErrorNotebookEntry[] {
    const matches = this.index.filter((e) => e.category === category);
    return this.loadFullEntries(matches);
  }

  getByScenario(scenario: AgentScenario): ErrorNotebookEntry[] {
    const matches = this.index.filter(
      (e) => e.scenarios?.includes(scenario),
    );
    return this.loadFullEntries(matches);
  }

  get count(): number {
    return this.index.length;
  }

  getCategoryStats(): Record<ReflectionErrorCategory, number> {
    const stats: Record<string, number> = {};
    for (const e of this.index) {
      stats[e.category] = (stats[e.category] || 0) + 1;
    }
    return stats as Record<ReflectionErrorCategory, number>;
  }

  // ─── Prompt Injection ───────────────────────────────────────────────────

  buildRulesPrompt(maxEntries: number = 10, minRepetitions: number = 1): string {
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
      const full = this.loadEntry(entry.id);
      const cat = formatCategory(entry.category);
      const rep = count > 1 ? ` (×${count})` : "";
      lines.push(`**${cat}${rep}**: ${full?.suggestion ?? entry.description}`);
    }

    const body = lines.join("\n");

    const patterns = detectInjectionSignatures(body);
    const warning = buildInjectionWarning(patterns, "error notebook");

    const wrapped = wrapUntrusted("error-notebook", body);

    return "\n\n" + warning + wrapped;
  }

  buildScenarioPrompt(
    scenarios: AgentScenario[],
    maxEntries: number = 5,
    minRepetitions: number = 1,
  ): string {
    const scenarioSet = new Set(scenarios);
    const scenarioEntries = this.index.filter(
      (e) => e.scenarios?.some((s) => scenarioSet.has(s)),
    );
    if (scenarioEntries.length === 0) return "";

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

  // ─── Entry file format (frontmatter + markdown body) ────────────────────

  private formatEntryFile(entry: ErrorNotebookEntry): string {
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

  private loadEntry(id: string): ErrorNotebookEntry | null {
    const raw = this.store.readEntry(id);
    if (!raw) return null;
    return this.parseEntryFile(raw);
  }

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

    const validCategories: ReflectionErrorCategory[] = [
      "reasoning_error", "tool_misuse", "missed_optimization",
      "incomplete_answer", "hallucination", "context_mismanagement",
      "code_issue_found", "other",
    ];
    if (!validCategories.includes(category)) return null;

    const scenarios = parseScenarios(scenarioRaw);

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

  private loadFullEntries(subset: IndexEntry[]): ErrorNotebookEntry[] {
    const results: ErrorNotebookEntry[] = [];
    for (const idx of subset) {
      const full = this.loadEntry(idx.id);
      if (full) results.push(full);
    }
    return results;
  }

  // ─── Index persistence ─────────────────────────────────────────────────

  private persistIndex(): void {
    this.store.ensureDirs();
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
    this.store.writeIndex(lines.join("\n") + "\n");
  }

  private loadIndex(): void {
    try {
      const raw = this.store.readIndex();
      this.index = this.parseIndex(raw);
    } catch {
      this.index = [];
    }
  }

  private parseIndex(raw: string): IndexEntry[] {
    const entries: IndexEntry[] = [];
    for (const line of raw.split("\n")) {
      const match = line.match(
        /^- \[(.+?)\] (.+?) \(`(nb_\w+)` — (.+?)\)(.*)$/,
      );
      if (!match) continue;

      const emojiAndLabel = match[1];
      const description = match[2];
      const id = match[3];
      const sessionId = match[4];
      const scenarioSuffix = match[5].trim();

      const category = inferCategoryFromLabel(emojiAndLabel);
      if (!category) continue;

      const scenarios = parseScenariosFromSuffix(scenarioSuffix);

      entries.push({
        id,
        sessionId,
        timestamp: "",
        category,
        description,
        scenarios: scenarios.length > 0 ? scenarios : undefined,
      });
    }
    return entries;
  }

  // ─── Pruning ─────────────────────────────────────────────────────────────

  private pruneIfNeeded(): void {
    const excess = this.index.length - this.maxEntries;
    if (excess <= 0) return;

    const toRemove = this.index.splice(0, excess);

    for (const { id } of toRemove) {
      this.store.deleteEntry(id);
    }
  }

  private cleanupOrphans(): void {
    const entryIds = this.store.listEntries();
    const referenced = new Set(this.index.map((e) => e.id));
    for (const id of entryIds) {
      if (!referenced.has(id)) {
        this.store.deleteEntry(id);
      }
    }
  }

  // ─── Markdown Report ─────────────────────────────────────────────────────

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

function extractSection(body: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const match = body.match(pattern);
  if (!match) return null;
  return match[1].trim();
}
