import { Role, MessageData, ToolCall } from "./types";

/**
 * Message class representing a single turn in the conversation.
 * Supports system, user, assistant, and tool roles.
 */
export class Message {
  public readonly role: Role;
  public readonly content: string;
  public readonly name?: string;
  public readonly tool_call_id?: string;
  public readonly tool_calls?: ToolCall[];

  constructor(
    role: Role,
    content: string,
    options?: {
      name?: string;
      tool_call_id?: string;
      tool_calls?: ToolCall[];
    }
  ) {
    this.role = role;
    this.content = content;
    this.name = options?.name;
    this.tool_call_id = options?.tool_call_id;
    this.tool_calls = options?.tool_calls;
  }

  /**
   * Convert to a plain object suitable for the OpenAI Chat Completion API.
   */
  toDict(): MessageData {
    const dict: MessageData = {
      role: this.role,
      content: this.content,
    };
    if (this.name) dict.name = this.name;
    if (this.tool_call_id) dict.tool_call_id = this.tool_call_id;
    if (this.tool_calls && this.tool_calls.length > 0)
      dict.tool_calls = this.tool_calls;
    return dict;
  }

  /**
   * Deserialize a Message from a MessageData object.
   */
  static fromData(data: MessageData): Message {
    return new Message(data.role, data.content, {
      name: data.name,
      tool_call_id: data.tool_call_id,
      tool_calls: data.tool_calls,
    });
  }

  /**
   * Create a user message.
   */
  static user(content: string): Message {
    return new Message(Role.User, content);
  }

  /**
   * Create a system message.
   */
  static system(content: string): Message {
    return new Message(Role.System, content);
  }

  /**
   * Create an assistant message.
   */
  static assistant(content: string, tool_calls?: ToolCall[]): Message {
    return new Message(Role.Assistant, content, { tool_calls });
  }

  /**
   * Create a tool result message.
   */
  static tool(content: string, tool_call_id: string, name?: string): Message {
    return new Message(Role.Tool, content, { tool_call_id, name });
  }
}
