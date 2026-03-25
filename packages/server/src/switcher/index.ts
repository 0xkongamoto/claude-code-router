import { LRUCache } from "lru-cache"
import { parseSwitcherConfig, SwitcherConfig, TaskClassificationResult } from "./types"
import { classifyContent, extractAllMessagesText } from "./classifier"

export class Switcher {
  readonly config: SwitcherConfig
  readonly isEnabled: boolean
  private readonly cache: LRUCache<string, TaskClassificationResult> | null
  private readonly logger: any

  constructor(rawConfig: Record<string, any>, parentLogger: any) {
    this.config = parseSwitcherConfig(rawConfig)
    this.isEnabled = this.config.enabled
    this.logger = parentLogger.child({ module: "switcher" })

    if (this.isEnabled && this.config.cacheEnabled) {
      this.cache = new LRUCache<string, TaskClassificationResult>({
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

  async classify(messages: any[], requestApiKey?: string): Promise<TaskClassificationResult | null> {
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
      requestApiKey
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

    const requestApiKey: string | undefined =
      req.headers?.["x-api-key"] || req.headers?.authorization || undefined

    const result = await switcher.classify(req.body.messages, requestApiKey)
    if (result) {
      req.taskClassification = result
    }
  }
}

export type { TaskClassificationResult, TaskClassification } from "./types"
export type { SwitcherResult, SwitcherConfig, ContentClassification } from "./types"
