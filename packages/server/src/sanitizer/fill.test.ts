import { describe, it, expect } from "vitest"
import { NsfwFillService } from "./fill"
import {
  NsfwAgentConfig,
  NsfwSpec,
  ImplementationReport,
} from "../switcher/types"
import { vi } from "vitest"

const CONFIG: NsfwAgentConfig = {
  model: "test-model",
  apiKey: "test-key",
  apiUrl: "http://localhost:9999",
  timeoutMs: 5000,
  maxTokens: 4096,
  maxRetries: 1,
  retryDelayMs: 10,
}

const noopLogger = {
  child: () => noopLogger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const SPEC: NsfwSpec = {
  contentChanges: [{ file: "content/data.json", path: "title", description: "Adult title" }],
  codeChanges: [{ type: "string", placeholder: "{{NSFW_TITLE}}", description: "Strip Poker", location: "Header" }],
  context: "Adult card game",
}

const REPORT: ImplementationReport = {
  summary: "Card game app",
  files: [{ path: "src/app.tsx", action: "created", purpose: "Main app", linesOfCode: 100 }],
  placeholders: [
    { id: "{{NSFW_TITLE}}", file: "src/app.tsx", line: 5, type: "string", currentValue: "{{NSFW_TITLE}}", context: "const title = ..." },
    { id: "{{NSFW_DESC}}", file: "src/app.tsx", line: 10, type: "string", currentValue: "{{NSFW_DESC}}", context: "const desc = ..." },
  ],
  contentFiles: [{ path: "content/data.json", schema: { type: "object" }, placeholderPaths: ["title"] }],
  buildStatus: "success",
  techStack: ["react"],
  componentTree: "App > Header",
}

describe("NsfwFillService", () => {
  describe("buildFillPrompt", () => {
    it("builds prompt with placeholders grouped by file", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const { system, user } = service.buildFillPrompt(SPEC, REPORT)

      expect(system).toContain("content specialist")
      expect(user).toContain("{{NSFW_TITLE}}")
      expect(user).toContain("{{NSFW_DESC}}")
      expect(user).toContain("File: src/app.tsx")
      expect(user).toContain("Adult card game")
      expect(user).toContain("Generate replacements for all 2 placeholders")
    })

    it("handles empty placeholders", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const emptyReport: ImplementationReport = {
        ...REPORT,
        placeholders: [],
        contentFiles: [],
      }
      const { user } = service.buildFillPrompt(SPEC, emptyReport)
      expect(user).toContain("Generate replacements for all 0 placeholders")
    })

    it("includes content file schema in prompt", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const { user } = service.buildFillPrompt(SPEC, REPORT)
      expect(user).toContain("content/data.json")
      expect(user).toContain("title")
    })
  })

  describe("parseFillResult", () => {
    it("parses valid JSON response", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const json = JSON.stringify({
        edits: [
          { file: "src/app.tsx", replacements: [{ find: "{{NSFW_TITLE}}", replace: "Strip Poker" }] },
        ],
        contentFiles: [{ file: "content/data.json", content: { title: "Adult" } }],
      })

      const result = service.parseFillResult(json, Date.now() - 100)
      expect(result.edits).toHaveLength(1)
      expect(result.edits[0].replacements[0].replace).toBe("Strip Poker")
      expect(result.contentFiles).toHaveLength(1)
      expect(result.contentFiles[0].content).toBe('{\n  "title": "Adult"\n}')
    })

    it("parses JSON wrapped in markdown code block", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const json = JSON.stringify({
        edits: [{ file: "a.ts", replacements: [{ find: "x", replace: "y" }] }],
      })
      const wrapped = "```json\n" + json + "\n```"

      const result = service.parseFillResult(wrapped, Date.now())
      expect(result.edits).toHaveLength(1)
    })

    it("parses JSON embedded in surrounding text", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const json = JSON.stringify({
        edits: [{ file: "a.ts", replacements: [{ find: "x", replace: "y" }] }],
      })
      const embedded = "Here is the result:\n" + json + "\nDone!"

      const result = service.parseFillResult(embedded, Date.now())
      expect(result.edits).toHaveLength(1)
    })

    it("throws on completely invalid response", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      expect(() => service.parseFillResult("not json at all", Date.now())).toThrow("could not parse JSON")
    })

    it("throws when edits array is missing", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      expect(() => service.parseFillResult('{"foo": "bar"}', Date.now())).toThrow("missing 'edits'")
    })

    it("filters out invalid edit entries", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const json = JSON.stringify({
        edits: [
          { file: "a.ts", replacements: [{ find: "x", replace: "y" }] },
          { noFile: true, replacements: [] },
          { file: "b.ts", replacements: [{ find: 123, replace: null }] },
        ],
      })

      const result = service.parseFillResult(json, Date.now())
      expect(result.edits).toHaveLength(1)
      expect(result.edits[0].file).toBe("a.ts")
    })

    it("handles string content in contentFiles", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const json = JSON.stringify({
        edits: [{ file: "a.ts", replacements: [{ find: "x", replace: "y" }] }],
        contentFiles: [{ file: "data.json", content: "raw string content" }],
      })

      const result = service.parseFillResult(json, Date.now())
      expect(result.contentFiles[0].content).toBe("raw string content")
    })

    it("records latency", () => {
      const service = new NsfwFillService(CONFIG, noopLogger)
      const json = JSON.stringify({
        edits: [{ file: "a.ts", replacements: [{ find: "x", replace: "y" }] }],
      })

      const result = service.parseFillResult(json, Date.now() - 500)
      expect(result.latencyMs).toBeGreaterThanOrEqual(450)
    })
  })
})
