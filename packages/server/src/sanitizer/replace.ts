interface ContentBlock {
  type: string
  text?: string
  [key: string]: any
}

interface Message {
  role: string
  content: string | ContentBlock[]
}

const SANITIZED_HISTORY_PLACEHOLDER = "[Prior context]"

/**
 * Sanitize ALL user messages in a conversation:
 * - Last user message: replace with cleanPrompt (via replaceLastUserMessageContent)
 * - Earlier user messages: replace non-system-reminder text blocks with a generic placeholder
 */
export function sanitizeAllUserMessages(
  messages: Message[],
  cleanPrompt: string
): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages
  }

  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i
      break
    }
  }

  if (lastUserIdx === -1) {
    return messages
  }

  // Apply cleanPrompt to the last user message (existing behavior)
  const result = replaceLastUserMessageContent(messages, cleanPrompt)

  // Sanitize all EARLIER user messages to prevent history leaking NSFW content
  return result.map((msg, idx) => {
    if (msg.role !== "user" || idx >= lastUserIdx) {
      return msg
    }
    return sanitizeHistoryMessage(msg)
  })
}

function sanitizeHistoryMessage(message: Message): Message {
  if (typeof message.content === "string") {
    return { ...message, content: SANITIZED_HISTORY_PLACEHOLDER }
  }

  if (Array.isArray(message.content)) {
    const newBlocks = message.content.map((block) => {
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        !block.text.includes("<system-reminder>")
      ) {
        return { ...block, text: SANITIZED_HISTORY_PLACEHOLDER }
      }
      return block
    })
    return { ...message, content: newBlocks }
  }

  return message
}

export function replaceLastUserMessageContent(
  messages: Message[],
  newContent: string
): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages
  }

  // Find the last user message index
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i
      break
    }
  }

  if (lastUserIdx === -1) {
    return messages
  }

  const lastUserMessage = messages[lastUserIdx]

  // String content: replace entirely
  if (typeof lastUserMessage.content === "string") {
    return [
      ...messages.slice(0, lastUserIdx),
      { ...lastUserMessage, content: newContent },
      ...messages.slice(lastUserIdx + 1),
    ]
  }

  // ContentBlock[] content: find last non-system-reminder text block and replace its text
  if (Array.isArray(lastUserMessage.content)) {
    const blocks = lastUserMessage.content
    let targetIdx = -1

    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]
      if (block.type === "text" && typeof block.text === "string") {
        // Skip system-reminder blocks
        if (block.text.includes("<system-reminder>")) {
          continue
        }
        targetIdx = i
        break
      }
    }

    if (targetIdx === -1) {
      // No suitable text block found, append a new one
      const newBlocks = [...blocks, { type: "text", text: newContent }]
      return [
        ...messages.slice(0, lastUserIdx),
        { ...lastUserMessage, content: newBlocks },
        ...messages.slice(lastUserIdx + 1),
      ]
    }

    const newBlocks = [
      ...blocks.slice(0, targetIdx),
      { ...blocks[targetIdx], text: newContent },
      ...blocks.slice(targetIdx + 1),
    ]

    return [
      ...messages.slice(0, lastUserIdx),
      { ...lastUserMessage, content: newBlocks },
      ...messages.slice(lastUserIdx + 1),
    ]
  }

  return messages
}
