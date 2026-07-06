/**
 * Test: AnthropicProvider.convertMessages — tool_use/tool_result pairing.
 *
 * Verifies the conversion logic correctly handles tool_use/tool_result
 * pairing in complex scenarios (batch review, compression, sub-agents,
 * truncation). Also tests that the repair safety net synthesizes
 * tool_results for any unpaired tool_use blocks.
 */
import { describe, it, expect } from "vitest";
import { MessageData, Role } from "../../src/messages/types";
import type { Anthropic } from "@anthropic-ai/sdk";

async function getFormatted(messages: MessageData[]) {
  const { AnthropicProvider } = await import("../../src/llm/anthropic-provider");
  return (AnthropicProvider as any).convertMessages(messages)
    .formattedMessages as Anthropic.MessageParam[];
}

describe("AnthropicProvider.convertMessages", () => {
  it("pairs single tool_use with its tool_result", async () => {
    const msgs: MessageData[] = [
      { role: Role.User, content: "query" },
      { role: Role.Assistant, content: "ok", tool_calls: [
        { id: "t1", type: "function", function: { name: "grep", arguments: "{}" } },
      ]},
      { role: Role.Tool, content: "result", tool_call_id: "t1", name: "grep" },
    ];
    const formatted = await getFormatted(msgs);

    const assistant = formatted.find((m: any) => m.role === "assistant");
    const users = formatted.filter((m: any) => m.role === "user");

    expect(assistant).toBeDefined();
    const tuBlocks = (assistant!.content as any[]).filter((b: any) => b.type === "tool_use");
    expect(tuBlocks).toHaveLength(1);
    expect(tuBlocks[0].id).toBe("t1");

    // tool_result should be in the next user message
    const nextUser = users[users.length - 1];
    const trBlocks = Array.isArray(nextUser.content)
      ? nextUser.content.filter((b: any) => b.type === "tool_result")
      : [];
    expect(trBlocks).toHaveLength(1);
    expect(trBlocks[0].tool_use_id).toBe("t1");
  });

  it("pairs multiple parallel tool_use blocks with merged tool_results", async () => {
    const msgs: MessageData[] = [
      { role: Role.User, content: "review" },
      { role: Role.Assistant, content: "", tool_calls: [
        { id: "ta", type: "function", function: { name: "grep", arguments: "{}" } },
        { id: "tb", type: "function", function: { name: "read", arguments: "{}" } },
      ]},
      { role: Role.Tool, content: "resultA", tool_call_id: "ta", name: "grep" },
      { role: Role.Tool, content: "resultB", tool_call_id: "tb", name: "read" },
    ];
    const formatted = await getFormatted(msgs);

    const assistant = formatted.find((m: any) => m.role === "assistant");
    const tuBlocks = (assistant!.content as any[]).filter((b: any) => b.type === "tool_use");
    expect(tuBlocks).toHaveLength(2);

    // Both tool_results must be in the immediately-next user message
    const asstIdx = formatted.indexOf(assistant!);
    const next = formatted[asstIdx + 1];
    expect(next.role).toBe("user");
    const trBlocks = (next.content as any[]).filter((b: any) => b.type === "tool_result");
    expect(trBlocks).toHaveLength(2);
    const ids = trBlocks.map((b: any) => b.tool_use_id);
    expect(ids).toContain("ta");
    expect(ids).toContain("tb");
  });

  it("repairs unpaired tool_use by injecting synthetic tool_results", async () => {
    // Simulate: assistant with tool_use but no tool_result follows
    const msgs: MessageData[] = [
      { role: Role.User, content: "query" },
      { role: Role.Assistant, content: "ok", tool_calls: [
        { id: "orphan_1", type: "function", function: { name: "grep", arguments: "{}" } },
      ]},
      // Missing: tool_result for orphan_1
      { role: Role.User, content: "next query" },
    ];
    const formatted = await getFormatted(msgs);

    // The assistant with tool_use should still have its tool_use blocks
    const assistant = formatted.find((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use")
    );
    expect(assistant).toBeDefined();

    const tuBlocks = (assistant!.content as any[]).filter((b: any) => b.type === "tool_use");
    expect(tuBlocks).toHaveLength(1);

    // A synthetic tool_result should be injected into the next user message
    const asstIdx = formatted.indexOf(assistant!);
    const next = formatted[asstIdx + 1];
    expect(next.role).toBe("user");

    const trBlocks = Array.isArray(next.content)
      ? next.content.filter((b: any) => b.type === "tool_result")
      : [];
    expect(trBlocks).toHaveLength(1);
    expect(trBlocks[0].tool_use_id).toBe("orphan_1");
    expect(trBlocks[0].content).toContain("skipped");
    expect(trBlocks[0].is_error).toBe(true);
  });

  it("handles compression-style consecutive user messages", async () => {
    // Compression Step 4 produces [User(summary), User(hint)]
    const msgs: MessageData[] = [
      { role: Role.User, content: "[Summary] compressed history" },
      { role: Role.User, content: "[Hint] continue from where you left off" },
      { role: Role.Assistant, content: "", tool_calls: [
        { id: "t1", type: "function", function: { name: "grep", arguments: "{}" } },
      ]},
      { role: Role.Tool, content: "result", tool_call_id: "t1", name: "grep" },
    ];
    const formatted = await getFormatted(msgs);

    // Verify alternation is maintained (no consecutive same roles)
    for (let i = 1; i < formatted.length; i++) {
      expect(formatted[i].role).not.toBe(formatted[i - 1].role);
    }

    // tool_use must be followed by tool_result
    const assistant = formatted.find((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use")
    );
    const asstIdx = formatted.indexOf(assistant!);
    const next = formatted[asstIdx + 1];
    const trBlocks = (next.content as any[]).filter((b: any) => b.type === "tool_result");
    expect(trBlocks).toHaveLength(1);
    expect(trBlocks[0].tool_use_id).toBe("t1");
  });

  it("handles 30-round stress test with sub-agent injections", async () => {
    const msgs: MessageData[] = [{ role: Role.User, content: "Review 20 files" }];
    let c = 0;
    for (let r = 0; r < 30; r++) {
      const tids = [`t${++c}`, `t${++c}`];
      msgs.push({
        role: Role.Assistant, content: `round ${r}`,
        tool_calls: tids.map(id => ({
          id, type: "function" as const,
          function: { name: "grep", arguments: "{}" },
        })),
      });
      if (r % 5 === 0) {
        msgs.push({ role: Role.User, content: "<subagent-result>done</subagent-result>" });
      }
      for (const id of tids) {
        msgs.push({ role: Role.Tool, content: `result_${id}`, tool_call_id: id, name: "grep" });
      }
    }

    const formatted = await getFormatted(msgs);

    // Validate every tool_use has a matching tool_result in the next message
    for (let i = 0; i < formatted.length; i++) {
      const msg = formatted[i];
      if (msg.role !== "assistant") continue;
      const blocks = Array.isArray(msg.content) ? msg.content as any[] : [];
      const uses = blocks.filter((b: any) => b.type === "tool_use");
      if (uses.length === 0) continue;

      const next = formatted[i + 1];
      expect(next, `[${i}] tool_use without next message`).toBeDefined();
      const nextBlocks = Array.isArray(next.content) ? next.content as any[] : [];
      const results = nextBlocks.filter((b: any) => b.type === "tool_result");
      const ids = new Set(results.map((r: any) => r.tool_use_id));

      for (const u of uses) {
        expect(ids.has(u.id),
          `[${i}] tool_use "${u.id}" missing from [${i + 1}]; have: [${[...ids]}]`
        ).toBe(true);
      }
    }

    // Verify alternation
    for (let i = 1; i < formatted.length; i++) {
      expect(formatted[i].role).not.toBe(formatted[i - 1].role);
    }
  });

  it("synthesizes tool_results when user continuation sits between assistant and tool", async () => {
    // Truncation edge: assistant(tool_use) -> user("Continue...") -> (no tool_results)
    const msgs: MessageData[] = [
      { role: Role.User, content: "query" },
      { role: Role.Assistant, content: "truncated", tool_calls: [
        { id: "tA", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "tB", type: "function", function: { name: "grep", arguments: "{}" } },
      ]},
      // BUG scenario: user message between assistant and its tool_results
      { role: Role.User, content: "Your previous response was cut off..." },
      // tool_results would normally follow here but are missing in this test
    ];
    const formatted = await getFormatted(msgs);

    // The assistant keeps its tool_use blocks
    const assistant = formatted.find((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use")
    );
    expect(assistant).toBeDefined();

    // Synthetic tool_results should be injected into the continuation user message
    const asstIdx = formatted.indexOf(assistant!);
    const next = formatted[asstIdx + 1];
    const trBlocks = (next.content as any[]).filter((b: any) => b.type === "tool_result");
    expect(trBlocks).toHaveLength(2);
    expect(trBlocks.map((b: any) => b.tool_use_id).sort()).toEqual(["tA", "tB"]);
    // Each should contain the "skipped" message
    for (const tr of trBlocks) {
      expect(tr.content).toContain("skipped");
      expect(tr.is_error).toBe(true);
    }
  });
});
