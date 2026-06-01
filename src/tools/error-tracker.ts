/**
 * ToolErrorTracker — records the complete lifecycle of tool failures
 * and persists them as structured documents for developer review.
 *
 * Each "trace" captures one error chain: first failure → retries →
 * LLM analysis → resolution or circuit-open. Traces are stored as
 * individual JSON files in a designated directory (.error-traces/)
 * so developers can inspect, aggregate, and learn from them.
 */
import * as fs from "fs";
import * as path from "path";
import {
  ToolErrorTrace,
  TraceEvent,
  ErrorTraceSummary,
} from "./types";

/**
 * Configuration for the ToolErrorTracker.
 */
export interface ErrorTrackerConfig {
  /**
   * Directory where trace files are stored.
   * Defaults to `.error-traces` relative to the working directory.
   */
  storageDir?: string;

  /**
   * Whether to persist traces to disk immediately.
   * Defaults to true.
   */
  persistImmediately?: boolean;
}

/**
 * Generates a short unique trace ID.
 */
function generateTraceId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "trace_";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * Generates a timestamp string in ISO-8601 format.
 */
function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Sanitize arguments for storage — removes sensitive values
 * (e.g., API keys, passwords) while preserving structure.
 */
function sanitizeArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  const sensitiveKeys = [
    "apiKey", "api_key", "apikey",
    "password", "passwd", "secret", "token",
    "authorization", "auth",
  ];
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
      sanitized[key] = "***REDACTED***";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Limit error message length to avoid huge trace files.
 */
function truncateError(error: string, maxLen = 500): string {
  if (error.length <= maxLen) return error;
  return error.slice(0, maxLen) + "... (truncated)";
}

/**
 * Categorize a tool error based on its message content.
 * Helps developers quickly identify common failure patterns.
 */
export function categorizeError(error: string): string {
  const lower = error.toLowerCase();

  if (lower.includes("enoent") || lower.includes("not found") || lower.includes("no such file")) {
    return "file_not_found";
  }
  if (lower.includes("eaccess") || lower.includes("permission denied") || lower.includes("eperm")) {
    return "permission_denied";
  }
  if (lower.includes("eisdir")) {
    return "is_directory";
  }
  if (lower.includes("eexist")) {
    return "file_exists";
  }
  if (lower.includes("syntax") || lower.includes("parse error") || lower.includes("parse")) {
    return "parse_error";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("econnrefused") || lower.includes("econnreset")) {
    return "network_error";
  }
  if (lower.includes("invalid") || lower.includes("bad argument") || lower.includes("wrong type")) {
    return "invalid_arguments";
  }
  if (lower.includes("not empty") || lower.includes("directory not empty") || lower.includes("enotempty")) {
    return "directory_not_empty";
  }

  return "unknown";
}

/**
 * ToolErrorTracker records the complete lifecycle of tool failures.
 *
 * Usage:
 * ```ts
 * const tracker = new ToolErrorTracker({ storageDir: ".error-traces" });
 * const registry = new ToolRegistry({ errorTracker: tracker });
 * ```
 *
 * Lifecycle of a trace:
 * 1. First failure  → `recordFailure()` creates a new trace
 * 2. LLM analysis   → `recordAnalysis()` attaches the LLM's reasoning
 * 3. Retry failure  → `recordFailure()` appends to the existing trace
 * 4. Recovery       → `recordRecovery()` marks the trace as resolved
 * 5. Circuit open   → `recordFailure()` marks the trace as unresolved
 *
 * All traces are persisted as individual JSON files in the storage
 * directory, plus an index file for quick browsing.
 */
export class ToolErrorTracker {
  private traces: Map<string, ToolErrorTrace> = new Map();
  private activeTraceByTool: Map<string, string> = new Map();
  private storageDir: string;
  private persistImmediately: boolean;
  private sessionId?: string;

  constructor(config?: ErrorTrackerConfig) {
    this.storageDir = config?.storageDir ?? ".error-traces";
    this.persistImmediately = config?.persistImmediately ?? true;
  }

  /**
   * Set a session identifier that will be attached to all traces.
   */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  // ─── Event Recording ────────────────────────────────────────────────────

