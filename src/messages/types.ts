/**
 * Role enum for message types in the agent conversation.
 */
export enum Role {
  System = "system",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
}

/**
 * Represents a tool call requested by the assistant.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Raw data shape of a message — used for serialization and LLM API calls.
 *
 * NOTE: `content` is always a non-null `string`.  When a raw LLM API response
 * returns `content: null` (e.g. assistant messages with only tool_calls), the
 * provider layer normalizes it to an empty string BEFORE constructing the
 * MessageData.  Callers can safely use string methods without null-guarding.
 */
export interface MessageData {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Unix timestamp in milliseconds when the message was recorded. */
  timestamp?: number;
}
