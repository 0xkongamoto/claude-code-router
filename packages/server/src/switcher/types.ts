export type ContentClassification = "sfw" | "nsfw" | "mixed"

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
      fallback === "sfw" || fallback === "nsfw" || fallback === "mixed"
        ? fallback
        : DEFAULTS.fallbackClassification,
  }
}

export interface ContentChange {
  file: string
  path: string
  description: string
}

export interface CodeChange {
  type: "string" | "logic" | "style" | "config"
  placeholder: string
  description: string
  location: string
}

export interface ImageDescription {
  imageIndex: number
  messageIndex: number
  description: string
}

export interface NsfwSpec {
  contentChanges: ContentChange[]
  codeChanges: CodeChange[]
  context: string
  imageDescriptions?: ImageDescription[]
}

export interface SanitizerResult extends SwitcherResult {
  originalClassification: ContentClassification
  cleanPrompt: string | null
  nsfwSpec: NsfwSpec | null
}

// ── Implementation Report types ──

export interface FileEntry {
  path: string
  action: "created" | "modified"
  purpose: string
  linesOfCode: number
}

export interface PlaceholderEntry {
  id: string
  file: string
  line: number
  type: "string" | "array" | "object" | "number" | "logic" | "style"
  currentValue: string
  context: string
}

export interface ContentFileEntry {
  path: string
  schema: object
  placeholderPaths: string[]
}

export interface ImplementationReport {
  summary: string
  files: FileEntry[]
  placeholders: PlaceholderEntry[]
  contentFiles: ContentFileEntry[]
  buildStatus: "success" | "warning"
  techStack: string[]
  componentTree: string
}

// ── Pipeline State ──

export type PipelineStatus =
  | "sfw_in_progress"
  | "sfw_complete"
  | "nsfw_pending"
  | "nsfw_in_progress"
  | "nsfw_complete"
  | "apply_pending"
  | "apply_in_progress"
  | "apply_complete"
  | "error"

export interface PipelineState {
  sessionId: string
  status: PipelineStatus
  nsfwSpec: NsfwSpec | null
  implementationReport: ImplementationReport | null
  fillResult: FillResult | null
  applyResult: ApplyResult | null
  originalClassification: ContentClassification
  projectPath: string | null
  createdAt: number
  updatedAt: number
  error?: string
}

// ── NSFW Fill Result Types ──

export interface FillReplacement {
  find: string      // "{{__SLOT_001__}}"
  replace: string   // "replacement value"
}

export interface FileEdit {
  file: string
  replacements: FillReplacement[]
}

export interface ContentFileOutput {
  file: string
  content: string
}

export interface FillResult {
  edits: FileEdit[]
  contentFiles: ContentFileOutput[]
  modelUsed: string
  latencyMs: number
}

// ── Apply Result Types ──

export interface FileApplyResult {
  file: string
  replacementsApplied: number
  status: "success" | "skipped" | "error"
  error?: string
}

export interface ContentFileApplyResult {
  file: string
  status: "created" | "overwritten" | "error"
  error?: string
}

export interface PlaceholderScanResult {
  file: string
  line: number
  placeholder: string
}

export interface ApplyResult {
  editsApplied: FileApplyResult[]
  contentFilesWritten: ContentFileApplyResult[]
  totalReplacementsApplied: number
  totalContentFilesWritten: number
  remainingPlaceholders: PlaceholderScanResult[]
  buildVerification: {
    attempted: boolean
    success: boolean
    output?: string
    error?: string
  }
  rolledBack: boolean
  latencyMs: number
}

// ── Apply Config ──

export interface ApplyConfig {
  buildCommand: string
  buildTimeoutMs: number
  gitEnabled: boolean
  gitCommitMessage: string
  maxFileSizeBytes: number
}

const APPLY_DEFAULTS: ApplyConfig = {
  buildCommand: "npm run build",
  buildTimeoutMs: 120000,
  gitEnabled: true,
  gitCommitMessage: "nsfw: fill placeholders with content",
  maxFileSizeBytes: 5242880,
}

// ── SFW Agent Config ──

export interface SfwAgentConfig {
  reportMarkerStart: string
  reportMarkerEnd: string
  storeMaxSize: number
  storeTtlMs: number
}

// ── NSFW Agent Config ──

export interface NsfwAgentConfig {
  model: string
  apiKey: string
  apiUrl: string
  timeoutMs: number
  maxTokens: number
  maxRetries: number
  retryDelayMs: number
}

