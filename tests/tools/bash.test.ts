import { describe, it, expect } from "vitest";
import { BashTool } from "../../src/tools/builtin/bash";

describe("BashTool", () => {
  it("executes a simple echo command", async () => {
    const result = await BashTool.execute({ command: "echo hello" });
    expect(result).toContain("(exit code: 0)");
    expect(result).toContain("hello");
  });

  it("returns error for empty command", async () => {
    const result = await BashTool.execute({ command: "" });
    expect(result).toContain("Error: Command must not be empty");
  });

  it("captures stderr", async () => {
    const result = await BashTool.execute({ command: "echo err >&2" });
    expect(result).toContain("stderr");
    expect(result).toContain("err");
  });

  it("reports non-zero exit code", async () => {
    // exit 1 should give exit code 1
    const result = await BashTool.execute({ command: "exit 1" });
    expect(result).toContain("(exit code: 1)");
  });

  it("requires approval", () => {
    expect(BashTool.requireApproval).toBe(true);
  });
});
