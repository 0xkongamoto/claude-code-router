import {
  NsfwAgentConfig,
  NsfwSpec,
  ImplementationReport,
  PlaceholderEntry,
  FillResult,
  FileEdit,
  ContentFileOutput,
} from "../switcher/types"

// ── Error Classification ──

type FillErrorKind = "timeout" | "api_error" | "empty_response" | "parse_error" | "validation_error" | "network_error"

class FillError extends Error {
  readonly kind: FillErrorKind
  readonly retryable: boolean

  constructor(kind: FillErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.retryable = kind === "timeout" || kind === "api_error" || kind === "empty_response" || kind === "network_error"
  }
}

// ── Prompt ──

const NSFW_FILL_SYSTEM = `You are a content specialist who fills in placeholder values for adult-themed applications. An app has been built with safe placeholder values like {{NSFW_GAME_TITLE}}. You replace each placeholder with the real adult content.

## YOUR TASK

Given:
- An **NSFW Specification** describing what the adult content should be (theme, tone, descriptions)
- An **Implementation Report** listing every placeholder, its location, type, and surrounding code

Generate a JSON object containing the replacement value for every single placeholder.

## RESPONSE FORMAT

Respond with ONLY a JSON object. No explanations, no markdown, no code fences. Just raw JSON:

{"edits":[{"file":"path/to/file.tsx","replacements":[{"find":"{{NSFW_EXACT_ID}}","replace":"replacement value"}]}],"contentFiles":[{"file":"content/data.json","content":{"key":"value"}}]}

## REPLACEMENT RULES BY TYPE

Each placeholder has a "type" field. Follow these rules strictly:

**string** — Plain text. The code already has quotes around it, so do NOT add quotes.
  Code: const title = "{{NSFW_GAME_TITLE}}"
  find: "{{NSFW_GAME_TITLE}}" → replace: "Strip Poker Showdown"

**array** — A JSON array literal as a string. Must be valid JavaScript.
  Code: const states = {{NSFW_STATE_LABELS}}
  find: "{{NSFW_STATE_LABELS}}" → replace: "[\"Clothed\", \"Topless\", \"Nude\"]"

**object** — A JSON object literal as a string. Must be valid JavaScript.
  Code: const config = {{NSFW_GAME_CONFIG}}
  find: "{{NSFW_GAME_CONFIG}}" → replace: "{\"rounds\": 5, \"penalty\": \"remove_clothing\"}"

**number** — A numeric value as a string.
  Code: const maxRounds = {{NSFW_MAX_ROUNDS}}
  find: "{{NSFW_MAX_ROUNDS}}" → replace: "5"

**logic** — A code expression. Must be syntactically valid in context.
  Code: if ({{NSFW_WIN_CONDITION}}) { ... }
  find: "{{NSFW_WIN_CONDITION}}" → replace: "player.clothing.length === 0"

**style** — CSS class names or inline style values.
  Code: className={{"{{NSFW_REVEAL_STYLE}}"}}
  find: "{{NSFW_REVEAL_STYLE}}" → replace: "opacity-100 scale-110 blur-0"

## CONTENT FILES

For entries in "contentFiles": provide the COMPLETE file content as a JSON object. These files will be written in their entirety, so include all fields and data, not just the changed parts.

## CRITICAL RULES

1. Every placeholder from the Implementation Report MUST appear in your output — no placeholders left behind
2. The "find" field must be the EXACT placeholder string including the {{ }} braces
3. Group replacements by file in the "edits" array — one entry per file
4. Content must be creative, detailed, and match the NSFW specification's tone and theme
5. Content must be syntactically valid in the surrounding code context
6. Do NOT add extra files, code, or structure — only fill in what exists
7. If "contentFiles" section is empty in the report, omit it or return an empty array`

export class NsfwFillService {
  private readonly config: NsfwAgentConfig
  private readonly logger: any

  constructor(config: NsfwAgentConfig, parentLogger: any) {
    this.config = config
    this.logger = parentLogger.child({ module: "nsfw-fill" })

    this.logger.info(
      {
        model: this.config.model,
        apiUrl: this.config.apiUrl,
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
      },
      "NsfwFill: initialized"
    )
  }

