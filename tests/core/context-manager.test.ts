import { describe, it, expect } from "vitest";
import { ContextManager } from "../../src/context/context-manager";
import { Role } from "../../src/messages/types";

describe("ContextManager", () => {
  it("starts with empty messages", () => {
    const cm = new ContextManager();
    const state = cm.getState();
    expect(state.messageCount).toBe(0);
    expect(state.isCompressed).toBe(false);
  });

  it("addMessage appends and timestamps", () => {
    const cm = new ContextManager();
    cm.addMessage({ role: Role.User, content: "hello" });
    const msgs = cm.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("hello");
    expect(msgs[0].timestamp).toBeDefined();
  });

  it("setSystemMessage prepends to context", () => {
    const cm = new ContextManager();
    cm.setSystemMessage("System prompt");
    cm.addMessage({ role: Role.User, content: "hi" });
    const ctx = cm.getContextMessages();
    expect(ctx).toHaveLength(2);
    expect(ctx[0].role).toBe(Role.System);
    expect(ctx[0].content).toBe("System prompt");
  });

  it("clear removes messages but preserves system message", () => {
    const cm = new ContextManager();
    cm.setSystemMessage("Keep me");
    cm.addMessage({ role: Role.User, content: "hello" });
    cm.clear();
    expect(cm.getMessages()).toHaveLength(0);
    // System message still present in context
    const ctx = cm.getContextMessages();
    expect(ctx).toHaveLength(1);
    expect(ctx[0].content).toBe("Keep me");
  });

  it("getCurrentTokens returns non-zero value", () => {
    const cm = new ContextManager();
    cm.setSystemMessage("Hello world, this is a system prompt.");
    cm.addMessage({ role: Role.User, content: "Hi there!" });
    const tokens = cm.getCurrentTokens();
    expect(tokens).toBeGreaterThan(0);
  });

  it("shouldCompress returns false when under threshold", () => {
    const cm = new ContextManager({ maxTokens: 128000, compressionThreshold: 100000 });
    cm.addMessage({ role: Role.User, content: "short message" });
    expect(cm.shouldCompress()).toBe(false);
  });
});
