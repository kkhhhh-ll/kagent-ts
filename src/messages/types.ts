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
 */
export interface MessageData {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}
