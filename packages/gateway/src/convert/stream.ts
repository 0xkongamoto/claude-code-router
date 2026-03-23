import type { OpenAIStreamChunk } from "../types";

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  stop_sequence: "stop",
};

interface StreamState {
  messageId: string;
  model: string;
  toolCallIndex: number;
  // Map from Anthropic content block index to OpenAI tool call index
  blockToToolIndex: Map<number, number>;
}

/**
 * Convert an Anthropic SSE stream (as a Node.js ReadableStream<Uint8Array>)
 * to an OpenAI SSE stream (ReadableStream<Uint8Array>).
 */
export function convertAnthropicStreamToOpenAI(
  anthropicStream: ReadableStream<Uint8Array>,
  requestModel?: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const state: StreamState = {
    messageId: "",
    model: requestModel || "",
    toolCallIndex: -1,
    blockToToolIndex: new Map(),
  };

  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = anthropicStream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete last line

          let currentEvent = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const dataStr = line.slice(6);
              if (dataStr === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              try {
                const data = JSON.parse(dataStr);
                const chunks = processAnthropicEvent(currentEvent, data, state);
                for (const chunk of chunks) {
                  const sseData = JSON.stringify(chunk);
                  controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          const lines = buffer.split("\n");
          let currentEvent = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const dataStr = line.slice(6);
              if (dataStr === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              }
            }
          }
        }

        // Always end with [DONE]
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function processAnthropicEvent(
  event: string,
  data: any,
  state: StreamState
): OpenAIStreamChunk[] {
  const chunks: OpenAIStreamChunk[] = [];

  switch (data.type || event) {
    case "message_start": {
      const msg = data.message || {};
      state.messageId = msg.id || `chatcmpl-${Date.now()}`;
      state.model = state.model || msg.model || "";

      // Emit initial chunk with role
      chunks.push(makeChunk(state, { role: "assistant" }, null));
      break;
    }

    case "content_block_start": {
      const block = data.content_block || {};
      if (block.type === "tool_use") {
        state.toolCallIndex++;
        state.blockToToolIndex.set(data.index, state.toolCallIndex);

        chunks.push(
          makeChunk(
            state,
            {
              tool_calls: [
                {
                  index: state.toolCallIndex,
                  id: block.id || "",
                  type: "function" as const,
                  function: {
                    name: block.name || "",
                    arguments: "",
                  },
                },
              ],
            },
            null
          )
        );
      }
      // text and thinking block starts: no emit needed
      break;
    }

    case "content_block_delta": {
      const delta = data.delta || {};

      if (delta.type === "text_delta") {
        chunks.push(makeChunk(state, { content: delta.text || "" }, null));
      } else if (delta.type === "input_json_delta") {
        const toolIdx = state.blockToToolIndex.get(data.index);
        if (toolIdx !== undefined) {
          chunks.push(
            makeChunk(
              state,
              {
                tool_calls: [
                  {
                    index: toolIdx,
                    function: {
                      arguments: delta.partial_json || "",
                    },
                  },
                ],
              },
              null
            )
          );
        }
      }
      // Skip thinking_delta, signature_delta
      break;
    }

    case "content_block_stop": {
      // No direct OpenAI equivalent, just track state
      break;
    }

    case "message_delta": {
      const delta = data.delta || {};
      const stopReason = delta.stop_reason
        ? STOP_REASON_MAP[delta.stop_reason] || "stop"
        : null;

      // Emit usage if available
      const usage = data.usage
        ? {
            prompt_tokens: data.usage.input_tokens || 0,
            completion_tokens: data.usage.output_tokens || 0,
            total_tokens:
              (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
          }
        : undefined;

      chunks.push({
        id: state.messageId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: stopReason,
          },
        ],
        usage: usage || null,
      });
      break;
    }

    case "message_stop": {
      // Will be followed by [DONE] in our outer loop
      break;
    }

    // Skip ping, error, etc.
  }

  return chunks;
}

function makeChunk(
  state: StreamState,
  delta: Record<string, any>,
  finishReason: string | null
): OpenAIStreamChunk {
  return {
    id: state.messageId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}