export interface NsfwVisionConfig {
  model: string
  apiKey: string
  apiUrl: string
  timeoutMs: number
  maxTokens: number
}

export interface PipelineConfig {
  enabled: boolean
  sanitizer: SanitizerModelConfig
  sfwAgent: SfwAgentConfig
  nsfwAgent: NsfwAgentConfig
  apply: ApplyConfig
  nsfwVision?: NsfwVisionConfig
}

export interface SanitizerModelConfig {
  model: string
  apiKey: string
  apiUrl: string
  maxContentLength: number
  timeoutMs: number
  cacheEnabled: boolean
  cacheTtlMs: number
  cacheMaxSize: number
}

const SFW_AGENT_DEFAULTS: SfwAgentConfig = {
  reportMarkerStart: "<<<IMPLEMENTATION_REPORT>>>",
  reportMarkerEnd: "<<<END_IMPLEMENTATION_REPORT>>>",
  storeMaxSize: 100,
  storeTtlMs: 3600000,
}

const NSFW_AGENT_DEFAULTS: NsfwAgentConfig = {
  model: "NikolaSigmoid/MiniMax-M2.5-Uncensored-FP8",
  apiKey: "d50b6ba5169ea538a71fe7b0685b755823a3746934fa3cc4k",
  apiUrl: "https://p2b5yivc05me87-8000.proxy.runpod.net/v1/chat/completions",
  timeoutMs: 120000,
  maxTokens: 8192,
  maxRetries: 2,
  retryDelayMs: 3000,
}

const NSFW_VISION_DEFAULTS: NsfwVisionConfig = {
  model: "",
  apiKey: "",
  apiUrl: "",
  timeoutMs: 30000,
  maxTokens: 2048,
}

const SANITIZER_DEFAULTS: SanitizerModelConfig = {
  model: "claude-haiku-4-5-20251001",
  apiKey: "",
  apiUrl: "https://api.anthropic.com/v1/messages",
  maxContentLength: 4000,
  timeoutMs: 8000,
  cacheEnabled: true,
  cacheTtlMs: 300000,
  cacheMaxSize: 500,
}

