import { describe, it, expect } from "vitest";
import { detectSignals, planHasRiskyOps } from "../../src/intent/signal-detector";
import type { RiskLevel, TaskComplexity, AgentScenario } from "../../src/intent/signal-detector";

// ─── detectSignals ──────────────────────────────────────────────────────────

describe("detectSignals", () => {
  // ── Remember ──────────────────────────────────────────────────────────

  describe("wantsRemember", () => {
    it("detects English remember keywords", () => {
      expect(detectSignals("Please remember to use pnpm").wantsRemember).toBe(true);
      expect(detectSignals("save this for later").wantsRemember).toBe(true);
    });

    it("detects Chinese remember keywords", () => {
      expect(detectSignals("请记住使用 pnpm").wantsRemember).toBe(true);
      expect(detectSignals("把这个保存下来").wantsRemember).toBe(true);
      expect(detectSignals("記錄下來").wantsRemember).toBe(true);
    });

    it("returns false when no remember intent", () => {
      expect(detectSignals("write a function").wantsRemember).toBe(false);
    });
  });

  // ── Risk Level ────────────────────────────────────────────────────────

  describe("riskLevel", () => {
    it("returns 'none' for safe input", () => {
      expect(detectSignals("read the file and explain it").riskLevel).toBe("none");
      expect(detectSignals("help me write a function").riskLevel).toBe("none");
    });

    it("returns 'low' for routine ops (deploy, release, migrate, reset)", () => {
      const lowCases = [
        "deploy the app to production",
        "release a new version",
        "publish the package",
        "ship the feature",
        "migrate the database",
        "reset the configuration",
      ];
      for (const input of lowCases) {
        expect(detectSignals(input).riskLevel).toBe("low");
      }
    });

    it("returns 'high' for destructive ops (delete, drop, force push, rm -rf)", () => {
      const highCases = [
        "delete the production database",
        "drop the users table",
        "destroy all instances",
        "purge the cache",
        "format the disk",
        "truncate the logs",
        "force push to main",
        "hard reset the branch",
        "rm -rf /var/log",
      ];
      for (const input of highCases) {
        expect(detectSignals(input).riskLevel).toBe("high");
      }
    });

    it("high-risk takes precedence over low-risk", () => {
      expect(detectSignals("deploy the app and delete old data").riskLevel).toBe("high");
    });

    // ── Negation ──────────────────────────────────────────────────────

    describe("negation filtering", () => {
      it("ignores risky keywords preceded by negation markers", () => {
        expect(detectSignals("不要删除这个文件").riskLevel).toBe("none");
        expect(detectSignals("千万别 force push").riskLevel).toBe("none");
        expect(detectSignals("don't delete anything").riskLevel).toBe("none");
        expect(detectSignals("do not drop the table").riskLevel).toBe("none");
        expect(detectSignals("never force push to main").riskLevel).toBe("none");
      });

      it("demotes risk when negated high-risk keyword present alongside non-negated low-risk", () => {
        // Negation is sentence-scoped: use period to separate negated from non-negated
        // "don't delete" is negated (excluded), "deploy" in separate sentence → low
        expect(detectSignals("deploy the app. But don't delete old files.").riskLevel).toBe("low");
      });

      it("still detects risk in non-negated sentences", () => {
        // First sentence has negation, second doesn't
        expect(detectSignals("don't delete files. Please drop the table.").riskLevel).toBe("high");
      });

      it("handles Chinese negation: 禁止, 切勿, 请勿, 避免", () => {
        expect(detectSignals("禁止删除数据库").riskLevel).toBe("none");
        expect(detectSignals("切勿执行 delete 操作").riskLevel).toBe("none");
        expect(detectSignals("请勿 reset 配置").riskLevel).toBe("none");
        expect(detectSignals("避免使用 force push").riskLevel).toBe("none");
      });

      it("can't / cannot / shouldn't negate risky keywords", () => {
        expect(detectSignals("you can't delete this").riskLevel).toBe("none");
        expect(detectSignals("we cannot drop the table").riskLevel).toBe("none");
        expect(detectSignals("you shouldn't format it").riskLevel).toBe("none");
      });
    });
  });

  // ── Scenarios (multi-label) ───────────────────────────────────────────

  describe("scenarios", () => {
    it("returns empty array when no scenario matches", () => {
      expect(detectSignals("hello world").scenarios).toEqual([]);
    });

    it("detects single scenario", () => {
      expect(detectSignals("debug the authentication bug").scenarios).toEqual(["debugging"]);
      expect(detectSignals("deploy to production").scenarios).toEqual(["deployment"]);
      expect(detectSignals("refactor the user module").scenarios).toEqual(["refactoring"]);
    });

    it("detects multiple scenarios (multi-label)", () => {
      const result = detectSignals("find the bug in auth.ts and fix it");
      expect(result.scenarios).toContain("debugging");
      expect(result.scenarios).toContain("file-search");
      expect(result.scenarios.length).toBeGreaterThanOrEqual(2);
    });

    it("detects code-write + testing together", () => {
      const result = detectSignals("write tests for the auth module");
      expect(result.scenarios).toContain("code-write");
      expect(result.scenarios).toContain("testing");
    });

    it("detects deployment + configuration together", () => {
      const result = detectSignals("configure the env and deploy");
      expect(result.scenarios).toContain("configuration");
      expect(result.scenarios).toContain("deployment");
    });

    it("detects Chinese keywords", () => {
      expect(detectSignals("搜索并修复bug").scenarios).toContain("file-search");
      expect(detectSignals("請閱讀這份代碼").scenarios).toContain("code-read");
      expect(detectSignals("创建一个新的API").scenarios).toContain("code-write");
    });
  });

  // ── Complexity ────────────────────────────────────────────────────────

  describe("complexity", () => {
    it("returns 'simple' for short, single-task queries", () => {
      expect(detectSignals("read auth.ts").complexity).toBe("simple");
      expect(detectSignals("fix the bug").complexity).toBe("simple");
    });

    it("returns 'moderate' for medium-length queries with file refs and multi-task", () => {
      const input =
        "Look at auth.ts and user.ts. Also fix the config. Write a summary.";
      const result = detectSignals(input);
      // 2 file refs + 3 sentences + "also" → score ≈ 3 → moderate
      expect(result.complexity).toBe("moderate");
    });

    it("returns 'complex' for long, multi-file, multi-step queries", () => {
      const input =
        "Refactor the entire authentication system. Migrate from JWT to session-based auth. " +
        "Update auth.ts, session.ts, middleware.ts, config.ts, index.ts, user.ts, " +
        "and all test files. Also update the deployment configuration and documentation. " +
        "Make sure backward compatibility is maintained for existing API consumers.";
      const result = detectSignals(input);
      expect(result.complexity).toBe("complex");
    });

    it("broad-scope keywords increase score but don't alone make it complex", () => {
      // Short queries with broad keywords → moderate at most (score=1 → simple)
      // Need file refs or length to push it into moderate/complex territory
      expect(detectSignals("refactor the entire auth module in auth.ts user.ts").complexity).toBe("moderate");
    });

    it("detects multi-task connectors bumping complexity", () => {
      const input = "Update the login page. Also rewrite the database schema. Write tests for everything.";
      // 3 sentences (+1), length > 100 (+1), "also" (+1) → score 3 → moderate
      expect(detectSignals(input).complexity).toBe("moderate");
    });
  });

  // ── Full signal integration ───────────────────────────────────────────

  describe("integration", () => {
    it("returns complete signals for a complex, risky, multi-scenario query", () => {
      const input =
        "Find all bugs in the auth system, write fixes, and then deploy to production. " +
        "Don't delete any user data. Remember to log everything.";
      const signals = detectSignals(input);

      expect(signals.wantsRemember).toBe(true);
      // "deploy" is low-risk, "don't delete" is negated → only low
      expect(signals.riskLevel).toBe("low");
      // Multiple scenarios
      expect(signals.scenarios).toContain("file-search");
      expect(signals.scenarios).toContain("debugging");
      expect(signals.scenarios.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ─── planHasRiskyOps ─────────────────────────────────────────────────────────

describe("planHasRiskyOps", () => {
  it("returns 'none' for safe plans", () => {
    const plan = ["read the config file", "parse the JSON", "output the result"];
    expect(planHasRiskyOps(plan)).toBe("none");
  });

  it("returns 'low' for plans with low-risk keywords", () => {
    expect(planHasRiskyOps(["deploy to production"])).toBe("low");
    expect(planHasRiskyOps(["migrate the database"])).toBe("low");
    expect(planHasRiskyOps(["reset the cache"])).toBe("low");
  });

  it("returns 'high' for plans with high-risk keywords", () => {
    expect(planHasRiskyOps(["delete all records"])).toBe("high");
    expect(planHasRiskyOps(["force push to main"])).toBe("high");
    expect(planHasRiskyOps(["rm -rf the old directory"])).toBe("high");
  });

  it("returns 'high' for mixed high + low plans", () => {
    expect(planHasRiskyOps(["deploy the app", "delete old data"])).toBe("high");
  });

  it("returns 'none' for fully negated high-risk plans", () => {
    // "don't delete" covers the whole joined plan text → risk is excluded
    expect(planHasRiskyOps(["don't delete any records", "just migrate the data"])).toBe("none");
  });
});
