export type ContentClassification = "sfw" | "nsfw"

export interface SwitcherResult {
  classification: ContentClassification
  confidence: number
  cached: boolean
  latencyMs: number
}

export interface SwitcherConfig {
  enabled: boolean
  classifierModel: string
  classifierApiKey: string
  classifierApiUrl: string
  timeoutMs: number
  cacheEnabled: boolean
  cacheTtlMs: number
  cacheMaxSize: number
  maxContentLength: number
  fallbackClassification: ContentClassification
}

const DEFAULTS: SwitcherConfig = {
  enabled: false,
  classifierModel: "claude-haiku-4-5-20251001",
  classifierApiKey: "",
  classifierApiUrl: "https://api.anthropic.com/v1/messages",
  timeoutMs: 3000,
  cacheEnabled: true,
  cacheTtlMs: 300000,
  cacheMaxSize: 500,
  maxContentLength: 2000,
  fallbackClassification: "sfw",
}

export function parseSwitcherConfig(raw: Record<string, any>): SwitcherConfig {
  const fallback = raw.fallbackClassification
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    classifierModel:
      typeof raw.classifierModel === "string"
        ? raw.classifierModel
        : DEFAULTS.classifierModel,
    classifierApiKey:
      typeof raw.classifierApiKey === "string"
        ? raw.classifierApiKey
        : DEFAULTS.classifierApiKey,
    classifierApiUrl:
      typeof raw.classifierApiUrl === "string"
        ? raw.classifierApiUrl
        : DEFAULTS.classifierApiUrl,
    timeoutMs:
      typeof raw.timeoutMs === "number" && raw.timeoutMs >= 100
        ? raw.timeoutMs
        : DEFAULTS.timeoutMs,
    cacheEnabled:
      typeof raw.cacheEnabled === "boolean"
        ? raw.cacheEnabled
        : DEFAULTS.cacheEnabled,
    cacheTtlMs:
      typeof raw.cacheTtlMs === "number" && raw.cacheTtlMs >= 0
        ? raw.cacheTtlMs
        : DEFAULTS.cacheTtlMs,
    cacheMaxSize:
      typeof raw.cacheMaxSize === "number" && raw.cacheMaxSize >= 0
        ? raw.cacheMaxSize
        : DEFAULTS.cacheMaxSize,
    maxContentLength:
      typeof raw.maxContentLength === "number" && raw.maxContentLength >= 100
        ? raw.maxContentLength
        : DEFAULTS.maxContentLength,
    fallbackClassification:
      fallback === "sfw" || fallback === "nsfw"
        ? fallback
        : DEFAULTS.fallbackClassification,
  }
}
