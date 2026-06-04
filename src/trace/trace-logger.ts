import * as fs from "fs";
import * as path from "path";
import { AgentHooks } from "../core/hooks";
import { LLMResponse } from "../llm/interface";
import { LLMNetworkError } from "../llm/openai-provider";
import { MessageData } from "../messages/types";
import { Tool } from "../tools/types";
import { AgentTraceEvent, AgentTraceEventType } from "./types";

/**
 * Configuration for the TraceLogger.
 */
export interface TraceLoggerConfig {
  /**
   * Session identifier used in the trace file name.
   * Defaults to `trace-<timestamp>-<random>`.
   */
  sessionId?: string;

  /**
   * Output directory for trace HTML files.
   * Defaults to `.kagent-traces/`.
   */
  outputDir?: string;

  /**
   * Optional agent label shown in the trace report header.
   */
  agentLabel?: string;

  /**
   * Optional model name shown in the trace report header.
   */
  modelName?: string;
}

/**
 * TraceLogger — records the agent's execution trajectory and generates
 * a self-contained HTML report per session.
 *
 * Implements AgentHooks so it can be plugged directly into an Agent:
 *
 * ```ts
 * const traceLogger = new TraceLogger({ sessionId: "my-session" });
 * const agent = new ReActAgent({
 *   llm: provider,
 *   hooks: traceLogger,  // <-- hooks in as the observer
 * });
 * const answer = await agent.run("...");
 * traceLogger.flush(); // writes .kagent-traces/my-session.html
 * ```
 *
 * The HTML report is a standalone file with no external dependencies —
 * all CSS and JS are inlined. It shows a vertical timeline of all events
 * (LLM calls, tool executions, thoughts, errors) with expandable details
 * for each.
 */
export class TraceLogger implements AgentHooks {
  private events: AgentTraceEvent[] = [];
  private eventId = 0;
  private sessionId: string;
  private outputDir: string;
  private agentLabel: string;
  private modelName: string;
  private startTime: number;

