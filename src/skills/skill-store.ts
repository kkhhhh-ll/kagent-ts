import * as fs from "fs";
import * as path from "path";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * A directory entry descriptor (abstracted from Node.js `fs.Dirent`).
 * Allows non-filesystem backends to return file listings without depending
 * on Node.js internals.
 */
export interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

// ─── SkillStore Interface ──────────────────────────────────────────────────

/**
 * Storage backend for skills (SKILL.md files).
 *
 * Implementations:
 * - {@link FileSystemSkillStore} — local directory of SKILL.md files (default)
 * - Custom implementations (database, object storage, etc.) by implementing
 *   this interface and passing to {@link SkillManager}.
 */
export interface SkillStore {
  /**
   * Get the root directory path for skills.
   */
  getDir(): string;

  /**
   * List subdirectory entries in the skills directory.
   * Each subdirectory represents one skill. Returns empty array if
   * the directory doesn't exist or can't be read.
   */
  listSkillDirs(): DirEntry[];

  /**
   * Read the SKILL.md content from a skill subdirectory.
   * Returns `null` if the file doesn't exist or can't be read.
   * @param dirName The subdirectory basename.
   */
  readSkillMd(dirName: string): string | null;

  /**
   * List reference files (*.md, *.txt) in a skill's reference/ subdirectory.
   * Returns empty array if the directory doesn't exist.
   * @param dirName The skill subdirectory basename.
   */
  listReferenceFiles(dirName: string): DirEntry[];

  /**
   * Read a reference file from a skill's reference/ subdirectory.
   * @param dirName The skill subdirectory basename.
   * @param fileName The reference file name.
   */
  readReferenceFile(dirName: string, fileName: string): string | null;

  /**
   * Write a SKILL.md file for a skill.
   * Creates parent directories as needed.
   * @param dirName The skill subdirectory basename.
   * @param content The SKILL.md content (frontmatter + body).
   */
  writeSkill(dirName: string, content: string): Promise<void>;
}

// ─── FileSystemSkillStore ──────────────────────────────────────────────────

/**
 * File-system backed skill storage.
 *
 * Expected directory structure:
 * ```
 * skills/
 * ├── <skill-name>/
 * │   ├── SKILL.md          # Frontmatter (metadata) + body (system prompt)
 * │   └── reference/        # Optional reference docs (*.md, *.txt)
 * ```
 */
export class FileSystemSkillStore implements SkillStore {
  private directory: string;

  constructor(directory?: string) {
    this.directory = path.resolve(directory ?? "./skills");
  }

  // ─── SkillStore Implementation ────────────────────────────────────────

  getDir(): string {
    return this.directory;
  }

  listSkillDirs(): fs.Dirent[] {
    try {
      return fs.readdirSync(this.directory, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  readSkillMd(dirName: string): string | null {
    try {
      const skillMdPath = path.join(this.directory, dirName, "SKILL.md");
      return fs.readFileSync(skillMdPath, "utf-8");
    } catch {
      return null;
    }
  }

  listReferenceFiles(dirName: string): fs.Dirent[] {
    try {
      const refDir = path.join(this.directory, dirName, "reference");
      return fs.readdirSync(refDir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  readReferenceFile(dirName: string, fileName: string): string | null {
    try {
      const refPath = path.join(this.directory, dirName, "reference", fileName);
      return fs.readFileSync(refPath, "utf-8");
    } catch {
      return null;
    }
  }

  async writeSkill(dirName: string, content: string): Promise<void> {
    const skillDir = path.join(this.directory, dirName);
    await fs.promises.mkdir(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, "SKILL.md");
    await fs.promises.writeFile(skillMdPath, content, "utf-8");
  }
}
