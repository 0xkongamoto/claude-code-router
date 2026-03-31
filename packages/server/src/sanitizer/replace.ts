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
 * Sanitize user messages in a conversation:
 * - First user message: sanitize text blocks to "[Prior context]" (contains original NSFW prompt)
 * - Middle user messages: pass through unchanged (tool results, follow-up instructions)
 * - Last user message: replace text block with cleanPrompt (if it has one)
 *
 * Only the FIRST user message needs sanitization because it contains the original
 * NSFW text sent by the user. Subsequent user messages are either tool results
 * (SFW, must be preserved for Claude to continue working) or follow-up instructions
 * (already sanitized via cleanPrompt on the turn they were sent).
 */
export function sanitizeAllUserMessages(
  messages: Message[],
  cleanPrompt: string
): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages
  }

  // Find first and last user message indices
  let firstUserIdx = -1
  let lastUserIdx = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      if (firstUserIdx === -1) firstUserIdx = i
      lastUserIdx = i
    }
  }

  if (lastUserIdx === -1) {
    return messages
  }

  // Apply cleanPrompt to the last user message (replaces text block if present)
  const result = replaceLastUserMessageContent(messages, cleanPrompt)

  // Only sanitize the FIRST user message (original NSFW prompt)
  // All other earlier user messages pass through unchanged
  if (firstUserIdx !== -1 && firstUserIdx !== lastUserIdx) {
    return result.map((msg, idx) => {
      if (idx === firstUserIdx && msg.role === "user") {
        return sanitizeHistoryMessage(msg)
      }
      return msg
    })
  }

  return result
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
      // No text block found (e.g., tool-result-only message).
      // Don't inject cleanPrompt — tool results should pass through unchanged.
      // The SFW Claude already has the instruction from the first turn.
      return messages
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