export function parsePipelineConfig(
  raw: Record<string, any>,
  fallbackApiKey?: string
): PipelineConfig {
  const sanitizerRaw = raw.sanitizer || {}
  const apiKey = typeof sanitizerRaw.apiKey === "string" && sanitizerRaw.apiKey
    ? sanitizerRaw.apiKey
    : fallbackApiKey || SANITIZER_DEFAULTS.apiKey

  const sfwAgentRaw = raw.sfwAgent || {}
  const nsfwAgentRaw = raw.nsfwAgent || {}
  const applyRaw = raw.apply || {}
  const visionRaw = raw.nsfwVision || {}

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    sfwAgent: {
      reportMarkerStart: typeof sfwAgentRaw.reportMarkerStart === "string"
        ? sfwAgentRaw.reportMarkerStart
        : SFW_AGENT_DEFAULTS.reportMarkerStart,
      reportMarkerEnd: typeof sfwAgentRaw.reportMarkerEnd === "string"
        ? sfwAgentRaw.reportMarkerEnd
        : SFW_AGENT_DEFAULTS.reportMarkerEnd,
      storeMaxSize: typeof sfwAgentRaw.storeMaxSize === "number" && sfwAgentRaw.storeMaxSize >= 1
        ? sfwAgentRaw.storeMaxSize
        : SFW_AGENT_DEFAULTS.storeMaxSize,
      storeTtlMs: typeof sfwAgentRaw.storeTtlMs === "number" && sfwAgentRaw.storeTtlMs >= 0
        ? sfwAgentRaw.storeTtlMs
        : SFW_AGENT_DEFAULTS.storeTtlMs,
    },
    nsfwAgent: {
      model: typeof nsfwAgentRaw.model === "string"
        ? nsfwAgentRaw.model
        : NSFW_AGENT_DEFAULTS.model,
      apiKey: typeof nsfwAgentRaw.apiKey === "string" && nsfwAgentRaw.apiKey
        ? nsfwAgentRaw.apiKey
        : NSFW_AGENT_DEFAULTS.apiKey,
      apiUrl: typeof nsfwAgentRaw.apiUrl === "string"
        ? nsfwAgentRaw.apiUrl
        : NSFW_AGENT_DEFAULTS.apiUrl,
      timeoutMs:
        typeof nsfwAgentRaw.timeoutMs === "number" && nsfwAgentRaw.timeoutMs >= 1000
          ? nsfwAgentRaw.timeoutMs
          : NSFW_AGENT_DEFAULTS.timeoutMs,
      maxTokens:
        typeof nsfwAgentRaw.maxTokens === "number" && nsfwAgentRaw.maxTokens >= 256
          ? nsfwAgentRaw.maxTokens
          : NSFW_AGENT_DEFAULTS.maxTokens,
      maxRetries:
        typeof nsfwAgentRaw.maxRetries === "number" && nsfwAgentRaw.maxRetries >= 0
          ? nsfwAgentRaw.maxRetries
          : NSFW_AGENT_DEFAULTS.maxRetries,
      retryDelayMs:
        typeof nsfwAgentRaw.retryDelayMs === "number" && nsfwAgentRaw.retryDelayMs >= 0
          ? nsfwAgentRaw.retryDelayMs
          : NSFW_AGENT_DEFAULTS.retryDelayMs,
    },
    sanitizer: {
      model: typeof sanitizerRaw.model === "string"
        ? sanitizerRaw.model
        : SANITIZER_DEFAULTS.model,
      apiKey,
      apiUrl: typeof sanitizerRaw.apiUrl === "string"
        ? sanitizerRaw.apiUrl
        : SANITIZER_DEFAULTS.apiUrl,
      maxContentLength:
        typeof sanitizerRaw.maxContentLength === "number" && sanitizerRaw.maxContentLength >= 100
          ? sanitizerRaw.maxContentLength
          : SANITIZER_DEFAULTS.maxContentLength,
      timeoutMs:
        typeof sanitizerRaw.timeoutMs === "number" && sanitizerRaw.timeoutMs >= 100
          ? sanitizerRaw.timeoutMs
          : SANITIZER_DEFAULTS.timeoutMs,
      cacheEnabled: typeof sanitizerRaw.cacheEnabled === "boolean"
        ? sanitizerRaw.cacheEnabled
        : SANITIZER_DEFAULTS.cacheEnabled,
      cacheTtlMs:
        typeof sanitizerRaw.cacheTtlMs === "number" && sanitizerRaw.cacheTtlMs >= 0
          ? sanitizerRaw.cacheTtlMs
          : SANITIZER_DEFAULTS.cacheTtlMs,
      cacheMaxSize:
        typeof sanitizerRaw.cacheMaxSize === "number" && sanitizerRaw.cacheMaxSize >= 0
          ? sanitizerRaw.cacheMaxSize
          : SANITIZER_DEFAULTS.cacheMaxSize,
    },
    apply: {
      buildCommand: typeof applyRaw.buildCommand === "string"
        ? applyRaw.buildCommand
        : APPLY_DEFAULTS.buildCommand,
      buildTimeoutMs:
        typeof applyRaw.buildTimeoutMs === "number" && applyRaw.buildTimeoutMs >= 1000
          ? applyRaw.buildTimeoutMs
          : APPLY_DEFAULTS.buildTimeoutMs,
      gitEnabled: typeof applyRaw.gitEnabled === "boolean"
        ? applyRaw.gitEnabled
        : APPLY_DEFAULTS.gitEnabled,
      gitCommitMessage: typeof applyRaw.gitCommitMessage === "string"
        ? applyRaw.gitCommitMessage
        : APPLY_DEFAULTS.gitCommitMessage,
      maxFileSizeBytes:
        typeof applyRaw.maxFileSizeBytes === "number" && applyRaw.maxFileSizeBytes >= 1024
          ? applyRaw.maxFileSizeBytes
          : APPLY_DEFAULTS.maxFileSizeBytes,
    },
    nsfwVision: visionRaw.model
      ? {
          model: typeof visionRaw.model === "string"
            ? visionRaw.model
            : NSFW_VISION_DEFAULTS.model,
          apiKey: typeof visionRaw.apiKey === "string" && visionRaw.apiKey
            ? visionRaw.apiKey
            : NSFW_VISION_DEFAULTS.apiKey,
          apiUrl: typeof visionRaw.apiUrl === "string"
            ? visionRaw.apiUrl
            : NSFW_VISION_DEFAULTS.apiUrl,
          timeoutMs:
            typeof visionRaw.timeoutMs === "number" && visionRaw.timeoutMs >= 1000
              ? visionRaw.timeoutMs
              : NSFW_VISION_DEFAULTS.timeoutMs,
          maxTokens:
            typeof visionRaw.maxTokens === "number" && visionRaw.maxTokens >= 128
              ? visionRaw.maxTokens
              : NSFW_VISION_DEFAULTS.maxTokens,
        }
      : undefined,
  }
}
