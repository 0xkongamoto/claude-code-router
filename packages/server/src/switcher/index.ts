import { LRUCache } from "lru-cache"
import { parseSwitcherConfig, SwitcherConfig, SwitcherResult } from "./types"
import { classifyContent, extractAllMessagesText } from "./classifier"

export class Switcher {
  readonly config: SwitcherConfig
  readonly isEnabled: boolean
  private readonly cache: LRUCache<string, SwitcherResult> | null
  private readonly logger: any

  constructor(rawConfig: Record<string, any>, parentLogger: any) {
    this.config = parseSwitcherConfig(rawConfig)
    this.isEnabled = this.config.enabled
    this.logger = parentLogger.child({ module: "switcher" })

    if (this.isEnabled && this.config.cacheEnabled) {
      this.cache = new LRUCache<string, SwitcherResult>({
        max: this.config.cacheMaxSize,
        ttl: this.config.cacheTtlMs,
      })
    } else {
      this.cache = null
    }

    if (this.isEnabled) {
      this.logger.info(
        {
          classifierModel: this.config.classifierModel,
          timeoutMs: this.config.timeoutMs,
          cacheEnabled: this.config.cacheEnabled,
        },
        "Switcher: initialized"
      )
    }
  }

  async classify(messages: any[], clientApiKey?: string): Promise<SwitcherResult | null> {
    const content = extractAllMessagesText(messages)
    if (!content) {
      this.logger.debug("Switcher: no text content found in messages, skipping")
      return null
    }

    const result = await classifyContent(
      content,
      this.config,
      this.cache,
      this.logger,
      clientApiKey
    )

    this.logger.info(
      {
        content: content,
        classification: result.classification,
        confidence: result.confidence,
        cached: result.cached,
        latencyMs: result.latencyMs,
      },
      "Switcher: classification result"
    )

    return result
  }
}

export function createSwitcherHook(switcher: Switcher) {
  return async (req: any, _reply: any) => {
    if (!req.pathname?.endsWith("/v1/messages")) {
      return
    }

    if (!req.body?.messages) {
      return
    }

    // Extract client API key from request headers
    const xApiKey = Array.isArray(req.headers["x-api-key"]) ? req.headers["x-api-key"][0] : req.headers["x-api-key"]
    const authHeader = Array.isArray(req.headers["authorization"]) ? req.headers["authorization"][0] : req.headers["authorization"]
    const clientApiKey = xApiKey || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined)

    const result = await switcher.classify(req.body.messages, clientApiKey)
    if (result) {
      req.switcherResult = result
    }
  }
}

export type { SwitcherResult, SwitcherConfig, ContentClassification } from "./types"
