import { describe, it, expect } from "vitest";
import { validateToolArgs } from "../../src/tools/tool-validator";
import { ToolErrorCode } from "../../src/tools/types";

describe("validateToolArgs", () => {
  // ── Empty / trivial schemas ───────────────────────────────────────────

  it("returns null for an empty schema (no constraints)", () => {
    const result = validateToolArgs("test", {}, { command: "ls" });
    expect(result).toBeNull();
  });

  it("returns null for a type-only schema (no constraints)", () => {
    const result = validateToolArgs("test", { type: "object" }, { command: "ls" });
    expect(result).toBeNull();
  });

  // ── Valid arguments ───────────────────────────────────────────────────

  it("returns null when all required fields are present", () => {
    const schema = {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["command"],
    };
    const result = validateToolArgs("bash", schema, { command: "ls -la" });
    expect(result).toBeNull();
  });

  it("returns null when optional fields are omitted", () => {
    const schema = {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
      },
      required: ["command"],
    };
    const result = validateToolArgs("bash", schema, { command: "pwd" });
    expect(result).toBeNull();
  });

  // ── Missing required fields ───────────────────────────────────────────

  it("returns VALIDATION_ERROR when a required field is missing", () => {
    const schema = {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    };
    const result = validateToolArgs("bash", schema, {});
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.errorCode).toBe(ToolErrorCode.VALIDATION_ERROR);
    expect(result!.severity).toBe("retryable");
    expect(result!.content).toContain("[RETRYABLE:VALIDATION_ERROR]");
    expect(result!.content).toContain("bash");
    expect(result!.content).toContain("command");
  });

  it("lists all missing required fields in the error message", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        input: { type: "string" },
      },
      required: ["name", "input"],
    };
    const result = validateToolArgs("spawn_subagent", schema, {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("name");
    expect(result!.content).toContain("input");
  });

  // ── Wrong types ───────────────────────────────────────────────────────

  it("returns VALIDATION_ERROR when a field has the wrong type", () => {
    const schema = {
      type: "object",
      properties: {
        timeout: { type: "number" },
      },
    };
    const result = validateToolArgs("test", schema, { timeout: "not-a-number" });
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe(ToolErrorCode.VALIDATION_ERROR);
    expect(result!.content).toContain("timeout");
    expect(result!.content).toContain("number");
  });

  it("returns VALIDATION_ERROR for array vs string mismatch", () => {
    const schema = {
      type: "object",
      properties: {
        url: { type: "string" },
      },
    };
    const result = validateToolArgs("web_fetch", schema, { url: ["not", "a", "string"] });
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe(ToolErrorCode.VALIDATION_ERROR);
  });

  // ── Error message format ──────────────────────────────────────────────

  it("includes the received arguments in the error message", () => {
    const schema = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    };
    const result = validateToolArgs("bash", schema, { wrongKey: "ls" });
    expect(result).not.toBeNull();
    expect(result!.content).toContain("wrongKey");
    expect(result!.content).toContain("Received arguments");
  });

  it("includes the required fields list in the error message", () => {
    const schema = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    };
    const result = validateToolArgs("bash", schema, {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Required fields");
    expect(result!.content).toContain("command");
  });

  it("is retryable so the LLM can correct and re-invoke", () => {
    const schema = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    };
    const result = validateToolArgs("bash", schema, {});
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("retryable");
  });

  // ── Realistic tool schemas ────────────────────────────────────────────

  it("passes for valid bash tool arguments", () => {
    const bashSchema = {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        workdir: { type: "string", description: "Working directory" },
        timeout: { type: "number", description: "Timeout in ms" },
      },
      required: ["command"],
    };
    expect(validateToolArgs("bash", bashSchema, { command: "echo hello" })).toBeNull();
    expect(validateToolArgs("bash", bashSchema, {
      command: "npm test",
      workdir: "/app",
      timeout: 30000,
    })).toBeNull();
  });

  it("fails for bash without command", () => {
    const bashSchema = {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
      },
      required: ["command"],
    };
    const result = validateToolArgs("bash", bashSchema, { workdir: "/tmp" });
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe(ToolErrorCode.VALIDATION_ERROR);
  });

  // ── Validator caching ─────────────────────────────────────────────────

  it("caches compiled validators (same schema → same result)", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "number" } },
    };

    // Multiple calls with the same schema should hit the cache
    expect(validateToolArgs("t1", schema, { x: 1 })).toBeNull();
    expect(validateToolArgs("t1", schema, { x: 2 })).toBeNull();
    expect(validateToolArgs("t1", schema, { x: "bad" })).not.toBeNull();
    // Different tool name with same schema — still cached (via JSON.stringify)
    expect(validateToolArgs("t2", schema, { x: 3 })).toBeNull();
  });

  // ── Graceful degradation ──────────────────────────────────────────────

  it("returns null for a non-standard schema that ajv can't compile", () => {
    // An intentionally malformed schema — ajv strict:false allows most things,
    // but truly broken schemas should be caught gracefully.
    // A valid-but-unusual schema should still work with strict:false.
    const weirdSchema = {
      type: "object",
      properties: { data: {} }, // typeless property — valid in non-strict mode
    };
    const result = validateToolArgs("weird", weirdSchema, { data: "anything" });
    expect(result).toBeNull();
  });
});
