/**
 * StreamingAnswerExtractor — incremental display filter for structured
 * LLM output.
 *
 * The agents instruct the LLM to emit a JSON envelope
 * (`{"thought": "...", "answer": "..."}`). Streaming that envelope raw
 * gives consumers escaped JSON (`\n`, `\"`) instead of the answer text.
 * This extractor is fed each content delta and returns only what should
 * be displayed:
 *
 * - Output that does NOT start with `{` is passed through verbatim
 *   (the model answered in plain text).
 * - For JSON output, everything before the `"answer"` string value is
 *   suppressed (the thought, tool-call envelopes), and the answer value
 *   is emitted incrementally with JSON string escapes decoded.
 * - Deltas may split anywhere — including in the middle of an escape
 *   sequence (`\` + `n`) or a `\uXXXX` unicode escape.
 *
 * One instance per LLM call. When `emitted` is false after the stream
 * ends (no answer key found — e.g. a thought-only tool round or
 * malformed JSON), the caller is responsible for yielding the parsed
 * answer as a fallback.
 */
export class StreamingAnswerExtractor {
  private mode: "detect" | "passthrough" | "search" | "answer" | "done" = "detect";
  /** Accumulates raw text while detecting / searching for the answer key. */
  private buffer = "";
  /** Holds an incomplete escape sequence split across deltas. */
  private pending = "";
  private _emitted = false;

  /** Matches the opening of the answer string value in the JSON envelope. */
  private static ANSWER_KEY = /"answer"\s*:\s*"/;

  /** Whether any display text has been produced so far. */
  get emitted(): boolean {
    return this._emitted;
  }

  /**
   * Feed one content delta; returns the text to display (may be "").
   */
  feed(delta: string): string {
    switch (this.mode) {
      case "passthrough":
        this._emitted = this._emitted || delta.length > 0;
        return delta;

      case "done":
        return "";

      case "detect": {
        this.buffer += delta;
        const trimmed = this.buffer.trimStart();
        if (trimmed.length === 0) return ""; // only whitespace so far
        if (trimmed[0] !== "{") {
          // Plain-text answer — flush the buffer and pass through from now on.
          this.mode = "passthrough";
          const out = this.buffer;
          this.buffer = "";
          this._emitted = this._emitted || out.length > 0;
          return out;
        }
        this.mode = "search";
        return this.searchAnswerKey("");
      }

      case "search":
        return this.searchAnswerKey(delta);

      case "answer":
        return this.decodeAnswer(delta);
    }
  }

  /** Look for `"answer": "` in the accumulated JSON prefix. */
  private searchAnswerKey(delta: string): string {
    this.buffer += delta;
    const match = StreamingAnswerExtractor.ANSWER_KEY.exec(this.buffer);
    if (!match) return "";
    this.mode = "answer";
    const rest = this.buffer.slice(match.index + match[0].length);
    this.buffer = "";
    return this.decodeAnswer(rest);
  }

  /**
   * Decode the JSON string value incrementally until the closing quote.
   * Incomplete trailing escapes are held in `pending` for the next delta.
   */
  private decodeAnswer(delta: string): string {
    const text = this.pending + delta;
    this.pending = "";
    let out = "";
    let i = 0;

    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        // Unescaped closing quote — answer complete, suppress the rest.
        this.mode = "done";
        break;
      }
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      // Escape sequence — may be split across deltas.
      if (i + 1 >= text.length) {
        this.pending = text.slice(i);
        break;
      }
      const esc = text[i + 1];
      if (esc === "u") {
        if (i + 6 > text.length) {
          this.pending = text.slice(i);
          break;
        }
        const hex = text.slice(i + 2, i + 6);
        const code = Number.parseInt(hex, 16);
        out += Number.isNaN(code) ? text.slice(i, i + 6) : String.fromCharCode(code);
        i += 6;
        continue;
      }
      const map: Record<string, string> = {
        '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f",
      };
      out += map[esc] ?? esc;
      i += 2;
    }

    this._emitted = this._emitted || out.length > 0;
    return out;
  }
}
