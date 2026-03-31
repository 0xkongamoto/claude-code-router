import { LRUCache } from "lru-cache"
import { PipelineConfig, SanitizerResult, SfwAgentConfig, parsePipelineConfig } from "../switcher/types"
import { extractAllMessagesText, extractUserOnlyText, extractFirstUserMessage } from "../switcher/classifier"
import { sanitizeContent } from "./sanitizer"
import { sanitizeAllUserMessages } from "./replace"
import { PipelineStore } from "./store"

export function buildReportInstruction(config: SfwAgentConfig): string {
  return `

## ⚠️ PLACEHOLDER RULES — MANDATORY, ZERO TOLERANCE

The user's prompt contains \`{{__SLOT_NNN__}}\` placeholders. A post-processing system will replace them AFTER you finish. You are FORBIDDEN from replacing them yourself.

**ABSOLUTE RULES:**
1. Every \`{{__SLOT_NNN__}}\` in the prompt MUST appear VERBATIM in your code output — exact string, including the \`{{ }}\` braces
2. Do NOT interpret, guess, translate, or substitute any placeholder with your own content — even if you think you know what it means
3. Do NOT remove, skip, or rewrite any placeholder — every single one must be present in the final code
4. Place each placeholder in the correct code location: string literals, JSX text, config values, variable assignments, etc.
5. If a placeholder appears in quotes in the prompt, keep it in quotes in the code: \`"{{__SLOT_001__}}"\`

**WHAT HAPPENS IF YOU BREAK THESE RULES:**
- The post-processing system will FAIL because it searches for the exact \`{{__SLOT_NNN__}}\` strings in your output files
- The entire build will be ROLLED BACK and your work will be DISCARDED
- This is an automated pipeline — there is no human to fix your mistakes

**CORRECT example:**
Prompt says: "the title is {{__SLOT_001__}}" → Your code: \`const title = "{{__SLOT_001__}}"\`

**WRONG example (will cause pipeline failure):**
Prompt says: "the title is {{__SLOT_001__}}" → Your code: \`const title = "My App"\` ← PLACEHOLDER DROPPED, PIPELINE FAILS

**Creating additional placeholders:**
If you need UI labels, descriptions, or button text that relate to the themed parts of the application, create ADDITIONAL placeholders using the next sequential numbers (e.g., \`{{__SLOT_005__}}\`, \`{{__SLOT_006__}}\`). Never write themed content directly — always use a placeholder.

## IMPLEMENTATION REPORT — REQUIRED

After completing ALL file writes, you MUST output this structured report. Without this report, the pipeline cannot proceed.

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

List EVERY \`{{__SLOT_NNN__}}\` placeholder you used (both from the prompt AND any additional ones you created), with its exact file path, line number, type, and surrounding code context. This report is CRITICAL — without it the automated pipeline cannot fill in the final values.`
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

  async decompose(messages: any[], requestApiKey?: string, projectId?: string | null): Promise<SanitizerResult | null> {
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
      firstUserText,
      requestApiKey
    )

    this.logger.info(
      {
        originalClassification: result.originalClassification,
        confidence: result.confidence,
        cached: result.cached,
        latencyMs: result.latencyMs,
        hasCleanPrompt: result.cleanPrompt !== null,
        hasNsfwSpec: result.nsfwSpec !== null,
        ...(projectId ? { projectId } : {}),
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

/**
 * Extract projectId from a project path.
 * Path format: /tmp/one-workspaces/{userId}/projects/{projectId}/...
 */
export function extractProjectId(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null
  const match = projectPath.match(/\/projects\/([^/]+)/)
  return match?.[1] || null
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

    // Extract client auth token (TK1) for pipeline API calls
    const requestApiKey: string | undefined =
      req.headers?.["x-api-key"] || req.headers?.authorization || undefined
    if (requestApiKey) {
      req.pipelineApiKey = requestApiKey
    }

    const result = await sanitizer.decompose(req.body.messages, requestApiKey, req.projectId)
    if (!result) {
      return
    }

    // API failure fallback: if the sanitizer API failed (confidence 0, no cache hit)
    // but we have a known NSFW session in the pipeline store, use the stored
    // cleanPrompt to sanitize messages instead of forwarding NSFW content as-is.
    if (
      result.confidence === 0 &&
      !result.cached &&
      result.originalClassification === "sfw" &&
      store &&
      req.sessionId
    ) {
      const existingSession = store.getSession(req.sessionId)
      if (
        existingSession &&
        (existingSession.originalClassification === "nsfw" || existingSession.originalClassification === "mixed") &&
        existingSession.cleanPrompt
      ) {
        const hookLogger = logger || sanitizer["logger"]
        hookLogger.warn(
          { sessionId: req.sessionId, projectId: req.projectId || existingSession.projectId, storedClassification: existingSession.originalClassification },
          "Sanitizer: API failed, using session-cached NSFW classification and cleanPrompt"
        )

        req.body.messages = sanitizeAllUserMessages(
          req.body.messages,
          existingSession.cleanPrompt
        )

        req.switcherResult = {
          classification: "sfw",
          confidence: existingSession.originalClassification === "nsfw" ? 0.98 : 0.9,
          cached: true,
          latencyMs: result.latencyMs,
        }

        req.sanitizerResult = {
          ...result,
          originalClassification: existingSession.originalClassification,
          cleanPrompt: existingSession.cleanPrompt,
          nsfwSpec: existingSession.nsfwSpec,
        }

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

        return
      }
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
        const projectId = req.projectId || extractProjectId(projectPath)
        store.initSessionIfNeeded(req.sessionId, result.nsfwSpec, result.originalClassification, projectPath, requestApiKey, result.cleanPrompt, projectId)
      }

      // Log nsfwSpec for manual retrieval
      const hookLogger = logger || sanitizer["logger"]
      hookLogger.info(
        {
          originalClassification: result.originalClassification,
          projectId: req.projectId || null,
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