  constructor(config?: TraceLoggerConfig) {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    this.sessionId =
      config?.sessionId ?? `trace-${ts}-${rand}`;
    this.outputDir = path.resolve(config?.outputDir ?? ".kagent-traces");
    this.agentLabel = config?.agentLabel ?? "Agent";
    this.modelName = config?.modelName ?? "unknown";
    this.startTime = ts;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Get the session identifier for this trace.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get all recorded events.
   */
  getEvents(): AgentTraceEvent[] {
    return [...this.events];
  }

  /**
   * Flush the trace to an HTML file on disk.
   * Creates the output directory if it doesn't exist.
   *
   * @returns The absolute path to the generated HTML file.
   */
  flush(): string {
    const html = this.generateHTML();
    fs.mkdirSync(this.outputDir, { recursive: true });
    const filePath = path.join(this.outputDir, `${this.sessionId}.html`);
    fs.writeFileSync(filePath, html, "utf-8");
    console.log(`[Trace] Saved session trace → ${filePath}`);
    return filePath;
  }

  // ─── AgentHooks Implementation ─────────────────────────────────────────

  onLLMStart(messages: MessageData[], tools: Tool[]): void {
    this.addEvent("llm_start", "LLM Call", {
      messageCount: messages.length,
      toolCount: tools.length,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
        tool_call_id: m.tool_call_id,
        name: m.name,
      })),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
      })),
    });
  }

  onLLMEnd(response: LLMResponse): void {
    this.addEvent("llm_end", "LLM Response", {
      content: response.content,
      tool_calls: response.tool_calls,
      usage: response.usage,
    });
  }

  onLLMError(error: LLMNetworkError): void {
    this.addEvent("llm_error", "LLM Error", {
      cause: error.cause,
      message: error.message,
    });
    this.flush();
  }

  onToolStart(toolName: string, args: Record<string, unknown>): void {
    this.addEvent("tool_start", `Tool: ${toolName}`, {
      toolName,
      args,
    });
  }

  onToolEnd(toolName: string, result: string): void {
    this.addEvent("tool_end", `Tool Result: ${toolName}`, {
      toolName,
      result: result.length > 2000 ? result.slice(0, 2000) + "\n... (truncated)" : result,
      resultLength: result.length,
    });
  }

  onToolError(toolName: string, error: string): void {
    this.addEvent("tool_error", `Tool Error: ${toolName}`, {
      toolName,
      error,
    });
  }

  onThought(thought: string): void {
    this.addEvent("thought", "Thought", { thought });
  }

  onPlanCreated(plan: string[]): void {
    this.addEvent("plan_created", "Plan Created", { plan });
  }

  onPlanRevised(plan: string[]): void {
    this.addEvent("plan_revised", "Plan Revised", { plan });
  }

  onFinish(answer: string): void {
    this.addEvent("finish", "Final Answer", { answer });
    this.flush();
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private addEvent(
    type: AgentTraceEventType,
    label: string,
    data: Record<string, unknown>,
  ): void {
    this.events.push({
      id: ++this.eventId,
      timestamp: new Date().toISOString(),
      type,
      label,
      data,
    });
  }

  // ─── HTML Generation ────────────────────────────────────────────────────

  private generateHTML(): string {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const eventCards = this.events.map((e) => this.renderEventCard(e)).join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session Trace — ${this.sessionId}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117; color: #c9d1d9; line-height: 1.6; padding: 24px;
  }
  .container { max-width: 960px; margin: 0 auto; }

  /* ── Header ── */
  .header {
    background: linear-gradient(135deg, #161b22, #1c2333);
    border: 1px solid #30363d; border-radius: 12px; padding: 24px 28px;
    margin-bottom: 28px;
  }
  .header h1 { font-size: 20px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; }
  .header h1 span { background: #238636; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 20px; }
  .header .meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: #8b949e; }
  .header .meta .item { display: flex; align-items: center; gap: 4px; }
  .header .meta .item strong { color: #c9d1d9; }

  /* ── Timeline ── */
  .timeline { position: relative; padding-left: 36px; }
  .timeline::before {
    content: ''; position: absolute; left: 14px; top: 8px; bottom: 8px;
    width: 2px; background: #21262d;
  }

  /* ── Event Card ── */
  .event { position: relative; margin-bottom: 12px; }
  .event-dot {
    position: absolute; left: -26px; top: 14px; width: 12px; height: 12px;
    border-radius: 50%; border: 2px solid #30363d; background: #0d1117; z-index: 1;
  }
  .event-body {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 12px 16px; cursor: pointer; transition: border-color .15s;
  }
  .event-body:hover { border-color: #58a6ff; }
  .event-header {
    display: flex; align-items: center; gap: 8px; font-size: 13px;
    user-select: none;
  }
  .event-header .icon { font-size: 16px; flex-shrink: 0; }
  .event-header .label { flex: 1; font-weight: 600; color: #e6edf3; }
  .event-header .time { color: #8b949e; font-size: 11px; font-family: monospace; }
  .event-header .toggle { color: #8b949e; font-size: 12px; }
  .event-detail {
    display: none; margin-top: 10px; border-top: 1px solid #21262d;
    padding-top: 10px; font-size: 13px;
  }
  .event.open .event-detail { display: block; }
  .event.open .toggle { transform: rotate(90deg); }

  /* ── Detail Blocks ── */
  .detail-section { margin-bottom: 10px; }
  .detail-section:last-child { margin-bottom: 0; }
  .detail-section h4 { font-size: 11px; text-transform: uppercase; color: #8b949e; margin-bottom: 4px; letter-spacing: .5px; }
  pre {
    background: #0d1117; border: 1px solid #21262d; border-radius: 6px;
    padding: 10px 12px; font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
    color: #e6edf3; max-height: 400px; overflow-y: auto;
  }
  pre .key { color: #79c0ff; }
  pre .string { color: #a5d6ff; }
  pre .number { color: #79c0ff; }
  pre .null { color: #d2a8ff; }
  pre .bool { color: #d2a8ff; }

  /* ── Event-type color accents ── */
  .event-type-llm_start .event-dot { border-color: #58a6ff; background: #1f6feb; }
  .event-type-llm_end .event-dot { border-color: #58a6ff; background: #1f6feb; }
  .event-type-llm_error .event-dot { border-color: #f85149; background: #da3633; }
  .event-type-tool_start .event-dot { border-color: #d29922; background: #9e6a03; }
  .event-type-tool_end .event-dot { border-color: #3fb950; background: #238636; }
  .event-type-tool_error .event-dot { border-color: #f85149; background: #da3633; }
  .event-type-thought .event-dot { border-color: #bc8cff; background: #8957e5; }
  .event-type-plan_created .event-dot { border-color: #79c0ff; background: #1f6feb; }
  .event-type-plan_revised .event-dot { border-color: #f0883e; background: #bd6200; }
  .event-type-finish .event-dot { border-color: #3fb950; background: #238636; }

  .event-type-llm_error .event-body { border-color: #f85149; }
  .event-type-tool_error .event-body { border-color: #f85149; }

  /* ── Plan steps list ── */
  ol.plan-steps { padding-left: 20px; margin: 4px 0; }
  ol.plan-steps li { margin-bottom: 2px; color: #e6edf3; }

  /* ── Tool call args table ── */
  .kv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .kv-table th, .kv-table td {
    text-align: left; padding: 4px 8px; border: 1px solid #21262d;
  }
  .kv-table th { background: #0d1117; color: #8b949e; font-weight: 500; white-space: nowrap; }

  @media (max-width: 640px) {
    body { padding: 12px; }
    .timeline { padding-left: 28px; }
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>🤖 <span>TRACE</span> ${this.escapeHtml(this.agentLabel)}</h1>
    <div class="meta">
      <span class="item"><strong>Session:</strong> ${this.escapeHtml(this.sessionId)}</span>
      <span class="item"><strong>Model:</strong> ${this.escapeHtml(this.modelName)}</span>
      <span class="item"><strong>Duration:</strong> ${duration}s</span>
      <span class="item"><strong>Events:</strong> ${this.events.length}</span>
      <span class="item"><strong>Generated:</strong> ${new Date().toLocaleString("zh-CN", { hour12: false })}</span>
    </div>
  </div>

  <div class="timeline">
${eventCards}
  </div>

</div>
<script>
  document.querySelectorAll('.event-body').forEach(el => {
    el.addEventListener('click', () => {
      el.parentElement.classList.toggle('open');
    });
  });
  // Auto-open error events and the final answer
  document.querySelectorAll('.event-type-llm_error, .event-type-tool_error, .event-type-finish, .event-type-plan_created, .event-type-plan_revised')
    .forEach(el => el.classList.add('open'));
</script>
</body>
</html>`;
  }

  private renderEventCard(event: AgentTraceEvent): string {
    const cls = `event event-type-${event.type}`;
    const time = new Date(event.timestamp).toLocaleTimeString("en-US", { hour12: false });
    const icon = this.eventIcon(event.type);
    let detail = "";

    switch (event.type) {
      case "llm_start": {
        const msgs = event.data.messages as Array<{ role: string; content: string }> | undefined;
        const tools = event.data.tools as Array<{ name: string; description: string }> | undefined;
        detail = `<div class="detail-section">
          <h4>Messages (${msgs?.length ?? 0})</h4>
          <pre>${this.syntaxHighlight(JSON.stringify(msgs ?? [], null, 2))}</pre>
        </div>`;
        if (tools && tools.length > 0) {
          detail += `<div class="detail-section">
            <h4>Available Tools (${tools.length})</h4>
            <pre>${this.syntaxHighlight(JSON.stringify(tools, null, 2))}</pre>
          </div>`;
        }
        break;
      }
      case "llm_end": {
        detail = `<div class="detail-section">
          <h4>Content</h4>
          <pre>${this.escapeHtml(String(event.data.content ?? ""))}</pre>
        </div>`;
        const tc = event.data.tool_calls as Array<{ function: { name: string; arguments: string } }> | undefined;
        if (tc && tc.length > 0) {
          detail += `<div class="detail-section">
            <h4>Tool Calls</h4>
            <pre>${this.syntaxHighlight(JSON.stringify(tc, null, 2))}</pre>
          </div>`;
        }
        const usage = event.data.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        if (usage) {
          detail += `<div class="detail-section">
            <h4>Usage</h4>
            <table class="kv-table"><tr>
              <th>Prompt</th><th>Completion</th><th>Total</th>
            </tr><tr>
              <td>${usage.prompt_tokens ?? "—"}</td>
              <td>${usage.completion_tokens ?? "—"}</td>
              <td>${usage.total_tokens ?? "—"}</td>
            </tr></table>
          </div>`;
        }
        break;
      }
      case "llm_error": {
        detail = `<div class="detail-section">
          <h4>Error (${this.escapeHtml(String(event.data.cause ?? ""))})</h4>
          <pre>${this.escapeHtml(String(event.data.message ?? ""))}</pre>
        </div>`;
        break;
      }
      case "tool_start": {
        const tblRows = Object.entries(event.data.args as Record<string, unknown> ?? {})
          .map(([k, v]) => `<tr><th>${this.escapeHtml(k)}</th><td><pre style="margin:0;padding:4px;background:none;border:none;max-height:200px">${this.escapeHtml(JSON.stringify(v, null, 2))}</pre></td></tr>`)
          .join("");
        detail = `<div class="detail-section">
          <h4>Arguments</h4>
          <table class="kv-table">${tblRows}</table>
        </div>`;
        break;
      }
      case "tool_end": {
        detail = `<div class="detail-section">
          <h4>Result (${event.data.resultLength} chars)</h4>
          <pre>${this.escapeHtml(String(event.data.result ?? ""))}</pre>
        </div>`;
        break;
      }
      case "tool_error": {
        detail = `<div class="detail-section">
          <h4>Error</h4>
          <pre>${this.escapeHtml(String(event.data.error ?? ""))}</pre>
        </div>`;
        break;
      }
      case "thought": {
        detail = `<div class="detail-section">
          <pre>${this.escapeHtml(String(event.data.thought ?? ""))}</pre>
        </div>`;
        break;
      }
      case "plan_created":
      case "plan_revised": {
        const plan = event.data.plan as string[] | undefined;
        if (plan && plan.length > 0) {
          detail = `<div class="detail-section">
            <ol class="plan-steps">${plan.map((s) => `<li>${this.escapeHtml(s)}</li>`).join("")}</ol>
          </div>`;
        }
        break;
      }
      case "finish": {
        detail = `<div class="detail-section">
          <pre>${this.escapeHtml(String(event.data.answer ?? ""))}</pre>
        </div>`;
        break;
      }
    }

    return `    <div class="${cls}">
      <div class="event-dot"></div>
      <div class="event-body">
        <div class="event-header">
          <span class="icon">${icon}</span>
          <span class="label">${this.escapeHtml(event.label)}</span>
          <span class="time">${time}</span>
          <span class="toggle">▶</span>
        </div>
        <div class="event-detail">${detail}</div>
      </div>
    </div>`;
  }

  private eventIcon(type: AgentTraceEventType): string {
    switch (type) {
      case "llm_start": return "📤";
      case "llm_end": return "📥";
      case "llm_error": return "❌";
      case "tool_start": return "🔧";
      case "tool_end": return "✅";
      case "tool_error": return "⚠️";
      case "thought": return "💭";
      case "plan_created": return "📋";
      case "plan_revised": return "🔄";
      case "finish": return "🏁";
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private syntaxHighlight(json: string): string {
    return json.replace(
      /("(?:[^"\\]|\\.)*")\s*:/g,
      '<span class="key">$1</span>:',
    ).replace(
      /:\s*("(?:[^"\\]|\\.)*")/g,
      ': <span class="string">$1</span>',
    ).replace(
      /:\s*(\d+(?:\.\d+)?)/g,
      ': <span class="number">$1</span>',
    ).replace(
      /:\s*(true|false)/g,
      ': <span class="bool">$1</span>',
    ).replace(
      /:\s*(null)/g,
      ': <span class="null">$1</span>',
    );
  }
}
