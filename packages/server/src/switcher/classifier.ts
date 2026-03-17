import { createHash } from "crypto"
import { LRUCache } from "lru-cache"
import { ContentClassification, SwitcherConfig, SwitcherResult } from "./types"

interface ContentBlock {
  type: string
  text?: string
  [key: string]: any
}

interface Message {
  role: string
  content: string | ContentBlock[]
}

export function stripSystemContent(text: string): string {
  // Remove <system-reminder>...</system-reminder> blocks
  let stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
  // Remove HTML comments (e.g. <!-- speaker:... -->)
  stripped = stripped.replace(/<!--[\s\S]*?-->/g, "")
  // Remove <available-deferred-tools>...</available-deferred-tools> blocks
  stripped = stripped.replace(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/g, "")
  // Remove <local-command-caveat>...</local-command-caveat> blocks
  stripped = stripped.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
  // Remove <command-name>...</command-name> and related command tags
  stripped = stripped.replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/g, "")
  // Remove <local-command-stdout>...</local-command-stdout> blocks
  stripped = stripped.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
  // Collapse multiple whitespace/newlines into single newline
  stripped = stripped.replace(/\n{3,}/g, "\n\n")
  return stripped.trim()
}

const CLASSIFIER_PROMPT = `Classify the following conversation as "sfw" or "nsfw".

NSFW = explicit sexual content, graphic violence, hate speech, illegal activities, or inappropriate in a professional environment.

Reply with ONLY this JSON, nothing else:
{"classification":"sfw","confidence":0.95}`

export function extractLastUserMessage(messages: Message[]): string | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null
  }

  const lastMessage = messages[messages.length - 1]
  if (lastMessage.role !== "user") {
    return null
  }

  if (typeof lastMessage.content === "string") {
    return stripSystemContent(lastMessage.content)
  }

  if (Array.isArray(lastMessage.content)) {
    // In Claude Code, the actual user text is the last text block.
    // Earlier blocks contain system reminders, CLAUDE.md, tool results, etc.
    for (let i = lastMessage.content.length - 1; i >= 0; i--) {
      const block = lastMessage.content[i]
      if (block.type === "text" && typeof block.text === "string") {
        const stripped = stripSystemContent(block.text)
        if (stripped) return stripped
      }
    }
  }

  return null
}

export function extractAllMessagesText(messages: Message[]): string | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null
  }

  const texts: string[] = []
  for (const message of messages) {
    const role = message.role
    if (typeof message.content === "string") {
      const stripped = stripSystemContent(message.content)
      if (stripped) texts.push(`[${role}]: ${stripped}`)
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          const stripped = stripSystemContent(block.text)
          if (stripped) texts.push(`[${role}]: ${stripped}`)
        }
      }
    }
  }

  return texts.length > 0 ? texts.join("\n") : null
}

export function extractUserOnlyText(messages: Message[]): string | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null
  }

  const texts: string[] = []
  for (const message of messages) {
    if (message.role !== "user") continue
    if (typeof message.content === "string") {
      const stripped = stripSystemContent(message.content)
      if (stripped) texts.push(stripped)
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          const stripped = stripSystemContent(block.text)
          if (stripped) texts.push(stripped)
        }
      }
    }
  }

  return texts.length > 0 ? texts.join("\n") : null
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function extractJson(text: string): string | null {
  // Try to find JSON object in the response text
  const match = text.match(/\{[\s\S]*?"classification"[\s\S]*?\}/)
  return match ? match[0] : null
}

function parseClassifierResponse(
  responseText: string,
  fallback: ContentClassification,
  logger: any
): { classification: ContentClassification; confidence: number } {
  // First try direct parse
  try {
    const parsed = JSON.parse(responseText)
    if (parsed.classification) {
      return {
        classification: parsed.classification === "nsfw" ? "nsfw" : "sfw",
        confidence: typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      }
    }
  } catch {
    // Direct parse failed, try extracting JSON
  }

  // Extract JSON from surrounding text (e.g. markdown code blocks)
  const jsonStr = extractJson(responseText)
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr)
      return {
        classification: parsed.classification === "nsfw" ? "nsfw" : "sfw",
        confidence: typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      }
    } catch {
      logger.warn(
        { extracted: jsonStr },
        "Switcher: extracted JSON but failed to parse"
      )
    }
  }

  // Last resort: check for keywords
  const lower = responseText.toLowerCase()
  if (lower.includes('"nsfw"') || lower.includes("'nsfw'")) {
    logger.warn(
      { responseText },
      "Switcher: JSON parse failed, detected nsfw keyword"
    )
    return { classification: "nsfw", confidence: 0.5 }
  }

  logger.warn(
    { responseText },
    "Switcher: could not parse classifier response, using fallback"
  )
  return { classification: fallback, confidence: 0 }
}

export async function classifyContent(
  content: string,
  config: SwitcherConfig,
  cache: LRUCache<string, SwitcherResult> | null,
  logger: any
): Promise<SwitcherResult> {
  const startTime = Date.now()
  // Truncate from the end to keep the most recent (most relevant) content
  const truncated = content.length > config.maxContentLength
    ? content.slice(-config.maxContentLength)
    : content
  const contentHash = hashContent(truncated)

  // Check cache
  if (cache) {
    const cached = cache.get(contentHash)
    if (cached) {
      logger.debug(
        { contentHash, classification: cached.classification },
        "Switcher: cache hit"
      )
      return { ...cached, cached: true, latencyMs: Date.now() - startTime }
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs
    )

    const response = await fetch(config.classifierApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.classifierApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.classifierModel,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: `${CLASSIFIER_PROMPT}\n\nMessage:\n${truncated}`,
          },
        ],
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown")
      logger.error(
        { status: response.status, body: errorBody },
        "Switcher: classifier API error"
      )
      return {
        classification: config.fallbackClassification,
        confidence: 0,
        cached: false,
        latencyMs: Date.now() - startTime,
      }
    }

    const data = await response.json() as any
    const responseText = data?.content?.[0]?.text || ""

    logger.debug({ rawResponse: responseText }, "Switcher: classifier raw response")

    const { classification, confidence } = parseClassifierResponse(
      responseText,
      config.fallbackClassification,
      logger
    )

    const result: SwitcherResult = {
      classification,
      confidence,
      cached: false,
      latencyMs: Date.now() - startTime,
    }

    // Store in cache
    if (cache) {
      cache.set(contentHash, result)
    }

    return result
  } catch (error: any) {
    if (error.name === "AbortError") {
      logger.warn(
        { timeoutMs: config.timeoutMs },
        "Switcher: classifier request timed out"
      )
    } else {
      logger.error(
        { error: error.message },
        "Switcher: classifier request failed"
      )
    }

    return {
      classification: config.fallbackClassification,
      confidence: 0,
      cached: false,
      latencyMs: Date.now() - startTime,
    }
  }
}