  buildFillPrompt(
    nsfwSpec: NsfwSpec,
    report: ImplementationReport
  ): { system: string; user: string } {
    const placeholdersByFile = new Map<string, PlaceholderEntry[]>()
    for (const p of report.placeholders) {
      const existing = placeholdersByFile.get(p.file) || []
      placeholdersByFile.set(p.file, [...existing, p])
    }

    const placeholderSection = Array.from(placeholdersByFile.entries())
      .map(([file, entries]) => {
        const items = entries
          .map(
            (p) =>
              `  - ${p.id} (type: ${p.type}, line: ${p.line})\n    Current: ${p.currentValue}\n    Context: ${p.context}`
          )
          .join("\n")
        return `File: ${file}\n${items}`
      })
      .join("\n\n")

    const contentFileSection =
      report.contentFiles.length > 0
        ? report.contentFiles
            .map(
              (cf) =>
                `- ${cf.path}\n  Schema: ${JSON.stringify(cf.schema)}\n  Placeholder paths: ${cf.placeholderPaths.join(", ")}`
            )
            .join("\n")
        : "(none)"

    const codeChangesSection =
      nsfwSpec.codeChanges.length > 0
        ? nsfwSpec.codeChanges
            .map(
              (cc) =>
                `- ${cc.placeholder}: ${cc.description} (type: ${cc.type}, location: ${cc.location})`
            )
            .join("\n")
        : "(none)"

    const contentChangesSection =
      nsfwSpec.contentChanges.length > 0
        ? nsfwSpec.contentChanges
            .map((cc) => `- ${cc.file} [${cc.path}]: ${cc.description}`)
            .join("\n")
        : "(none)"

    const user = [
      "# NSFW Specification",
      "",
      `**Theme/Context:** ${nsfwSpec.context}`,
      "",
      "## Code Changes Required",
      codeChangesSection,
      "",
      "## Content File Changes Required",
      contentChangesSection,
      "",
      "# Implementation Report",
      "",
      `**Summary:** ${report.summary}`,
      `**Tech Stack:** ${report.techStack.join(", ")}`,
      `**Component Tree:** ${report.componentTree}`,
      `**Total placeholders:** ${report.placeholders.length}`,
      "",
      "## Placeholders by File",
      "",
      placeholderSection,
      "",
      "## Content Files Needing Generation",
      contentFileSection,
      "",
      `Generate replacements for all ${report.placeholders.length} placeholders. Output ONLY the JSON.`,
    ].join("\n")

    return { system: NSFW_FILL_SYSTEM, user }
  }

  async executeFill(
    nsfwSpec: NsfwSpec,
    report: ImplementationReport
  ): Promise<FillResult> {
    const startTime = Date.now()
    const { system, user } = this.buildFillPrompt(nsfwSpec, report)
    const expectedCount = report.placeholders.length

    this.logger.info(
      {
        model: this.config.model,
        placeholderCount: expectedCount,
        contentFileCount: report.contentFiles.length,
        maxRetries: this.config.maxRetries,
      },
      "NsfwFill: starting fill"
    )

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        this.logger.info(
          { attempt, maxRetries: this.config.maxRetries, delayMs: this.config.retryDelayMs },
          "NsfwFill: retrying after failure"
        )
        await this.delay(this.config.retryDelayMs)
      }

