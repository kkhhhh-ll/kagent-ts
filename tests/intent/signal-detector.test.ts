import { describe, it, expect } from "vitest";
import { detectSignals, planHasRiskyOps } from "../../src/intent/signal-detector";
import type { RiskLevel } from "../../src/intent/signal-detector";

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

    // ── CJK risk keywords ───────────────────────────────────────────────

    describe("CJK risk keywords", () => {
      it("detects CJK high-risk keywords", () => {
        expect(detectSignals("删除数据库").riskLevel).toBe("high");
        expect(detectSignals("刪除所有使用者資料").riskLevel).toBe("high");
        expect(detectSignals("销毁临时文件").riskLevel).toBe("high");
        expect(detectSignals("格式化硬盘").riskLevel).toBe("high");
        expect(detectSignals("清空日志表").riskLevel).toBe("high");
        expect(detectSignals("丢弃更改").riskLevel).toBe("high");
        expect(detectSignals("强制推送到主分支").riskLevel).toBe("high");
        expect(detectSignals("硬重置分支").riskLevel).toBe("high");
      });

      it("detects CJK low-risk keywords", () => {
        expect(detectSignals("部署到生产环境").riskLevel).toBe("low");
        expect(detectSignals("发布新版本").riskLevel).toBe("low");
        expect(detectSignals("上线新功能").riskLevel).toBe("low");
        expect(detectSignals("迁移数据库").riskLevel).toBe("low");
        expect(detectSignals("重置配置").riskLevel).toBe("low");
      });

      it("CJK high-risk takes precedence over CJK low-risk", () => {
        expect(detectSignals("部署应用并删除旧数据").riskLevel).toBe("high");
      });
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

      it("negation only suppresses risk keywords in its own comma-separated clause", () => {
        // "don't delete" is negated, but "deploy" in the next clause should still be detected
        expect(
          detectSignals("don't delete the database, deploy to production").riskLevel,
        ).toBe("low");
      });

      it("negation only suppresses risk keywords in its own semicolon-separated clause", () => {
        expect(
          detectSignals("don't drop tables; migrate the data carefully").riskLevel,
        ).toBe("low");
      });

      it("negation with Chinese clause separators: negation stays scoped", () => {
        // Chinese comma ， delimits clauses — negation in first clause shouldn't
        // suppress "deploy" in the second clause
        expect(
          detectSignals("不要强制推送，deploy 到生产环境").riskLevel,
        ).toBe("low");
      });

      it("contrastive conjunction 'but' scopes negation to its own clause", () => {
        // "don't delete" is negated, but "format" in the contrasting clause
        // should still be detected as high-risk
        expect(
          detectSignals("don't delete the config but do format the disk").riskLevel,
        ).toBe("high");
      });

      it("contrastive conjunction 'however' scopes negation to its own clause", () => {
        expect(
          detectSignals("don't drop the table however you can deploy to production").riskLevel,
        ).toBe("low");
      });

      it("contrastive conjunction 'yet' scopes negation correctly", () => {
        expect(
          detectSignals("never delete the cache yet format the logs regularly").riskLevel,
        ).toBe("high");
      });

      it("CJK contrastive conjunction '但是' scopes negation to its own clause", () => {
        // "不要删除" is negated, but "格式化" in the contrasting clause
        // should still be detected as high-risk
        expect(
          detectSignals("不要删除配置文件，但是要格式化磁盘").riskLevel,
        ).toBe("high");
      });

      it("CJK contrastive conjunction '然而' scopes negation correctly", () => {
        expect(
          detectSignals("不要强制推送，然而可以部署到生产环境").riskLevel,
        ).toBe("low");
      });

      it("CJK contrastive conjunction '但' scopes negation correctly", () => {
        expect(
          detectSignals("不要删除数据库但可以重置配置").riskLevel,
        ).toBe("low");
      });
    });
  });

});

// ─── planHasRiskyOps ─────────────────────────────────────────────────────────

describe("planHasRiskyOps", () => {
  it("returns 'low' for safe non-empty plans (conservative default)", () => {
    const plan = ["read the config file", "parse the JSON", "output the result"];
    // Non-empty plans default to "low" — never "none" per JSDoc contract
    expect(planHasRiskyOps(plan)).toBe("low");
  });

  it("returns 'none' for empty plans", () => {
    expect(planHasRiskyOps([])).toBe("none");
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

  it("returns 'low' for fully negated high-risk plans (non-empty conservative default)", () => {
    // "don't delete" + "just migrate" → both negated or safe, computeRiskLevel
    // returns "none", but planHasRiskyOps defaults to "low" for non-empty plans
    expect(planHasRiskyOps(["don't delete any records", "just migrate the data"])).toBe("low");
  });
});
