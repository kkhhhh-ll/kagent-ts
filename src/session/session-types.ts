import { MessageData } from "../messages/types";

/**
 * Which agent paradigm the session belongs to.
 */
export type AgentType = "react" | "plan-solve";

/**
 * Lifecycle status of a persisted session.
 * - "active":      Session is in progress, checkpoint was saved mid-run.
 * - "interrupted": Session was interrupted by a network error, ready for resume.
 * - "completed":   Session finished normally.
 * - "cancelled":   User cancelled (Ctrl+C); session preserved for later resume.
 */
export type SessionStatus = "active" | "interrupted" | "completed" | "cancelled";

/**
 * Serializable plan state for PlanSolveAgent sessions.
 */
export interface PlanSolveSessionState {
  currentPlan: string[];
  hasPlan: boolean;
  completedSteps: number;
  consecutiveFailures: number;
}

/**
 * Full session state snapshot.
 *
 * This is the serialised form of everything needed to reconstruct an agent
 * and resume execution after an interruption (e.g. network outage).
 *
 * Messages are stored inline — not referenced via MediumTermMemory — so the
 * checkpoint is self-contained regardless of memory configuration.
 */
export interface SessionState {
  /** Unique identifier for this session (e.g. "session-1748234567890"). */
  sessionId: string;

  /** Which agent type created this session. */
  agentType: AgentType;

  /** The core system prompt used by the agent. */
  systemPrompt: string;

  /** Full message history at checkpoint time. */
  messages: MessageData[];

  /** Plan-Solve specific state (only present for plan-solve agents). */
  planState?: PlanSolveSessionState;

  /** ISO-8601 timestamp of session creation (stable across saves). */
  createdAt: string;

  /** ISO-8601 timestamp of last checkpoint save. */
  updatedAt: string;

  /** Current lifecycle status. */
  status: SessionStatus;

  /** Optional metadata (model name, token counts, etc.). */
  metadata?: Record<string, unknown>;
}
