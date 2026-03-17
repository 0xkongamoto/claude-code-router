import { LRUCache } from "lru-cache"
import { PipelineConfig, SanitizerResult, SfwAgentConfig, parsePipelineConfig } from "../switcher/types"
import { extractAllMessagesText, extractUserOnlyText, extractFirstUserMessage } from "../switcher/classifier"
import { sanitizeContent } from "./sanitizer"
import { sanitizeAllUserMessages } from "./replace"
import { PipelineStore } from "./store"

export function buildReportInstruction(config: SfwAgentConfig): string {
  return `

## PLACEHOLDER RULES (CRITICAL — READ CAREFULLY)

The user's prompt contains {{__SLOT_NNN__}} placeholders. These are template variables that will be replaced by a post-processing system after you finish.

**You MUST:**
1. Use EVERY {{__SLOT_NNN__}} placeholder from the prompt VERBATIM in your code output — copy-paste the exact string including the {{ }} braces
2. Place each placeholder in the appropriate code location (string literals, variable assignments, JSX text, config values, etc.)
3. If the prompt has N placeholders, your code MUST contain at least N placeholder occurrences
4. Treat placeholders as opaque values — do NOT try to guess what they mean or replace them with your own content

**Example:** If the prompt says "the title is {{__SLOT_001__}}", your code should contain:
\`\`\`
const title = "{{__SLOT_001__}}"
\`\`\`
NOT:
\`\`\`
const title = "My App"  // WRONG — placeholder was dropped
\`\`\`

If the context suggests additional UI labels, descriptions, button text, or content that relate to the NSFW-themed parts of the application, create ADDITIONAL placeholders using the next sequential numbers (e.g., if the prompt uses up to {{__SLOT_004__}}, you may add {{__SLOT_005__}}, {{__SLOT_006__}}, etc.). This ensures all adult-themed text can be post-processed.

## IMPLEMENTATION REPORT

After completing the implementation, output a structured implementation report wrapped in markers. This report must be valid JSON.

${config.reportMarkerStart}
{
  "summary": "Brief description of what was built",
  "files": [
    { "path": "src/components/Header.tsx", "action": "created", "purpose": "Main header component", "linesOfCode": 45 }
  ],
  "placeholders": [
    {
      "id": "{{__SLOT_001__}}",
      "file": "src/components/Header.tsx",
      "line": 12,
      "type": "string",
      "currentValue": "{{__SLOT_001__}}",
      "context": "<h1>{TITLE}</h1>"
    }
  ],
  "contentFiles": [],
  "buildStatus": "success",
  "techStack": ["react", "tailwind"],
  "componentTree": "App > Header > Title"
}
${config.reportMarkerEnd}

List EVERY {{__SLOT_NNN__}} placeholder you used, with its exact file path, line number, type, and surrounding code context. This is critical for automated post-processing.`
}

export class Sanitizer {
  readonly config: PipelineConfig
  readonly isEnabled: boolean
  private readonly cache: LRUCache<string, SanitizerResult> | null
  private readonly logger: any

  constructor(rawConfig: Record<string, any>, parentLogger: any, fallbackApiKey?: string) {
    this.config = parsePipelineConfig(rawConfig, fallbackApiKey)
    this.isEnabled = this.config.enabled
    this.logger = parentLogger.child({ module: "sanitizer" })

    if (this.isEnabled && this.config.sanitizer.cacheEnabled) {
      this.cache = new LRUCache<string, SanitizerResult>({
        max: this.config.sanitizer.cacheMaxSize,
        ttl: this.config.sanitizer.cacheTtlMs,
      })
    } else {
      this.cache = null
    }

    if (this.isEnabled) {
      this.logger.info(
        {
          model: this.config.sanitizer.model,
          timeoutMs: this.config.sanitizer.timeoutMs,
          cacheEnabled: this.config.sanitizer.cacheEnabled,
        },
        "Sanitizer: initialized"
      )
    }
  }