  /**
   * Record a tool execution failure.
   *
   * - If this is the first failure for the tool in the current chain,
   *   a new trace is created.
   * - If a trace for this tool already exists and is still open,
   *   the failure is appended as a retry event.
   *
   * @returns The trace ID for the chain this failure belongs to.
   */
  recordFailure(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
    retriesRemaining: number
  ): string {
    const existingTraceId = this.activeTraceByTool.get(toolName);
    let trace: ToolErrorTrace;

    if (existingTraceId) {
      // Append to existing trace
      const existing = this.traces.get(existingTraceId);
      if (existing && !existing.resolved) {
        trace = existing;
      } else {
        // Existing trace is resolved/closed — start a new one
        trace = this.createTrace(toolName, args);
      }
    } else {
      trace = this.createTrace(toolName, args);
    }

    const attemptNumber = trace.events.filter(
      (e) => e.type === "failure" || e.type === "retry"
    ).length + 1;

    const event: TraceEvent = {
      type: retriesRemaining > 0 ? "failure" : "circuit_open",
      timestamp: nowISO(),
      error: truncateError(error),
      attemptNumber,
      retriesRemaining,
      arguments: sanitizeArgs(args),
    };

    trace.events.push(event);
    trace.updatedAt = nowISO();

    if (retriesRemaining === 0) {
      // Circuit just opened — trace is done, unresolved
      trace.resolved = false;
      this.activeTraceByTool.delete(toolName);
    }

    this.traces.set(trace.traceId, trace);
    this.persistTrace(trace.traceId);

    return trace.traceId;
  }

  /**
   * Record a tool recovery (successful execution after previous failures).
   *
   * @param toolName The tool that recovered.
   * @param traceId  The trace ID for this failure chain.
   * @param resolution Optional description of how it was resolved.
   */
  recordRecovery(
    toolName: string,
    traceId: string,
    resolution?: string
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const event: TraceEvent = {
      type: "recovery",
      timestamp: nowISO(),
      resolution:
        resolution ??
        `Tool "${toolName}" succeeded on retry.`,
    };

    trace.events.push(event);
    trace.resolved = true;
    trace.resolution = event.resolution;
    trace.updatedAt = nowISO();
    this.traces.set(traceId, trace);
    this.activeTraceByTool.delete(toolName);

    this.persistTrace(traceId);
  }

  /**
   * Attach LLM analysis to the latest failure/retry event in a trace.
   *
   * Called by the agent after the LLM has reasoned about a tool error.
   */
  recordAnalysis(traceId: string, analysis: string): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    // Attach to the most recent failure/retry event
    for (let i = trace.events.length - 1; i >= 0; i--) {
      const event = trace.events[i];
      if (event.type === "failure" || event.type === "retry") {
        event.analysis = analysis;
        break;
      }
    }

    // Also add as a standalone analysis event for clarity
    const analysisEvent: TraceEvent = {
      type: "analysis",
      timestamp: nowISO(),
      analysis,
    };
    trace.events.push(analysisEvent);
    trace.updatedAt = nowISO();

