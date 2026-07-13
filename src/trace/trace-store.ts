import * as fs from "fs";
import * as path from "path";

// ─── TraceStore Interface ──────────────────────────────────────────────────

/**
 * Storage backend for agent execution traces.
 *
 * Implementations:
 * - {@link FileSystemTraceStore} — local `.kagent-traces/` directory of HTML files (default)
 * - Custom implementations (S3, database blob storage, etc.) by implementing
 *   this interface and passing to {@link TraceLogger}.
 */
export interface TraceStore {
  /**
   * Ensure the output directory exists. Idempotent.
   */
  ensureDir(): void;

  /**
   * Write a trace HTML file.
   * @param sessionId The session identifier (used as filename).
   * @param htmlContent The full HTML content to write.
   */
  write(sessionId: string, htmlContent: string): void;

  /**
   * Get the output directory path.
   */
  getDir(): string;
}

// ─── FileSystemTraceStore ──────────────────────────────────────────────────

/**
 * File-system backed trace storage.
 *
 * Layout:
 * ```
 * {outputDir}/
 *   <sessionId>.html    ← self-contained trace HTML file
 * ```
 */
export class FileSystemTraceStore implements TraceStore {
  private outputDir: string;

  constructor(outputDir?: string) {
    this.outputDir = path.resolve(outputDir ?? ".kagent-traces");
  }

  // ─── TraceStore Implementation ────────────────────────────────────────

  ensureDir(): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  write(sessionId: string, htmlContent: string): void {
    this.ensureDir();
    const filePath = path.join(this.outputDir, `${sessionId}.html`);
    fs.writeFileSync(filePath, htmlContent, "utf-8");
  }

  getDir(): string {
    return this.outputDir;
  }
}
