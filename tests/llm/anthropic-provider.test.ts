import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../../src/llm/anthropic-provider";
import { Role } from "../../src/messages/types";
import type { MessageData } from "../../src/messages/types";

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal valid Anthropic API response for `convertResponse` to consume.
 */
function fakeTextResponse(text: string): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/**
 * Create an AnthropicProvider whose underlying client always returns
 * `response`.  Returns the provider plus a spy so callers can inspect the
 * `messages` param that `convertMessages` produced.
 */
function captureProvider(response?: Anthropic.Messages.Message) {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
  });

  const createSpy = vi.fn().mockResolvedValue(
    response ?? fakeTextResponse("ok"),
  );
  (provider as any).client.messages = { create: createSpy };

  return { provider, createSpy };
}

/** Return the formatted `messages` array passed to the last `create` call. */
function lastMessages(createSpy: any): Anthropic.MessageParam[] {
  return createSpy.mock.calls.at(-1)?.[0]?.messages ?? [];
}

// ─── Shortcut builders for MessageData ────────────────────────────────────

function userMsg(content: string): MessageData {
  return { role: Role.User, content };
}

function asstMsg(toolCalls?: MessageData["tool_calls"]): MessageData {
  if (!toolCalls || toolCalls.length === 0) {
    return { role: Role.Assistant, content: "thinking…" };
  }
  return { role: Role.Assistant, content: "calling tools", tool_calls: toolCalls };
}

function toolMsg(toolCallId: string, name: string, content?: string): MessageData {
  return {
    role: Role.Tool,
    content: content ?? `result of ${name}`,
    tool_call_id: toolCallId,
    name,
  };
}

