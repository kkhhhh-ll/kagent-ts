import type { LLMProvider, LLMResponse, LLMStreamEvent } from "../../src/llm/interface";

/**
 * Preset LLM response content for a final answer.
 * The ReActAgent sees `answer` and returns immediately.
 */
export function answerContent(answer: string): string {
  return JSON.stringify({ thought: "ok", answer });
}

/**
 * Preset LLM response content for a tool call (no answer).
 * The ReActAgent continues the loop after executing the tool.
 */
export function toolCallContent(toolName: string, args?: string): string {
  return JSON.stringify({ thought: `calling ${toolName}` });
}

/**
 * Create a mock LLM provider that returns a final answer immediately.
 *
 * ```ts
 * const llm = mockAnswerLLM("Hello, world!");
 * ```
 */
export function mockAnswerLLM(answer: string): LLMProvider {
  return mockLLM(answerContent(answer));
}

/**
 * Create a mock LLM provider that calls a single tool.
 *
 * ```ts
 * const llm = mockToolCallLLM("calculator", "{\"expression\": \"2+2\"}");
 * ```
 */
export function mockToolCallLLM(
  toolName: string,
  args?: string,
): LLMProvider {
  return mockLLM(toolCallContent(toolName, args), [
    {
      id: "call_1",
      type: "function" as const,
      function: { name: toolName, arguments: args ?? "{}" },
    },
  ]);
}

/**
 * Create a fully customizable mock LLM provider.
 *
 * @param content   The `content` field of the LLMResponse.
 * @param toolCalls Optional tool_calls to include.
 * @param model     Model name (defaults to "mock-model").
 */
export function mockLLM(
  content: string,
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>,
  model = "mock-model",
): LLMProvider {
  return {
    model,
    chat: async (_messages, _tools, _signal): Promise<LLMResponse> => ({
      content,
      tool_calls: toolCalls,
    }),
    chatStream: async function* (_messages, _tools, _signal): AsyncIterable<LLMStreamEvent> {
      yield { type: "chunk", content };
      yield { type: "done" };
    },
    getTokenCount: () => 10,
  };
}

/**
 * Create a sequence-based mock LLM provider that returns different
 * responses on each call. Useful for testing multi-step interactions.
 *
 * @param responses Ordered array of response specs. Each spec is
 *                  [content, toolCalls?]. The last response should
 *                  typically include an `answer` to end the loop.
 *
 * ```ts
 * const llm = mockSequenceLLM([
 *   [toolCallContent("read_file")],
 *   [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
 *   [answerContent("File contents are: ...")],
 * ]);
 * ```
 */
export function mockSequenceLLM(
  responses: Array<
    [
      content: string,
      toolCalls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>,
    ]
  >,
  model = "mock-model",
): LLMProvider {
  let callCount = 0;

  return {
    model,
    chat: async (_messages, _tools, _signal): Promise<LLMResponse> => {
      const index = Math.min(callCount, responses.length - 1);
      const [content, toolCalls] = responses[index];
      callCount++;
      return { content, tool_calls: toolCalls };
    },
    chatStream: async function* (_messages, _tools, _signal): AsyncIterable<LLMStreamEvent> {
      const index = Math.min(callCount, responses.length - 1);
      const [content] = responses[index];
      callCount++;
      yield { type: "chunk", content };
      yield { type: "done" };
    },
    getTokenCount: () => 10,
  };
}
