const MAX_BUFFER_SIZE = 2 * 1024 * 1024

export interface AssembledResponse {
  id: string
  model: string
  content: Array<{
    type: string
    text?: string
    thinking?: string
    name?: string
    input?: any
  }>
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number }
}

export class ResponseAccumulator {
  private buffer = ""
  private response: AssembledResponse = {
    id: "",
    model: "",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }

  async accumulate(stream: ReadableStream): Promise<AssembledResponse> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (this.buffer.length > MAX_BUFFER_SIZE) break

        this.buffer += decoder.decode(value, { stream: true })
        this.processBuffer()
      }
    } finally {
      reader.releaseLock()
    }

    for (const block of this.response.content) {
      if (block.type === "tool_use" && typeof block.input === "string") {
        try {
          block.input = JSON.parse(block.input)
        } catch {
          // keep as string if parse fails
        }
      }
    }

    return this.response
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() || ""

    let currentEvent = ""
    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        try {
          this.processEvent(currentEvent, JSON.parse(data))
        } catch {
          // skip unparseable data
        }
      }
    }
  }

  private processEvent(event: string, data: any): void {
    switch (event) {
      case "message_start":
        if (data.message) {
          this.response.id = data.message.id || ""
          this.response.model = data.message.model || ""
        }
        break

      case "content_block_start": {
        const block = data.content_block
        if (!block) break
        const index = data.index ?? this.response.content.length
        const entry: any = { type: block.type }
        if (block.type === "text") entry.text = ""
        if (block.type === "thinking") entry.thinking = ""
        if (block.type === "tool_use") {
          entry.name = block.name || ""
          entry.input = ""
        }
        this.response.content[index] = entry
        break
      }

      case "content_block_delta": {
        const delta = data.delta
        if (!delta) break
        const index = data.index ?? 0
        const block = this.response.content[index]
        if (!block) break
        if (delta.type === "text_delta") {
          block.text = (block.text || "") + (delta.text || "")
        } else if (delta.type === "thinking_delta") {
          block.thinking = (block.thinking || "") + (delta.thinking || "")
        } else if (delta.type === "input_json_delta") {
          block.input = (block.input || "") + (delta.partial_json || "")
        }
        break
      }

      case "message_delta":
        if (data.delta?.stop_reason) {
          this.response.stop_reason = data.delta.stop_reason
        }
        if (data.usage) {
          this.response.usage = {
            input_tokens: data.usage.input_tokens ?? 0,
            output_tokens: data.usage.output_tokens ?? 0,
          }
        }
        break
    }
  }
}
