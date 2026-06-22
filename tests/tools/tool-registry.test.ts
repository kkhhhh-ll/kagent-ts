import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { ToolErrorCode } from "../../src/tools/types";
import type { Tool } from "../../src/tools/types";

function makeTool(name: string, execute: Tool["execute"]): Tool {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: { type: "object", properties: {} },
    execute,
  };
}

const successTool = makeTool("success", async () => "done");
const failingTool = makeTool("fail", async () => {
  throw new Error("boom");
});

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const registry = new ToolRegistry();
    registry.register(successTool);
    expect(registry.has("success")).toBe(true);
    expect(registry.getTool("success")).toBe(successTool);
    expect(registry.count).toBe(1);
  });

  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(successTool);
    expect(() => registry.register(successTool)).toThrow("already registered");
  });

  it("execute returns success result", async () => {
    const registry = new ToolRegistry();
    registry.register(successTool);
    const result = await registry.execute("success", {});
    expect(result.success).toBe(true);
    expect(result.content).toBe("done");
  });

  it("execute returns UNKNOWN_TOOL for unregistered name", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute("ghost", {});
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.UNKNOWN_TOOL);
    expect(result.severity).toBe("fatal");
  });

  it("execute returns RETRYABLE on first failure", async () => {
    const registry = new ToolRegistry(2); // 2 retries → 3 total
    registry.register(failingTool);
    const result = await registry.execute("fail", {});
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ToolErrorCode.EXECUTION_FAILURE);
    expect(result.severity).toBe("retryable");
    expect(result.content).toContain("[RETRYABLE");
  });

  it("circuit opens after exhausting retries", async () => {
    const registry = new ToolRegistry(0); // 0 retries → 1 attempt before open
    registry.register(failingTool);

    // First call — fails, circuit opens
    await registry.execute("fail", {});
    // Second call — circuit is open
    const result = await registry.execute("fail", {});
    expect(result.errorCode).toBe(ToolErrorCode.CIRCUIT_OPEN);
    expect(result.severity).toBe("fatal");
  });

  it("circuit breaker resets after successful execution", async () => {
    let shouldFail = true;
    const flipFlopTool = makeTool("flipflop", async () => {
      if (shouldFail) { shouldFail = false; throw new Error("fail1"); }
      return "ok";
    });

    const registry = new ToolRegistry(2);
    registry.register(flipFlopTool);

    // First call fails
    const r1 = await registry.execute("flipflop", {});
    expect(r1.success).toBe(false);

    // Second call succeeds — breaker resets
    const r2 = await registry.execute("flipflop", {});
    expect(r2.success).toBe(true);

    // Breaker should be CLOSED again
    const status = registry.getBreakerStatus("flipflop")!;
    expect(status.failureCount).toBe(0);
    expect(status.available).toBe(true);
  });

  it("remove unregisters tool and breaker", () => {
    const registry = new ToolRegistry();
    registry.register(successTool);
    expect(registry.remove("success")).toBe(true);
    expect(registry.has("success")).toBe(false);
  });

  it("registerMany registers multiple tools", () => {
    const registry = new ToolRegistry();
    registry.registerMany([successTool, failingTool]);
    expect(registry.count).toBe(2);
  });
});
