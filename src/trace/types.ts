/**
 * Types of events that can occur during agent execution.
 */
export type AgentTraceEventType =
  | "llm_start"
  | "llm_end"
  | "llm_error"
  | "tool_start"
  | "tool_end"
  | "tool_error"
  | "thought"
  | "plan_created"
  | "plan_revised"
  | "finish"
  | "subagent_spawn"
  | "subagent_result"
  | "compression_start"
  | "compression_end";

/**
 * A single trace event in the agent's execution timeline.
 */
export interface AgentTraceEvent {
  /** Monotonically increasing event sequence number. */
  id: number;
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /** Event type category. */
  type: AgentTraceEventType;
  /** Human-readable event label. */
  label: string;
  /** Event-specific payload. */
  data: Record<string, unknown>;
}