  async decompose(messages: any[]): Promise<SanitizerResult | null> {
    const classificationContent = extractAllMessagesText(messages)
    if (!classificationContent) {
      this.logger.debug("Sanitizer: no text content found in messages, skipping")
      return null
    }

    // User-only text for stable cache key across tool-call rounds
    const cacheKeyContent = extractUserOnlyText(messages) || classificationContent

    // First user message: must always be included in classification to prevent
    // NSFW text from being truncated out of the classification window in long conversations
    const firstUserText = extractFirstUserMessage(messages)

    const result = await sanitizeContent(
      cacheKeyContent,
      classificationContent,
      this.config.sanitizer,
      this.cache,
      this.logger,
      firstUserText
    )

    this.logger.info(
      {
        originalClassification: result.originalClassification,
        confidence: result.confidence,
        cached: result.cached,
        latencyMs: result.latencyMs,
        hasCleanPrompt: result.cleanPrompt !== null,
        hasNsfwSpec: result.nsfwSpec !== null,
      },
      "Sanitizer: decomposition result"
    )

    return result
  }
}

export function extractProjectPath(system: any): string | null {
  const text = typeof system === "string"
    ? system
    : Array.isArray(system)
      ? system.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("\n")
      : null
  if (!text) return null
  const match = text.match(/Primary working directory:\s*(.+)/)
  return match?.[1]?.trim() || null
}

export function createSanitizerHook(sanitizer: Sanitizer, store: PipelineStore | null, logger?: any) {
  const reportInstruction = buildReportInstruction(sanitizer.config.sfwAgent)

  return async (req: any, _reply: any) => {
    if (!req.pathname?.endsWith("/v1/messages")) {
      return
    }

    if (!req.body?.messages) {
      return
    }

    const result = await sanitizer.decompose(req.body.messages)
    if (!result) {
      return
    }

    if (result.originalClassification === "sfw") {
      // SFW: pass through without modification
      req.switcherResult = {
        classification: "sfw",
        confidence: result.confidence,
        cached: result.cached,
        latencyMs: result.latencyMs,
      }
      return
    }

    // NSFW or mixed with a clean prompt available
    if (
      (result.originalClassification === "nsfw" || result.originalClassification === "mixed") &&
      result.cleanPrompt !== null
    ) {
      // Sanitize ALL user messages: cleanPrompt for last, placeholder for earlier
      req.body.messages = sanitizeAllUserMessages(
        req.body.messages,
        result.cleanPrompt
      )

      // Route to SFW model — content is now clean
      req.switcherResult = {
        classification: "sfw",
        confidence: result.confidence,
        cached: result.cached,
        latencyMs: result.latencyMs,
      }

      // Store full sanitizer result for downstream access
      req.sanitizerResult = result

      // Append implementation report instruction to system prompt
      if (typeof req.body.system === "string") {
        req.body.system = req.body.system + reportInstruction
      } else if (Array.isArray(req.body.system)) {
        req.body.system = [
          ...req.body.system,
          { type: "text", text: reportInstruction },
        ]
      } else {
        req.body.system = reportInstruction.trim()
      }

      // Initialize pipeline state for this session
      if (store && req.sessionId && result.nsfwSpec) {
        const projectPath = extractProjectPath(req.body.system)
        store.initSessionIfNeeded(req.sessionId, result.nsfwSpec, result.originalClassification, projectPath)
      }

      // Log nsfwSpec for manual retrieval
      const hookLogger = logger || sanitizer["logger"]
      hookLogger.info(
        {
          originalClassification: result.originalClassification,
          nsfwSpec: result.nsfwSpec,
          cleanPrompt: result.cleanPrompt,
        },
        "Sanitizer: NSFW content decomposed — nsfwSpec logged for manual application"
      )

      return
    }

    // NSFW/mixed but no clean prompt (parse failure) — still set classification for routing
    req.switcherResult = {
      classification: result.originalClassification === "mixed" ? "nsfw" : result.originalClassification,
      confidence: result.confidence,
      cached: result.cached,
      latencyMs: result.latencyMs,
    }
  }
}
