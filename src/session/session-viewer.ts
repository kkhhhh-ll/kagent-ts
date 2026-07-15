import * as fs from "fs";
import * as path from "path";
import { SessionManager } from "./session-manager";
import { SessionState } from "./session-types";
import { MessageData, Role, ToolCall } from "../messages/types";
import { Logger, ConsoleLogger } from "../logging/logger";

/**
 * Configuration for the SessionViewer.
 */
export interface SessionViewerConfig {
  /** Directory containing session JSON files (default: `.kagent-sessions/`). */
  sessionDir?: string;
  /**
   * Output path for the generated HTML report.
   * Defaults to `<sessionDir>/sessions.html`.
   */
  outputPath?: string;
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
}

/** Truncate long message bodies in the report (chars). */
const MESSAGE_TRUNCATE = 3000;
/** Truncate the system prompt section (chars). */
const SYSTEM_PROMPT_TRUNCATE = 4000;

/**
 * SessionViewer — renders persisted session checkpoints as a single
 * self-contained HTML report (no external dependencies, same dark theme
 * as the TraceLogger report).
 *
 * The report shows a browsable list of all sessions in the directory —
 * status, agent type, message count, timestamps — and each session
 * expands into its full conversation timeline (messages, tool calls,
 * plan progress).
 *
 * ```ts
 * const viewer = new SessionViewer({ sessionDir: ".kagent-sessions" });
 * const htmlPath = viewer.render(); // → .kagent-sessions/sessions.html
 * ```
 */
export class SessionViewer {
  private sessionDir: string;
  private outputPath: string;
  private logger: Logger;

  constructor(config?: SessionViewerConfig) {
    this.sessionDir = path.resolve(config?.sessionDir ?? ".kagent-sessions");
    this.outputPath = config?.outputPath
      ? path.resolve(config.outputPath)
      : path.join(this.sessionDir, "sessions.html");
    this.logger = config?.logger ?? new ConsoleLogger();
  }

  /**
   * Load all sessions, generate the HTML report, and write it to disk.
   *
   * @returns The absolute path to the generated HTML file ("" on failure).
   */
  render(): string {
    try {
      const html = this.generateHTML();
      fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
      fs.writeFileSync(this.outputPath, html, "utf-8");
      this.logger.info("Session", `Saved session report → ${this.outputPath}`);
      return this.outputPath;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Session", `Failed to write session report: ${message}`);
      return "";
    }
  }

