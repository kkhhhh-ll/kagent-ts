import { Tool } from "../types";
import { detectInjectionSignatures, buildInjectionWarning } from "../../security/boundaries";

const MAX_CHARS = 100_000;
const TIMEOUT_MS = 15_000;

/**
 * Strip HTML tags from text (simple regex-based approach — sufficient for
 * extracting readable content from most pages).
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .slice(0, MAX_CHARS);
}

export const WebFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a web page by URL and return its content as markdown-formatted text. " +
    "Use this to retrieve documentation, API responses, or any web resource. " +
    "The content is stripped of HTML tags and limited to 100,000 characters. " +
    "This is a read-only operation — no files or system state are modified.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full URL to fetch (must start with http:// or https://).",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default: 100,000).",
      },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? "");
    const maxChars = typeof args.maxChars === "number" ? Math.min(args.maxChars, MAX_CHARS) : MAX_CHARS;

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return `Error: Invalid URL "${url}". Make sure the URL starts with http:// or https://.`;
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return `Error: Unsupported protocol "${parsedUrl.protocol}". Only HTTP and HTTPS are supported.`;
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "kagent-ts/1.0 (web_fetch tool)",
          Accept: "text/html, application/xhtml+xml, text/plain",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText} when fetching "${url}".`;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();

      // Extract title
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : parsedUrl.hostname;

      // Strip HTML to get readable text
      const text = stripHtml(raw);
      const content = text.length > maxChars
        ? text.slice(0, maxChars) + `\n\n(Truncated — ${(text.length / 1024).toFixed(1)} KB total, showing first ${(maxChars / 1024).toFixed(1)} KB)`
        : text;

      const contentTypeNote = contentType.includes("text/html") ? "" : `\nContent-Type: ${contentType}`;

      // Scan for prompt-injection signatures in the fetched content
      const injectionPatterns = detectInjectionSignatures(content);
      const warning = buildInjectionWarning(injectionPatterns, `web_fetch:${url}`);

      return `${warning}# ${title}\n\nURL: ${url}${contentTypeNote}\n\n${content}`;
    } catch (err: unknown) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof DOMException || (err instanceof Error && err.name === "AbortError")) {
        return `Error: Request timed out after ${TIMEOUT_MS / 1000}s for URL "${url}".`;
      }

      return `Error fetching "${url}": ${message}`;
    }
  },
};
