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

const CLASSIFIER_PROMPT = `Classify the user message as "sfw" or "nsfw".

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
    return lastMessage.content
  }

  if (Array.isArray(lastMessage.content)) {
    // In Claude Code, the actual user text is the last text block.
    // Earlier blocks contain system reminders, CLAUDE.md, tool results, etc.
    for (let i = lastMessage.content.length - 1; i >= 0; i--) {
      const block = lastMessage.content[i]
      if (block.type === "text" && typeof block.text === "string") {
        return block.text
      }
    }
  }

  return null
}

function hashContent(content: string): string {
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
  const truncated = content.slice(0, config.maxContentLength)
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