  /**
   * Generate the report HTML string (pure — does not touch disk except
   * for reading the session files).
   */
  generateHTML(): string {
    const sessions = new SessionManager({ sessionDir: this.sessionDir }).listSessions();

    const counts: Record<string, number> = {};
    for (const s of sessions) counts[s.status] = (counts[s.status] ?? 0) + 1;
    const countsStr = Object.entries(counts)
      .map(([k, v]) => `<span class="stat"><span class="dot status-${k}"></span>${k}: <span class="val">${v}</span></span>`)
      .join("");

    const cards = sessions.length > 0
      ? sessions.map((s, i) => this.renderSessionCard(s, i)).join("\n")
      : `<div class="empty">No sessions found in ${this.escapeHtml(this.sessionDir)}</div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sessions — ${this.escapeHtml(this.sessionDir)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117; color: #c9d1d9; line-height: 1.6; padding: 24px;
  }
  .container { max-width: 960px; margin: 0 auto; }

  .header {
    background: linear-gradient(135deg, #161b22, #1c2333);
    border: 1px solid #30363d; border-radius: 12px; padding: 24px 28px;
    margin-bottom: 20px;
  }
  .header h1 { font-size: 20px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; }
  .header h1 span { background: #1f6feb; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 20px; }
  .header .meta { font-size: 13px; color: #8b949e; }

  .summary {
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 14px 20px; margin-bottom: 24px;
    display: flex; flex-wrap: wrap; gap: 20px; font-size: 13px;
  }
  .summary .stat { display: flex; align-items: center; gap: 6px; }
  .summary .val { color: #e6edf3; font-weight: 600; font-family: monospace; }

  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .status-completed { background: #238636; }
  .status-interrupted { background: #da3633; }
  .status-active { background: #1f6feb; }
  .status-cancelled { background: #6e7681; }

  .empty { color: #8b949e; text-align: center; padding: 40px; }

  /* ── Session card ── */
  .session {
    border: 1px solid #30363d; border-radius: 10px; background: #161b22;
    margin-bottom: 14px; overflow: hidden;
  }
  .session-header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; cursor: pointer; user-select: none;
    background: #1c2333; border-bottom: 1px solid transparent;
  }
  .session-header:hover { background: #21262d; }
  .session.open .session-header { border-bottom-color: #30363d; }
  .session-header .sid { font-weight: 600; color: #79c0ff; font-family: monospace; font-size: 13px; }
  .session-header .badge {
    font-size: 11px; padding: 1px 8px; border-radius: 10px;
    background: #1a2332; color: #8b949e; font-family: monospace; white-space: nowrap;
  }
  .session-header .time { margin-left: auto; color: #8b949e; font-size: 12px; font-family: monospace; }
  .session-header .toggle { color: #8b949e; font-size: 12px; transition: transform .15s; }
  .session.open .toggle { transform: rotate(90deg); }
  .session-body { display: none; padding: 14px 16px; }
  .session.open .session-body { display: block; }
  .session .preview { color: #8b949e; font-size: 12px; padding: 0 16px 10px; }
  .session.open .preview { display: none; }

  /* ── Sections inside a session ── */
  .section { margin-bottom: 14px; }
  .section h4 {
    font-size: 11px; text-transform: uppercase; color: #8b949e;
    margin-bottom: 6px; letter-spacing: .5px;
  }
  pre {
    background: #0d1117; border: 1px solid #21262d; border-radius: 6px;
    padding: 10px 12px; font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
    color: #e6edf3; max-height: 360px; overflow-y: auto;
  }
  ol.plan-steps { padding-left: 20px; margin: 4px 0; font-size: 13px; }
  ol.plan-steps li { margin-bottom: 2px; color: #e6edf3; }
  ol.plan-steps li.done { color: #3fb950; }
  details summary { cursor: pointer; color: #8b949e; font-size: 12px; margin-bottom: 6px; }

  /* ── Message timeline ── */
  .msg { border: 1px solid #21262d; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
  .msg-head {
    display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    font-size: 11px; font-weight: 600; letter-spacing: .5px;
    background: #0d1117; border-bottom: 1px solid #21262d;
  }
  .msg-body { padding: 8px 12px; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  .msg-user .msg-head { color: #79c0ff; }
  .msg-assistant .msg-head { color: #d2a8ff; }
  .msg-tool .msg-head { color: #d29922; }
  .msg-system .msg-head { color: #8b949e; }
  .toolcall {
    background: #1a2332; border-radius: 6px; padding: 6px 10px; margin-top: 6px;
    font-family: monospace; font-size: 12px; color: #79c0ff;
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>💾 <span>SESSIONS</span> Session Browser</h1>
    <div class="meta">${this.escapeHtml(this.sessionDir)} · ${sessions.length} session(s) · generated ${new Date().toLocaleString("zh-CN", { hour12: false })}</div>
  </div>
  <div class="summary">${countsStr || '<span class="stat">—</span>'}</div>
${cards}
</div>
<script>
  document.querySelectorAll('.session-header').forEach(el => {
    el.addEventListener('click', () => el.parentElement.classList.toggle('open'));
  });
</script>
</body>
</html>`;
  }

  // ─── Rendering helpers ───────────────────────────────────────────────