      try {
        const responseText = await this.callModel(system, user)
        const fillResult = this.parseFillResult(responseText, startTime)
        const totalReplacements = fillResult.edits.reduce(
          (sum, e) => sum + e.replacements.length,
          0
        )

        if (totalReplacements === 0) {
          throw new FillError(
            "validation_error",
            "NsfwFill: model returned 0 replacements"
          )
        }

        if (totalReplacements < expectedCount) {
          this.logger.warn(
            { expected: expectedCount, got: totalReplacements },
            "NsfwFill: partial fill — some placeholders missing"
          )
        }

        this.logger.info(
          {
            editCount: fillResult.edits.length,
            contentFileCount: fillResult.contentFiles.length,
            totalReplacements,
            expectedCount,
            latencyMs: fillResult.latencyMs,
            attempts: attempt + 1,
          },
          "NsfwFill: fill completed"
        )

        return fillResult
      } catch (error: any) {
        lastError = error

        const isFillError = error instanceof FillError
        const retryable = isFillError ? error.retryable : false

        this.logger.warn(
          {
            attempt,
            kind: isFillError ? error.kind : "unknown",
            retryable,
            error: error.message,
          },
          "NsfwFill: attempt failed"
        )

        if (isFillError && !retryable) {
          break
        }
      }
    }

    throw lastError || new Error("NsfwFill: all attempts failed")
  }

  private async callModel(system: string, user: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const response = await fetch(this.config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.7,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "unknown")
        this.logger.error(
          { status: response.status, body: errorBody.slice(0, 500) },
          "NsfwFill: API error"
        )
        throw new FillError(
          "api_error",
          `NSFW model API returned ${response.status}: ${errorBody.slice(0, 200)}`
        )
      }

      const data = (await response.json()) as any

      // Support both OpenAI-compatible and Anthropic response formats
      const responseText =
        data?.choices?.[0]?.message?.content ??
        data?.content?.[0]?.text ??
        ""

      if (!responseText) {
        throw new FillError("empty_response", "NSFW model returned empty response")
      }

      this.logger.debug(
        { responseLength: responseText.length },
        "NsfwFill: received response"
      )

      return responseText
    } catch (error: any) {
      clearTimeout(timeout)

      if (error instanceof FillError) throw error

      if (error.name === "AbortError") {
        throw new FillError(
          "timeout",
          `NSFW fill timed out after ${this.config.timeoutMs}ms`
        )
      }

      throw new FillError("network_error", `Network error: ${error.message}`)
    }
  }

  parseFillResult(responseText: string, startTime: number): FillResult {
    const parsed = this.extractAndParseJson(responseText)

    if (!parsed || typeof parsed !== "object") {
      throw new FillError(
        "parse_error",
        `NsfwFill: could not parse JSON from response (length: ${responseText.length})`
      )
    }

    if (!Array.isArray(parsed.edits)) {
      throw new FillError("parse_error", "NsfwFill: response missing 'edits' array")
    }

    const edits: FileEdit[] = parsed.edits
      .filter(
        (e: any) =>
          typeof e.file === "string" && Array.isArray(e.replacements)
      )
      .map((e: any) => ({
        file: e.file,
        replacements: e.replacements
          .filter(
            (r: any) =>
              typeof r.find === "string" && typeof r.replace === "string"
          )
          .map((r: any) => ({ find: r.find, replace: r.replace })),
      }))
      .filter((e: FileEdit) => e.replacements.length > 0)

    const contentFiles: ContentFileOutput[] = (parsed.contentFiles || [])
      .filter(
        (cf: any) => typeof cf.file === "string" && cf.content !== undefined
      )
      .map((cf: any) => ({
        file: cf.file,
        content:
          typeof cf.content === "string"
            ? cf.content
            : JSON.stringify(cf.content, null, 2),
      }))

    return {
      edits,
      contentFiles,
      modelUsed: this.config.model,
      latencyMs: Date.now() - startTime,
    }
  }

  private extractAndParseJson(text: string): any {
    // Try direct parse
    try {
      return JSON.parse(text)
    } catch {
      // continue
    }

    // Try extracting from markdown code block
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim())
      } catch {
        // continue
      }
    }

    // Try finding outermost { ... } containing "edits"
    const startIdx = text.indexOf('{"edits"')
    const altIdx = startIdx === -1 ? text.indexOf('{  "edits"') : -1
    const braceIdx = startIdx !== -1 ? startIdx : altIdx !== -1 ? altIdx : -1
    if (braceIdx !== -1) {
      let depth = 0
      for (let i = braceIdx; i < text.length; i++) {
        if (text[i] === "{") depth++
        else if (text[i] === "}") depth--
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(braceIdx, i + 1))
          } catch {
            return null
          }
        }
      }
    }

    return null
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
