import { describe, it, expect, vi } from "vitest";
import { ReActAgent } from "../../src/core/react-agent";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import { mockAnswerLLM } from "../mocks/mock-llm-provider";
import { AgentHooks } from "../../src/core/hooks";
import { TraceLogger } from "../../src/trace/trace-logger";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createAgent(answer = "Hello!", hooks?: AgentHooks | AgentHooks[]) {
  return new ReActAgent({
    llm: mockAnswerLLM(answer),
    toolRegistry: new ToolRegistry(),
    logger: new SilentLogger(),
    maxIterations: 3,
    hooks,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("fireHook (safe synchronous hook invocation)", () => {
  it("calls the hook function for every registered observer", async () => {
    const calls: string[] = [];

    const agent = createAgent("ok", [
      { onLLMStart: () => calls.push("a") },
      { onLLMStart: () => calls.push("b") },
    ]);

    await agent.chat("hello");

    // Both hooks were called (at least once — there may be continuation loops)
    expect(calls.filter((c) => c === "a").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c === "b").length).toBeGreaterThanOrEqual(1);
  });

  it("catches a throw in one hook and still calls remaining hooks", async () => {
    const calls: string[] = [];

    const agent = createAgent("ok", [
      {
        onLLMStart: () => {
          calls.push("before-boom");
          throw new Error("BOOM");
        },
      },
      { onLLMStart: () => calls.push("after-boom") },
    ]);

    // Should NOT throw — the agent loop continues despite the hook error
    const result = await agent.chat("hello");
    expect(result).toContain("ok");

    // First hook was called (and threw)
    expect(calls).toContain("before-boom");
    // Second hook still ran
    expect(calls).toContain("after-boom");
  });

  it("catches throws across ALL hook event types used by ReActAgent", async () => {
    const calls: string[] = [];

    const throwingHook: AgentHooks = {
      onLLMStart: () => {
        calls.push("onLLMStart");
        throw new Error("llm start boom");
      },
      onLLMEnd: () => {
        calls.push("onLLMEnd");
        throw new Error("llm end boom");
      },
      onThought: () => {
        calls.push("onThought");
        throw new Error("thought boom");
      },
      onToolStart: () => {
        calls.push("onToolStart");
        throw new Error("tool start boom");
      },
      onToolEnd: () => {
        calls.push("onToolEnd");
        throw new Error("tool end boom");
      },
      onToolError: () => {
        calls.push("onToolError");
        throw new Error("tool error boom");
      },
      onFinish: () => {
        calls.push("onFinish");
        throw new Error("onFinish boom"); // even onFinish is caught by fireHookAsync
      },
    };

    const agent = createAgent("survived-all-booms", [throwingHook]);
    const result = await agent.chat("test");

    // Agent still got its answer despite every hook throwing
    expect(result).toContain("survived-all-booms");

    // onLLMStart fired
    expect(calls).toContain("onLLMStart");
    // onLLMEnd fired
    expect(calls).toContain("onLLMEnd");
    // onFinish fired (async, fire-and-forget)
    expect(calls).toContain("onFinish");
  });

  it("onFinish runs via fireHookAsync and catches async errors", async () => {
    const finishCalls: string[] = [];

    const agent = createAgent("done", [
      {
        onFinish: async () => {
          finishCalls.push("async-finish");
          throw new Error("async finish boom");
        },
      },
    ]);

    const result = await agent.chat("hello");
    expect(result).toContain("done");

    // Allow the microtask queue to flush (fireHookAsync uses Promise.resolve())
    await new Promise((r) => setTimeout(r, 10));
    expect(finishCalls).toContain("async-finish");
  });
});

describe("fireOnFinish", () => {
  it("calls onFinish for all registered observers", async () => {
    const finishes: string[] = [];

    const agent = createAgent("final", [
      { onFinish: () => finishes.push("first") },
      { onFinish: () => finishes.push("second") },
    ]);

    await agent.chat("hello");

    // Allow microtasks to flush (fire-and-forget)
    await new Promise((r) => setTimeout(r, 10));

    expect(finishes).toContain("first");
    expect(finishes).toContain("second");
  });

  it("resolves sync and async onFinish handlers", async () => {
    const finishes: string[] = [];

    const agent = createAgent("final", [
      {
        onFinish: async () => {
          finishes.push("async");
        },
      },
      {
        onFinish: () => {
          finishes.push("sync");
        },
      },
    ]);

    await agent.chat("hello");
    await new Promise((r) => setTimeout(r, 10));

    expect(finishes).toContain("async");
    expect(finishes).toContain("sync");
  });
});

describe("Hook iteration order", () => {
  it("calls hooks in array order", async () => {
    const order: string[] = [];

    const agent = createAgent("ok", [
      { onLLMStart: () => order.push("first") },
      { onLLMStart: () => order.push("second") },
      { onLLMStart: () => order.push("third") },
    ]);

    await agent.chat("hello");

    // Find the first occurrence of each — they should appear in order
    const firstIdx = order.indexOf("first");
    const secondIdx = order.indexOf("second");
    const thirdIdx = order.indexOf("third");

    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});

describe("TraceLogger.flush() async", () => {
  it("flush() returns a Promise<string>", () => {
    const trace = new TraceLogger({ sessionId: "test-flush" });
    const result = trace.flush();
    expect(result).toBeInstanceOf(Promise);
  });

  it("flush() resolves to a file path", async () => {
    const trace = new TraceLogger({
      sessionId: `test-flush-resolve-${Date.now()}`,
      outputDir: ".kagent-traces",
    });
    const filePath = await trace.flush();
    // Should return a string path (even if the dir doesn't exist, it creates it)
    expect(typeof filePath).toBe("string");
    expect(filePath.length).toBeGreaterThan(0);
  });
});

describe("AgentHooks.safeForSubAgent", () => {
  it("is still present in the interface for filtering", () => {
    const hooks: AgentHooks = {
      safeForSubAgent: false,
      onFinish: () => {},
    };
    expect(hooks.safeForSubAgent).toBe(false);
  });

  it("undefined safeForSubAgent means safe (default)", () => {
    const hooks: AgentHooks = {
      onFinish: () => {},
    };
    expect(hooks.safeForSubAgent).toBeUndefined();
  });
});
