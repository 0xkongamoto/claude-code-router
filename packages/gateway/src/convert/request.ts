import type { OpenAIRequest, AnthropicRequest, AnthropicContentBlock, AnthropicMessage, OpenAIMessage } from "../types";

/**
 * Convert OpenAI chat completion request to Anthropic messages request
 */
export function convertOpenAIToAnthropic(body: OpenAIRequest): AnthropicRequest {
  const result: AnthropicRequest = {
    model: body.model,
    max_tokens: body.max_tokens || 8192,
    messages: [],
    stream: body.stream ?? false,
  };

  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // Extract system messages
  const systemMessages = body.messages.filter((m) => m.role === "system");
  if (systemMessages.length > 0) {
    const systemTexts = systemMessages.map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      }
      return "";
    });
    result.system = systemTexts.join("\n\n");
  }

  // Convert non-system messages
  const nonSystemMessages = body.messages.filter((m) => m.role !== "system");
  result.messages = convertMessages(nonSystemMessages);

  // Convert tools
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || "",
      input_schema: tool.function.parameters || { type: "object", properties: {} },
    }));
  }

  // Convert tool_choice
  if (body.tool_choice !== undefined) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  return result;
}

function convertMessages(messages: OpenAIMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "tool") {
      // Tool result messages get merged into a user message with tool_result blocks
      const toolResults: AnthropicContentBlock[] = [];

      // Collect consecutive tool messages
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMsg = messages[j];
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolMsg.tool_call_id,
          content: typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content),
        });
        j++;
      }

      result.push({
        role: "user",
        content: toolResults,
      });

      // Skip the ones we already processed (minus 1 because the for loop will increment)
      i = j - 1;
      continue;
    }

    if (msg.role === "assistant") {
      const content: AnthropicContentBlock[] = [];

      // Add text content
      if (typeof msg.content === "string" && msg.content) {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            content.push({ type: "text", text: block.text });
          }
        }
      }

      // Convert tool_calls to tool_use blocks
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          let input: Record<string, any> = {};
          try {
            input = JSON.parse(toolCall.function.arguments);
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input,
          });
        }
      }

      result.push({
        role: "assistant",
        content: content.length > 0 ? content : "",
      });
      continue;
    }

    if (msg.role === "user") {
      const content = convertUserContent(msg.content);
      result.push({
        role: "user",
        content,
      });
      continue;
    }
  }

  return result;
}

function convertUserContent(
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null
): string | AnthropicContentBlock[] {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;

  const blocks: AnthropicContentBlock[] = [];

  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text || "" });
    } else if (part.type === "image_url" && part.image_url) {
      blocks.push(convertImageUrl(part.image_url.url));
    }
  }

  return blocks;
}

function convertImageUrl(url: string): AnthropicContentBlock {
  // Data URI: data:image/jpeg;base64,/9j/4AAQ...
  const dataUriMatch = url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataUriMatch[1],
        data: dataUriMatch[2],
      },
    };
  }

  // Regular URL
  return {
    type: "image",
    source: {
      type: "url",
      url,
    },
  };
}

function convertToolChoice(
  choice: string | { type: string; function?: { name: string } }
): { type: string; name?: string } {
  if (typeof choice === "string") {
    switch (choice) {
      case "auto":
        return { type: "auto" };
      case "none":
        return { type: "none" };
      case "required":
        return { type: "any" };
      default:
        return { type: "auto" };
    }
  }

  if (choice.type === "function" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }

  return { type: "auto" };
}