    this.traces.set(traceId, trace);
    this.persistTrace(traceId);
  }

  // ─── Query ───────────────────────────────────────────────────────────────

  /**
   * Get a full trace by ID.
   */
  getTrace(traceId: string): ToolErrorTrace | undefined {
    return this.traces.get(traceId);
  }

  /**
   * Get all trace summaries — lightweight list for browsing.
   */
  getAllSummaries(): ErrorTraceSummary[] {
    const summaries: ErrorTraceSummary[] = [];
    for (const trace of this.traces.values()) {
      const failureEvents = trace.events.filter(
        (e) => e.type === "failure" || e.type === "retry"
      );
      summaries.push({
        traceId: trace.traceId,
        toolName: trace.toolName,
        createdAt: trace.createdAt,
        resolved: trace.resolved,
        errorCount: failureEvents.length,
        firstError:
          failureEvents.length > 0
            ? failureEvents[0].error?.slice(0, 120) ?? ""
            : "",
        resolution: trace.resolution,
      });
    }
    return summaries.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Get the active (open, unresolved) trace ID for a tool, if any.
   */
  getActiveTraceId(toolName: string): string | undefined {
    return this.activeTraceByTool.get(toolName);
  }

  /**
   * Get the total number of traces recorded.
   */
  get traceCount(): number {
    return this.traces.size;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Persist all traces to disk immediately.
   */
  persistAll(): void {
    this.ensureStorageDir();
    for (const traceId of this.traces.keys()) {
      this.writeTraceFile(traceId);
    }
    this.writeIndexFile();
  }

  /**
   * Load traces from disk (e.g., on startup to resume monitoring).
   */
  loadFromDisk(): void {
    this.ensureStorageDir();
    const dir = this.storageDir;

    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.startsWith("trace_") || !file.endsWith(".json")) continue;
      if (file === "traces.json") continue; // skip index

      try {
        const content = fs.readFileSync(path.join(dir, file), "utf-8");
        const trace: ToolErrorTrace = JSON.parse(content);
        this.traces.set(trace.traceId, trace);

        if (!trace.resolved) {
          this.activeTraceByTool.set(trace.toolName, trace.traceId);
        }
      } catch {
        // Skip corrupted files
      }
    }
  }

  /**
   * Generate a human-readable markdown report of all traces.
   */
  generateMarkdownReport(): string {
    const summaries = this.getAllSummaries();
    if (summaries.length === 0) {
      return "# Tool Error Trace Report\n\n*No errors recorded.*\n";
    }

    const resolved = summaries.filter((s) => s.resolved).length;
    const open = summaries.length - resolved;

    let report = `# Tool Error Trace Report\n\n`;
    report += `- **Total traces:** ${summaries.length}\n`;
    report += `- **Resolved:** ${resolved}\n`;
    report += `- **Open:** ${open}\n`;
    report += `- **Generated:** ${nowISO()}\n\n`;

    report += `---\n\n`;

    for (const summary of summaries) {
      const trace = this.traces.get(summary.traceId);
      if (!trace) continue;

      report += `## Trace: ${summary.traceId}\n\n`;
      report += `- **Tool:** \`${summary.toolName}\`\n`;
      report += `- **Created:** ${summary.createdAt}\n`;
      report += `- **Status:** ${summary.resolved ? "✅ Resolved" : "❌ Unresolved"}\n`;
      report += `- **Attempts:** ${summary.errorCount}\n\n`;

      // Events table
      report += `| # | Type | Timestamp | Error / Analysis |\n`;
      report += `|---|------|-----------|------------------|\n`;

      let eventNum = 0;
      for (const event of trace.events) {
        eventNum++;
        const type = this.formatEventType(event.type);
        const ts = new Date(event.timestamp).toLocaleTimeString();
        let detail = "";

        if (event.type === "failure" || event.type === "retry") {
          detail = `\`${event.error?.slice(0, 200) ?? ""}\``;
          if (event.analysis) {
            detail += `<br/>*Analysis:* ${event.analysis.slice(0, 300)}`;
          }
        } else if (event.type === "recovery") {
          detail = event.resolution ?? "Recovered";
        } else if (event.type === "circuit_open") {
          detail = `Circuit opened after ${event.attemptNumber} attempts`;
        } else if (event.type === "analysis") {
          detail = `*${event.analysis?.slice(0, 300) ?? ""}*`;
        }

        report += `| ${eventNum} | ${type} | ${ts} | ${detail} |\n`;
      }

      report += `\n---\n\n`;
    }

    return report;
  }

  /**
   * Delete all stored traces.
   */
  clearAll(): void {
    this.traces.clear();
    this.activeTraceByTool.clear();
    const dir = this.storageDir;
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch {
            // ignore
          }
        }
      }
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private createTrace(
    toolName: string,
    args: Record<string, unknown>
  ): ToolErrorTrace {
    const traceId = generateTraceId();
    const now = nowISO();
    const trace: ToolErrorTrace = {
      traceId,
      toolName,
      sessionId: this.sessionId,
      createdAt: now,
      updatedAt: now,
      resolved: false,
      originalArguments: sanitizeArgs(args),
      events: [],
    };
    this.traces.set(traceId, trace);
    this.activeTraceByTool.set(toolName, traceId);
    return trace;
  }

  private persistTrace(traceId: string): void {
    if (!this.persistImmediately) return;
    this.ensureStorageDir();
    this.writeTraceFile(traceId);
    this.writeIndexFile();
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private writeTraceFile(traceId: string): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    const filePath = path.join(this.storageDir, `${traceId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(trace, null, 2), "utf-8");
  }

  private writeIndexFile(): void {
    const summaries = this.getAllSummaries();
    const filePath = path.join(this.storageDir, "traces.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          totalTraces: summaries.length,
          resolvedCount: summaries.filter((s) => s.resolved).length,
          openCount: summaries.filter((s) => !s.resolved).length,
          updatedAt: nowISO(),
          sessionId: this.sessionId,
          traces: summaries,
        },
        null,
        2
      ),
      "utf-8"
    );
  }

  private formatEventType(
    type: TraceEvent["type"]
  ): string {
    switch (type) {
      case "failure":
        return "🔴 Failure";
      case "retry":
        return "🟡 Retry";
      case "recovery":
        return "🟢 Recovery";
      case "circuit_open":
        return "⛔ Circuit Open";
      case "analysis":
        return "💡 Analysis";
      default:
        return type;
    }
  }
}
