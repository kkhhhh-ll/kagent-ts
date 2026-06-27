/**
 * Built-in RAG tools registered into the main agent's ToolRegistry.
 *
 * These tools are callable by the LLM:
 * - `search_knowledge` — semantic search over the indexed knowledge base
 * - `list_knowledge_documents` — list available document paths
 */

import type { Tool } from "../tools/types";
import type { RAGManager } from "./rag-manager";

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