function toolCall(id: string, name: string, args?: string): NonNullable<MessageData["tool_calls"]>[number] {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: args ?? "{}" },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("AnthropicProvider.convertMessages", () => {
  // ── Basic conversion ──────────────────────────────────────────────────

  it("converts a simple user → assistant conversation", async () => {
    const { provider, createSpy } = captureProvider();
    await provider.chat([userMsg("hello"), asstMsg()]);

    const msgs = lastMessages(createSpy);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "hello" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "thinking…" });
  });

  it("extracts system messages into the system prompt", async () => {
    const { provider, createSpy } = captureProvider();
    await provider.chat([
      { role: Role.System, content: "You are helpful." },
      userMsg("hi"),
      asstMsg(),
    ]);

    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.system).toBe("You are helpful.");
    expect(callArgs.messages).toHaveLength(2);
  });

  // ── Tool-result merging (the core fix) ─────────────────────────────────

  describe("tool-result merging", () => {
    it("merges consecutive tool results into a single user message", async () => {
      const { provider, createSpy } = captureProvider();
      const tc = [toolCall("c1", "read"), toolCall("c2", "grep"), toolCall("c3", "glob")];

      await provider.chat([
        userMsg("review this code"),
        asstMsg(tc),
        toolMsg("c1", "read", "file content A"),
        toolMsg("c2", "grep", "match line 42"),
        toolMsg("c3", "glob", "src/a.ts, src/b.ts"),
      ]);

      const msgs = lastMessages(createSpy);
      // user → assistant → user (with 3 merged tool_results)
      expect(msgs).toHaveLength(3);

      expect(msgs[0].role).toBe("user");
      expect(msgs[1].role).toBe("assistant");

      // The third message must be a single user message containing all 3 tool_results
      expect(msgs[2].role).toBe("user");
      const content = msgs[2].content as any[];
      expect(Array.isArray(content)).toBe(true);
      const results = content.filter((b: any) => b.type === "tool_result");
      expect(results).toHaveLength(3);
      expect(results[0].tool_use_id).toBe("c1");
      expect(results[1].tool_use_id).toBe("c2");
      expect(results[2].tool_use_id).toBe("c3");
    });

    it("merges tool results into a preceding plain-text user message", async () => {
      // Simulates the scenario where a "Continue…" message sits between
      // the assistant's tool_use blocks and the tool_results.
      const { provider, createSpy } = captureProvider();
      const tc = [toolCall("c1", "read")];

      await provider.chat([
        userMsg("review this"),
        asstMsg(tc),
        userMsg("Your previous response was cut off. Continue…"),
        toolMsg("c1", "read", "file content"),
      ]);

      const msgs = lastMessages(createSpy);

      // The tool_result MUST be in the immediately-next user message
      // after the assistant — i.e. merged with the "Continue…" text.
      expect(msgs[2].role).toBe("user");
      const content = msgs[2].content as any[];
      expect(Array.isArray(content)).toBe(true);

      // Should contain the original text as a text block + the tool_result
      expect(content[0]).toEqual({ type: "text", text: "Your previous response was cut off. Continue…" });
      expect(content[1]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
    });

    it("does NOT merge a tool result backwards across an assistant message", async () => {
      // The first tool result after an assistant should start a NEW user
      // message, not be merged into the user message BEFORE the assistant.
      const { provider, createSpy } = captureProvider();
      const tc = [toolCall("c1", "read")];

      await provider.chat([
        userMsg("initial request"),
        asstMsg(),                        // no tool calls
        userMsg("follow-up request"),
        asstMsg(tc),                      // tool_use here
        toolMsg("c1", "read", "content"),
      ]);

      const msgs = lastMessages(createSpy);

      // The tool_result must be in a NEW user message after the
      // assistant-with-tool_use, NOT in the "follow-up request" message.
      const lastUser = msgs[msgs.length - 1];
      expect(lastUser.role).toBe("user");
      const content = lastUser.content as any[];
      expect(Array.isArray(content)).toBe(true);
      // Should only contain tool_result, NOT "follow-up request"
      expect(content.some((b: any) => b.type === "tool_result")).toBe(true);
      expect(content.some((b: any) => b.type === "text" && (b as any).text === "follow-up request")).toBe(false);
    });

    it("preserves tool_use_ids without modification", async () => {
      const { provider, createSpy } = captureProvider();
      const realId = "call_01_XyZ123";
      const tc = [toolCall(realId, "echo", '{"msg":"hi"}')];

      await provider.chat([
        userMsg("echo hi"),
        asstMsg(tc),
        toolMsg(realId, "echo", "ECHO: hi"),
      ]);

      const msgs = lastMessages(createSpy);
      const content = msgs[2].content as any[];
      expect(content[0].tool_use_id).toBe(realId);
    });

    it("generates a fallback tool_use_id when tool_call_id is missing", async () => {
      const { provider, createSpy } = captureProvider();
      const tc = [toolCall("c1", "search")];

      await provider.chat([
        userMsg("search"),
        asstMsg(tc),
        { role: Role.Tool, content: "found", name: "search" },  // no tool_call_id!
      ]);

      const msgs = lastMessages(createSpy);
      const content = msgs[2].content as any[];
      // Should still generate a tool_result block, with a fallback id
      expect(content[0].type).toBe("tool_result");
      expect(content[0].tool_use_id).toBeTruthy();
    });
  });

  // ── Alternation (existing behaviour, preserved) ────────────────────────

  describe("user / assistant alternation", () => {
    it("inserts (continued) between consecutive user messages", async () => {
      const { provider, createSpy } = captureProvider();
      await provider.chat([
        userMsg("first"),
        userMsg("second"),
        asstMsg(),
      ]);

      const msgs = lastMessages(createSpy);
      // user, user → alternation inserts assistant "(continued)" in between,
      // then the final assistant message → 4 messages total
      expect(msgs).toHaveLength(4);
      expect(msgs[0]).toEqual({ role: "user", content: "first" });
      expect(msgs[1]).toEqual({ role: "assistant", content: "(continued)" });
      expect(msgs[2]).toEqual({ role: "user", content: "second" });
      expect(msgs[3]).toEqual({ role: "assistant", content: "thinking…" });
    });

    it("inserts (continued) between consecutive assistant messages", async () => {
      const { provider, createSpy } = captureProvider();
      await provider.chat([
        userMsg("hi"),
        asstMsg(),
        asstMsg(),
      ]);

      const msgs = lastMessages(createSpy);
      expect(msgs).toHaveLength(4);
      // user → assistant → user(continued) → assistant
      expect(msgs[0].role).toBe("user");
      expect(msgs[1].role).toBe("assistant");
      expect(msgs[2].role).toBe("user");
      expect(msgs[2].content).toBe("(continued)");
      expect(msgs[3].role).toBe("assistant");
    });

    it("inserts a placeholder when all messages are system-level", async () => {
      const { provider, createSpy } = captureProvider();
      await provider.chat([{ role: Role.System, content: "sys" }]);

      const msgs = lastMessages(createSpy);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toBe("(start)");
    });
  });

  // ── Tool-use blocks in assistant messages ──────────────────────────────

  describe("assistant with tool_calls", () => {
    it("emits tool_use content blocks", async () => {
      const { provider, createSpy } = captureProvider();
      const tc = [toolCall("call_1", "echo", '{"msg":"hi"}')];

      await provider.chat([
        userMsg("echo hi"),
        asstMsg(tc),
        toolMsg("call_1", "echo", "ECHO: hi"),
      ]);

      const msgs = lastMessages(createSpy);
      const asstContent = msgs[1].content as any[];
      expect(Array.isArray(asstContent)).toBe(true);
      const useBlocks = asstContent.filter((b: any) => b.type === "tool_use");
      expect(useBlocks).toHaveLength(1);
      expect(useBlocks[0]).toMatchObject({
        type: "tool_use",
        id: "call_1",
        name: "echo",
        input: { msg: "hi" },
      });
    });

    it("includes a text block alongside tool_use when content is non-empty", async () => {
      const { provider, createSpy } = captureProvider();
      const tc = [toolCall("c1", "read")];

      await provider.chat([
        userMsg("read file"),
        asstMsg(tc),  // has content "calling tools"
        toolMsg("c1", "read", "content"),
      ]);

      const msgs = lastMessages(createSpy);
      const asstContent = msgs[1].content as any[];
      expect(asstContent[0].type).toBe("text");
      expect(asstContent[1].type).toBe("tool_use");
    });
  });
});
