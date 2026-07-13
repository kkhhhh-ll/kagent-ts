/**
 * Built-in RAG tools registered into the main agent's ToolRegistry.
 *
 * These tools are callable by the LLM:
 * - `search_knowledge`      — semantic search over the indexed knowledge base
 * - `list_knowledge_documents` — list available document paths
 * - `ingest_knowledge`      — add documents at runtime (URL, text, or file)
 */

import type { Tool } from "../tools/types";
import type { RAGManager } from "./rag-manager";
import type { DocumentSource } from "./rag-types";

/**
 * Create the `search_knowledge` tool.
 *
 * The LLM calls this to find relevant context from the indexed document
 * store before generating an answer.
 */
export function createSearchKnowledgeTool(manager: RAGManager): Tool {
  return {
    name: "search_knowledge",
    description:
      "Search the knowledge base for documents relevant to a query. " +
      "Use this when you need context from the indexed documents to answer " +
      "a question. Returns the top matching text chunks with source paths " +
      "and similarity scores.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The natural-language search query. Be specific — include key terms and concepts.",
        },
      },
      required: ["query"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const query = String(args.query ?? "").trim();
      if (!query) {
        return "Error: `query` is required and must be non-empty.";
      }

      if (!manager.indexed || manager.chunkCount === 0) {
        return "The knowledge base is empty. No documents have been indexed yet.";
      }

      try {
        const results = await manager.search(query);
        return manager.formatResults(results);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error searching knowledge base: ${message}`;
      }
    },
  };
}

/**
 * Create the `list_knowledge_documents` tool.
 *
 * The LLM can call this to discover what documents are available before
 * performing a targeted search.
 */
export function createListKnowledgeDocumentsTool(manager: RAGManager): Tool {
  return {
    name: "list_knowledge_documents",
    description:
      "List all documents currently indexed in the knowledge base. " +
      "Use this to see what topics are covered before searching.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (_args: Record<string, unknown>): Promise<string> => {
      if (!manager.indexed) {
        return "The knowledge base has not been indexed yet.";
      }

      const paths = manager.documentPaths;
      if (paths.length === 0) {
        return "No documents in the knowledge base.";
      }

      const lines: string[] = [
        `${paths.length} document(s) indexed:\n`,
        ...paths.map((p) => `- ${p}`),
      ];

      return lines.join("\n");
    },
  };
}

/**
 * Create the `ingest_knowledge` tool.
 *
 * The LLM calls this to add new documents to the knowledge base at runtime.
 * Supports three source types:
 * - `url`  — fetch a web page, strip HTML, index the content
 * - `text` — index inline text (e.g., user-provided content, LLM summary)
 * - `file` — index a local file by path
 *
 * Documents added this way are immediately searchable via `search_knowledge`.
 */
export function createIngestKnowledgeTool(manager: RAGManager): Tool {
  return {
    name: "ingest_knowledge",
    description:
      "Add a document to the knowledge base so it becomes searchable. " +
      "Use this when you encounter useful information that should be " +
      "available in future searches — e.g., a fetched web page, a user " +
      "provided document, or a summary you've generated.\n\n" +
      "Supports three source types:\n" +
      "- `url`: fetch a web page and index its text content\n" +
      "- `text`: index inline text directly (provide a descriptive `title`)\n" +
      "- `file`: index a local file (must be .md, .txt, or .json)\n\n" +
      "Returns the document path and chunk count on success.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["url", "text", "file"],
          description: "Where the content comes from.",
        },
        url: {
          type: "string",
          description: "The URL to fetch (required when source is 'url').",
        },
        content: {
          type: "string",
          description: "The text content to index (required when source is 'text').",
        },
        title: {
          type: "string",
          description:
            "A human-readable title for the document. " +
            "Required for 'text' source; optional for 'url' (auto-detected from page title).",
        },
        filePath: {
          type: "string",
          description: "Path to the local file to index (required when source is 'file').",
        },
      },
      required: ["source"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const source = String(args.source ?? "").trim() as DocumentSource["type"];

      if (!["url", "text", "file"].includes(source)) {
        return `Error: \`source\` must be one of: "url", "text", "file". Got: "${source}".`;
      }

      let docSource: DocumentSource;

      switch (source) {
        case "url": {
          const url = String(args.url ?? "").trim();
          if (!url) {
            return "Error: \`url\` is required when source is 'url'.";
          }

          // Basic URL validation
          try {
            new URL(url);
          } catch {
            return `Error: Invalid URL "${url}". Make sure it starts with http:// or https://.`;
          }

          docSource = { type: "url", url, title: args.title ? String(args.title) : undefined };
          break;
        }
        case "text": {
          const content = String(args.content ?? "").trim();
          if (!content) {
            return "Error: \`content\` is required when source is 'text'.";
          }
          const title = String(args.title ?? "").trim();
          if (!title) {
            return "Error: \`title\` is required when source is 'text'.";
          }
          docSource = { type: "text", content, title };
          break;
        }
        case "file": {
          const filePath = String(args.filePath ?? "").trim();
          if (!filePath) {
            return "Error: \`filePath\` is required when source is 'file'.";
          }
          docSource = { type: "file", path: filePath };
          break;
        }
      }

      try {
        const doc = await manager.addFromSource(docSource);
        if (!doc) {
          return "No content was extracted from the source. The document is empty or unreadable.";
        }

        return (
          `Document ingested successfully:\n` +
          `- Path: ${doc.path}\n` +
          `- Chunks: ${doc.chunks.length}\n` +
          `- Total documents in knowledge base: ${manager.documentCount}`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error ingesting document: ${message}`;
      }
    },
  };
}
