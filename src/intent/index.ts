// Signal detection — unified, zero-LLM user intent signals
export { detectSignals, planHasRiskyOps } from "./signal-detector";
export type {
  UserSignals,
  AgentScenario,
  RiskLevel,
  TaskComplexity,
} from "./signal-detector";

// Skill matching — keyword-based skill fast-path
export { matchSkills, buildMatchedSkillsPrompt } from "./skill-matcher";
export type { SkillMatch } from "./skill-matcher";
