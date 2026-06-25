import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SubAgentLoader } from "../../src/subagent/subagent-loader";
import { SilentLogger } from "../../src/logging/logger";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-loader-test-"));
}

/** Write an AGENT.md file into `<dir>/<name>/AGENT.md`. */
function writeAgentMd(
  dir: string,
  name: string,
  frontmatter: string,
  body = "Default prompt body.",
): void {
  const agentDir = path.join(dir, name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "AGENT.md"),
    `---\n${frontmatter}\n---\n${body}`,
    "utf-8",
  );
}

describe("SubAgentLoader", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Scan ────────────────────────────────────────────────────────────

  it("scans directory and loads definitions", () => {
    writeAgentMd(dir, "reviewer", [
      "name: code-reviewer",
      "description: Reviews code for bugs",
      "tools: read_file, grep_search",
      "skills: code-review",
    ].join("\n"));

    writeAgentMd(dir, "tester", [
      "name: test-runner",
      "description: Runs tests",
      "tools: bash",
    ].join("\n"));

    const loader = new SubAgentLoader(dir, undefined, new SilentLogger());
    const defs = loader.scan();

    expect(defs).toHaveLength(2);

    const reviewer = defs.find((d) => d.name === "code-reviewer")!;
    expect(reviewer).toBeTruthy();
    expect(reviewer.description).toBe("Reviews code for bugs");
    expect(reviewer.tools).toEqual(["read_file", "grep_search"]);
    expect(reviewer.skills).toEqual(["code-review"]);
    expect(reviewer.systemPrompt).toBe("Default prompt body.");

    const tester = defs.find((d) => d.name === "test-runner")!;
    expect(tester).toBeTruthy();
    expect(tester.tools).toEqual(["bash"]);
    expect(tester.skills).toEqual([]);
  });

  it("returns empty array for nonexistent directory", () => {
    const loader = new SubAgentLoader(
      path.join(dir, "nonexistent"),
      undefined,
      new SilentLogger(),
    );
    expect(loader.scan()).toEqual([]);
  });

  it("skips subdirectories without AGENT.md", () => {
    // Create directory without AGENT.md
    fs.mkdirSync(path.join(dir, "empty-folder"), { recursive: true });

    writeAgentMd(dir, "valid", [
      "name: valid-agent",
      "description: Has AGENT.md",
    ].join("\n"));

    const loader = new SubAgentLoader(dir, undefined, new SilentLogger());
    const defs = loader.scan();

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("valid-agent");
  });

  it("skips dot-directories", () => {
    fs.mkdirSync(path.join(dir, ".hidden"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".hidden", "AGENT.md"),
      "---\nname: hidden-agent\n---\n",
    );

    const loader = new SubAgentLoader(dir, undefined, new SilentLogger());
    expect(loader.scan()).toEqual([]);
  });

  it("skips definition without name in frontmatter", () => {
    writeAgentMd(dir, "no-name", [
      "description: Missing the name field",
    ].join("\n"));

    const loader = new SubAgentLoader(dir, undefined, new SilentLogger());
    expect(loader.scan()).toEqual([]);
  });

  // ── loadDefinition ──────────────────────────────────────────────────

  it("loadDefinition returns null for missing directory", () => {
    const loader = new SubAgentLoader(dir, undefined, new SilentLogger());
    expect(loader.loadDefinition("nonexistent")).toBeNull();
  });

  it("loadDefinition returns a definition for a valid agent dir", () => {
    writeAgentMd(dir, "helper", [
      "name: helper-agent",
      "description: A helper",
      "tools: read_file",
      "skills: summarizer, analyst",
    ].join("\n"), "You are a helper agent.");

    const loader = new SubAgentLoader(dir, undefined, new SilentLogger());
    const def = loader.loadDefinition("helper")!;

    expect(def).toBeTruthy();
    expect(def.name).toBe("helper-agent");
    expect(def.tools).toEqual(["read_file"]);
    expect(def.skills).toEqual(["summarizer", "analyst"]);
    expect(def.systemPrompt).toBe("You are a helper agent.");
  });

  // ── Empty frontmatter defaults ──────────────────────────────────────

  it("handles empty frontmatter with defaults", () => {
    writeAgentMd(dir, "minimal", "name: min\n", "System prompt.");

    const loader = new SubAgentLoader(dir, undefined, new SilentLogger());
    const defs = loader.scan();

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("min");
    expect(defs[0].description).toBe("");
    expect(defs[0].tools).toEqual([]);
    expect(defs[0].skills).toEqual([]);
  });

  // ── getDirectory ────────────────────────────────────────────────────

  it("getDirectory returns the resolved path", () => {
    const loader = new SubAgentLoader("/some/path", undefined, new SilentLogger());
    expect(loader.getDirectory()).toBe(path.resolve("/some/path"));
  });

  // ── Custom agent file name ──────────────────────────────────────────

  it("uses custom agent file name", () => {
    const agentDir = path.join(dir, "custom");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "MY_AGENT.md"),
      "---\nname: custom-agent\n---\nCustom body.",
      "utf-8",
    );

    const loader = new SubAgentLoader(dir, "MY_AGENT.md", new SilentLogger());
    const defs = loader.scan();

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("custom-agent");
  });
});
