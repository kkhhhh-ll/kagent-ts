import { describe, it, expect } from "vitest";
import { ReActAgent } from "../../src/core/react-agent";
import type { LLMProvider, LLMResponse } from "../../src/llm/interface";
import type { Tool } from "../../src/tools/types";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import { WriteFileTool } from "../../src/tools/builtin/write-file";
import { EditFileTool } from "../../src/tools/builtin/edit-file";
import { BashTool } from "../../src/tools/builtin/bash";

describe("Tool Approval (Human-in-the-loop)", () => {
  const approvedTool: Tool = {
    name: "approved_op",
    description: "An operation that requires approval",
    parameters: { type: "object", properties: {} },
    requireApproval: true,
    async execute() { return "executed!"; },
  };

  function mockLLM(toolName: string): LLMProvider {
    return {
      model: "test",
      chat: async (): Promise<LLMResponse> => ({
        content: JSON.stringify({ thought: "calling tool", answer: undefined }),
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: toolName, arguments: "{}" },
        }],
      }),
      chatStream: async function* () { yield { type: "done" }; },
      getTokenCount: () => 10,
    };
  }

  it("executes tool when approval is granted", async () => {
    const registry = new ToolRegistry();
    registry.register(approvedTool);

    const agent = new ReActAgent({
      llm: mockLLM("approved_op"),
      toolRegistry: registry,
      logger: new SilentLogger(),
      maxIterations: 2,
      onToolApproval: async () => true, // always approve
    });

    // Will execute the tool and continue loop — eventually max iterations
    const result = await agent.run("do something");
    // Should complete (not hang on approval)
    expect(result).toBeTruthy();
  });

  it("denies tool when approval is denied", async () => {
    const registry = new ToolRegistry();
    registry.register(approvedTool);

    // LLM calls the tool once, it gets denied, then LLM tries again
    let callCount = 0;
    const llm: LLMProvider = {
      model: "test",
      chat: async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: JSON.stringify({ thought: "trying tool" }),
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "approved_op", arguments: "{}" },
            }],
          };
        }
        // Second call: give up and answer
        return {
          content: JSON.stringify({ thought: "denied", answer: "Tool was denied, giving up." }),
        };
      },
      chatStream: async function* () { yield { type: "done" }; },
      getTokenCount: () => 10,
    };

    const agent = new ReActAgent({
      llm,
      toolRegistry: registry,
      logger: new SilentLogger(),
      maxIterations: 3,
      onToolApproval: async () => false, // always deny
    });

    const result = await agent.run("do something");
    expect(result).toContain("Tool was denied");
    expect(callCount).toBe(2); // first call denied → LLM tries again → answer
  });

  it("denies tool when no onToolApproval is configured", async () => {
    const registry = new ToolRegistry();
    registry.register(approvedTool);

    const agent = new ReActAgent({
      llm: mockLLM("approved_op"),
      toolRegistry: registry,
      logger: new SilentLogger(),
      maxIterations: 2,
      // no onToolApproval → should auto-deny
    });

    // Should not hang — tool is auto-denied, max iterations reached
    const result = await agent.run("test");
    expect(result).toBeTruthy();
  });

  it("tools without requireApproval execute immediately", async () => {
    const normalTool: Tool = {
      name: "safe_op",
      description: "No approval needed",
      parameters: { type: "object", properties: {} },
      // requireApproval not set (defaults to undefined)
      async execute() { return "safe result"; },
    };

    const registry = new ToolRegistry();
    registry.register(normalTool);

    let callCount = 0;
    const llm: LLMProvider = {
      model: "test",
      chat: async (): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: JSON.stringify({ thought: "calling tool" }),
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "safe_op", arguments: "{}" },
            }],
          };
        }
        return {
          content: JSON.stringify({ thought: "done", answer: "Safe operation completed." }),
        };
      },
      chatStream: async function* () { yield { type: "done" }; },
      getTokenCount: () => 10,
    };

    const agent = new ReActAgent({
      llm,
      toolRegistry: registry,
      logger: new SilentLogger(),
      maxIterations: 3,
      onToolApproval: async () => { throw new Error("should not be called"); },
    });

    const result = await agent.run("test");
    expect(result).toContain("Safe operation");
  });

  it("write_file has requireApproval: true", () => {
    expect(WriteFileTool.requireApproval).toBe(true);
  });

  it("edit_file has requireApproval: true", () => {
    expect(EditFileTool.requireApproval).toBe(true);
  });

  it("bash has requireApproval: true", () => {
    expect(BashTool.requireApproval).toBe(true);
  });
});
