import type { AnthropicResponse, OpenAIResponse, OpenAIToolCall } from "../types";

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  stop_sequence: "stop",
};

/**
 * Convert Anthropic non-streaming response to OpenAI chat completion response
 */
export function convertAnthropicToOpenAI(body: AnthropicResponse, requestModel?: string): OpenAIResponse {
  let textContent = "";
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of body.content || []) {
    if (block.type === "text" && block.text) {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || "",
        type: "function",
        function: {
          name: block.name || "",
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
    // Skip thinking blocks
  }

  const message: any = {
    role: "assistant" as const,
    content: textContent || null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const finishReason = STOP_REASON_MAP[body.stop_reason || ""] || "stop";

  return {
    id: body.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestModel || body.model || "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason as any,
      },
    ],
    usage: body.usage
      ? {
          prompt_tokens: body.usage.input_tokens || 0,
          completion_tokens: body.usage.output_tokens || 0,
          total_tokens: (body.usage.input_tokens || 0) + (body.usage.output_tokens || 0),
        }
      : undefined,
  };
}