  private renderSessionCard(s: SessionState, index: number): string {
    const firstUser = s.messages.find((m) => m.role === Role.User);
    const preview = firstUser
      ? this.escapeHtml(this.truncate(firstUser.content, 160))
      : "(no user message)";

    const planHtml = this.renderPlanState(s);
    const orchestratorHtml = s.orchestratorState
      ? `<div class="section"><h4>Orchestrator State</h4><pre>${this.escapeHtml(this.truncate(JSON.stringify(s.orchestratorState, null, 2), MESSAGE_TRUNCATE))}</pre></div>`
      : "";
    const systemPromptHtml = s.systemPrompt
      ? `<div class="section"><details><summary>System Prompt (${s.systemPrompt.length} chars)</summary><pre>${this.escapeHtml(this.truncate(s.systemPrompt, SYSTEM_PROMPT_TRUNCATE))}</pre></details></div>`
      : "";

    const messages = s.messages.map((m) => this.renderMessage(m)).join("\n");

    return `  <div class="session" id="session-${index}">
    <div class="session-header">
      <span class="dot status-${this.escapeHtml(s.status)}"></span>
      <span class="sid">${this.escapeHtml(s.sessionId)}</span>
      <span class="badge">${this.escapeHtml(s.agentType)}</span>
      <span class="badge">${s.messages.length} msgs</span>
      <span class="badge">${this.escapeHtml(s.status)}</span>
      <span class="time">${this.fmtTime(s.updatedAt)}</span>
      <span class="toggle">▶</span>
    </div>
    <div class="preview">${preview}</div>
    <div class="session-body">
      <div class="section">
        <h4>Created ${this.fmtTime(s.createdAt)} · Updated ${this.fmtTime(s.updatedAt)}</h4>
      </div>
${planHtml}${orchestratorHtml}${systemPromptHtml}      <div class="section">
        <h4>Conversation (${s.messages.length})</h4>
${messages}
      </div>
    </div>
  </div>`;
  }

  /** Render Plan-Solve / Fusion plan progress, if present. */
  private renderPlanState(s: SessionState): string {
    const plan = s.planState ?? s.fusionState;
    if (!plan || !plan.hasPlan || plan.currentPlan.length === 0) {
      // Fusion sessions without a plan still carry routing info worth showing
      if (s.fusionState?.routed) {
        return `<div class="section"><h4>Routing</h4><pre>complexity: ${this.escapeHtml(s.fusionState.complexity)}${s.fusionState.routeReason ? ` — ${this.escapeHtml(s.fusionState.routeReason)}` : ""}</pre></div>`;
      }
      return "";
    }
    const steps = plan.currentPlan
      .map((step, i) => `<li${i < plan.completedSteps ? ' class="done"' : ""}>${this.escapeHtml(step)}${i < plan.completedSteps ? " ✓" : ""}</li>`)
      .join("");
    const routing = s.fusionState?.routed
      ? ` · complexity: ${this.escapeHtml(s.fusionState.complexity)}`
      : "";
    return `<div class="section"><h4>Plan (${plan.completedSteps}/${plan.currentPlan.length} steps${routing})</h4><ol class="plan-steps">${steps}</ol></div>`;
  }

  private renderMessage(m: MessageData): string {
    const role = String(m.role);
    const label = m.name ? `${role.toUpperCase()} · ${this.escapeHtml(m.name)}` : role.toUpperCase();
    const time = m.timestamp
      ? `<span style="margin-left:auto;color:#8b949e;font-weight:400">${new Date(m.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>`
      : "";
    const body = m.content
      ? this.escapeHtml(this.truncate(m.content, MESSAGE_TRUNCATE))
      : "";
    const toolCalls = (m.tool_calls ?? [])
      .map((tc) => this.renderToolCall(tc))
      .join("");
    return `        <div class="msg msg-${this.escapeHtml(role)}">
          <div class="msg-head">${label}${time}</div>
          ${body || toolCalls ? `<div class="msg-body">${body}${toolCalls}</div>` : ""}
        </div>`;
  }

  private renderToolCall(tc: ToolCall): string {
    let args = tc.function.arguments;
    try {
      args = JSON.stringify(JSON.parse(args));
    } catch {
      // keep raw string when arguments are not valid JSON
    }
    return `<div class="toolcall">🔧 ${this.escapeHtml(tc.function.name)}(${this.escapeHtml(this.truncate(args, 400))})</div>`;
  }

  // ─── Utils ───────────────────────────────────────────────────────────

  private truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + `\n... (truncated, ${text.length} chars total)` : text;
  }

  private fmtTime(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
