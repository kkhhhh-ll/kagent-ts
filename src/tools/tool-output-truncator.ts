import * as fs from "fs";
import * as path from "path";

/**
 * Truncator for tool outputs that exceed a byte threshold.
 *
 * When a tool returns a very large result it fills the context window
 * and wastes tokens. This component saves the full result to disk and
 * returns a short preview + a file path, so the LLM can decide whether
 * to read the full content via the normal file-reading tools.
 */
export class ToolOutputTruncator {
  private maxBytes: number;
  private keepBytes: number;
  private outputDir: string;

  /**
   * @param maxBytes   Outputs larger than this are truncated (0 = off).
   * @param keepBytes  How many bytes to keep from the start of the output
   *                   when truncating.
   * @param outputDir  Directory where full outputs are saved.
   */
  constructor(
    maxBytes: number = 0,
    keepBytes: number = 2048,
    outputDir?: string,
  ) {
    this.maxBytes = maxBytes;
    this.keepBytes = keepBytes;
    this.outputDir = path.resolve(outputDir ?? ".kagent-tool-outputs");
  }

  /**
   * Whether truncation is active (maxBytes > 0).
   */
  get enabled(): boolean {
    return this.maxBytes > 0;
  }

  /**
   * Truncate a tool result string if it exceeds the configured threshold.
   *
   * - If the result is within `maxBytes`, returns it unchanged.
   * - Otherwise saves the full output to disk and returns the first
   *   `keepBytes` bytes + a marker pointing to the saved file.
   *
   * @param toolName  Name of the tool that produced this result.
   * @param result    The raw result string from tool execution.
   */
  truncate(toolName: string, result: string): string {
    if (!this.enabled) return result;

    const byteLength = Buffer.byteLength(result, "utf-8");
    if (byteLength <= this.maxBytes) return result;

    // Ensure output directory exists
    fs.mkdirSync(this.outputDir, { recursive: true });

    // Generate a unique filename: toolname_<timestamp>_<hash>.txt
    const now = Date.now();
    const hash = djb2(toolName + now + result.slice(0, 128));
    const filename = `${sanitizeFilename(toolName)}_${now}_${hash}.txt`;
    const filePath = path.join(this.outputDir, filename);

    fs.writeFileSync(filePath, result, "utf-8");

    const preview = Buffer.from(result, "utf-8").toString("utf-8", 0, this.keepBytes);
    const keptBytes = Buffer.byteLength(preview, "utf-8");
    const truncatedSize = byteLength - keptBytes;
    const marker =
      `\n\n---\n` +
      `[Output truncated: ${(byteLength / 1024).toFixed(1)} KB total | ` +
      `showing first ${(keptBytes / 1024).toFixed(1)} KB | ` +
      `${(truncatedSize / 1024).toFixed(1)} KB truncated.]\n` +
      `[Full output saved to: ${filePath}]\n` +
      `[Use the read_file tool with file_path="${filePath}" to read the complete output.]`;

    return preview + marker;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Simple djb2 hash (non-crypto, for filename dedup). */
function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Replace non-filename-safe characters. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}
