import { describe, it, expect } from "vitest";
import { ReActAgent } from "../../src/core/react-agent";
import type { Tool } from "../../src/tools/types";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import { WriteFileTool } from "../../src/tools/builtin/write-file";
import { EditFileTool } from "../../src/tools/builtin/edit-file";
import { BashTool } from "../../src/tools/builtin/bash";
import {
  mockToolCallLLM,
  mockAnswerLLM,
  mockSequenceLLM,
  toolCallContent,
  answerContent,
} from "../mocks/mock-llm-provider";

describe("Tool Approval (Human-in-the-loop)", () => {
  const approvedTool: Tool = {
    name: "approved_op",
    description: "An operation that requires approval",
    parameters: { type: "object", properties: {} },
    requireApproval: true,
    async execute() { return "executed!"; },
  };

  it("executes tool when approval is granted", async () => {
    const registry = new ToolRegistry();
    registry.register(approvedTool);

    const agent = new ReActAgent({
      llm: mockToolCallLLM("approved_op"),
      toolRegistry: registry,
      logger: new SilentLogger(),
      maxIterations: 2,
      onToolApproval: async (_name, _args, _signal) => true,
    });

    const result = await agent.run("do something");
    expect(result).toBeTruthy();
  });

  it("denies tool when approval is denied", async () => {
    const registry = new ToolRegistry();
    registry.register(approvedTool);

    // First call: try tool → denied. Second call: give up and answer.
    const llm = mockSequenceLLM([
      [toolCallContent("approved_op"), [{
        id: "call_1",
        type: "function" as const,
        function: { name: "approved_op", arguments: "{}" },
      }]],
      [answerContent("Tool was denied, giving up.")],
    ]);

    const agent = new ReActAgent({
      llm,
      toolRegistry: registry,
      logger: new SilentLogger(),
      maxIterations: 3,
      onToolApproval: async (_name, _args, _signal) => false,
    });

    const result = await agent.run("do something");
    expect(result).toContain("Tool was denied");
  });

  it("denies tool when no onToolApproval is configured", async () => {
    const registry = new ToolRegistry();
    registry.register(approvedTool);

    const agent = new ReActAgent({
      llm: mockToolCallLLM("approved_op"),
      toolRegistry: registry,
      logger: new SilentLogger(),
      maxIterations: 2,
      // no onToolApproval → auto-deny
    });

    const result = await agent.run("test");
    expect(result).toBeTruthy();
  });

  it("tools without requireApproval execute immediately", async () => {
    const normalTool: Tool = {
      name: "safe_op",
      description: "No approval needed",
      parameters: { type: "object", properties: {} },
      async execute() { return "safe result"; },
    };

    const registry = new ToolRegistry();
    registry.register(normalTool);

    // First call: safe_op (no approval needed). Second: answer.
    const llm = mockSequenceLLM([
      [toolCallContent("safe_op"), [{
        id: "call_1",
        type: "function" as const,
        function: { name: "safe_op", arguments: "{}" },
      }]],
      [answerContent("Safe operation completed.")],
    ]);

    const agent = new ReActAgent({
      llm,
      toolRegistry: registry,
      logger: new SilentLogger(),
      maxIterations: 3,
      onToolApproval: async (_name, _args, _signal) => { throw new Error("should not be called"); },
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
