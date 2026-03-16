import { describe, it, expect } from "vitest"
import { ReportAccumulator } from "./report"
import { SfwAgentConfig } from "../switcher/types"

const CONFIG: SfwAgentConfig = {
  reportMarkerStart: "<<<REPORT>>>",
  reportMarkerEnd: "<<<END_REPORT>>>",
  storeMaxSize: 100,
  storeTtlMs: 3600000,
}

const VALID_REPORT = JSON.stringify({
  summary: "Test app",
  files: [{ path: "src/app.ts", action: "created", purpose: "Main app", linesOfCode: 50 }],
  placeholders: [{ id: "{{NSFW_TITLE}}", file: "src/app.ts", line: 1, type: "string", currentValue: "{{NSFW_TITLE}}", context: "title" }],
  contentFiles: [],
  buildStatus: "success",
  techStack: ["react"],
  componentTree: "App",
})

describe("ReportAccumulator", () => {
  it("extracts report from a single chunk", () => {
    const acc = new ReportAccumulator(CONFIG)
    const result = acc.addChunk(`Some text <<<REPORT>>>${VALID_REPORT}<<<END_REPORT>>> more text`)
    expect(result).not.toBeNull()
    expect(result!.summary).toBe("Test app")
    expect(result!.placeholders).toHaveLength(1)
    expect(result!.placeholders[0].id).toBe("{{NSFW_TITLE}}")
  })

  it("extracts report split across multiple chunks", () => {
    const acc = new ReportAccumulator(CONFIG)
    const full = `prefix <<<REPORT>>>${VALID_REPORT}<<<END_REPORT>>> suffix`

    expect(acc.addChunk(full.slice(0, 20))).toBeNull()
    expect(acc.addChunk(full.slice(20, 100))).toBeNull()
    const result = acc.addChunk(full.slice(100))
    expect(result).not.toBeNull()
    expect(result!.summary).toBe("Test app")
  })

  it("returns null when start marker is missing", () => {
    const acc = new ReportAccumulator(CONFIG)
    const result = acc.addChunk(`${VALID_REPORT}<<<END_REPORT>>>`)
    expect(result).toBeNull()
  })

  it("returns null when end marker is missing", () => {
    const acc = new ReportAccumulator(CONFIG)
    const result = acc.addChunk(`<<<REPORT>>>${VALID_REPORT}`)
    expect(result).toBeNull()
  })

  it("returns null for malformed JSON between markers", () => {
    const acc = new ReportAccumulator(CONFIG)
    const result = acc.addChunk("<<<REPORT>>>{ not valid json <<<END_REPORT>>>")
    expect(result).toBeNull()
  })

  it("returns null for JSON missing required fields", () => {
    const acc = new ReportAccumulator(CONFIG)
    const result = acc.addChunk('<<<REPORT>>>{"foo": "bar"}<<<END_REPORT>>>')
    expect(result).toBeNull()
  })

  it("validates placeholder entries — rejects invalid ones", () => {
    const acc = new ReportAccumulator(CONFIG)
    const report = JSON.stringify({
      summary: "Test",
      files: [],
      placeholders: [
        { id: "{{NSFW_A}}", file: "a.ts", line: 1, type: "string", currentValue: "x", context: "y" },
        { id: null, file: "b.ts" },
        { missing: "fields" },
      ],
      contentFiles: [],
      buildStatus: "success",
      techStack: [],
      componentTree: "",
    })
    const result = acc.addChunk(`<<<REPORT>>>${report}<<<END_REPORT>>>`)
    expect(result).not.toBeNull()
    expect(result!.placeholders).toHaveLength(1)
    expect(result!.placeholders[0].id).toBe("{{NSFW_A}}")
  })

  it("returns null when all placeholders are invalid", () => {
    const acc = new ReportAccumulator(CONFIG)
    const report = JSON.stringify({
      summary: "Test",
      files: [],
      placeholders: [{ missing: "id" }, { also: "bad" }],
      contentFiles: [],
      buildStatus: "success",
      techStack: [],
      componentTree: "",
    })
    const result = acc.addChunk(`<<<REPORT>>>${report}<<<END_REPORT>>>`)
    expect(result).toBeNull()
  })

  it("validates file entries", () => {
    const acc = new ReportAccumulator(CONFIG)
    const report = JSON.stringify({
      summary: "Test",
      files: [
        { path: "a.ts", action: "created", purpose: "x", linesOfCode: 10 },
        { noPath: true },
      ],
      placeholders: [{ id: "{{NSFW_A}}", file: "a.ts", line: 1, type: "string", currentValue: "x", context: "y" }],
      contentFiles: [],
      buildStatus: "success",
      techStack: [],
      componentTree: "",
    })
    const result = acc.addChunk(`<<<REPORT>>>${report}<<<END_REPORT>>>`)
    expect(result).not.toBeNull()
    expect(result!.files).toHaveLength(1)
  })

  it("resets buffer correctly", () => {
    const acc = new ReportAccumulator(CONFIG)
    acc.addChunk("<<<REPORT>>>")
    acc.reset()
    const result = acc.addChunk(`<<<REPORT>>>${VALID_REPORT}<<<END_REPORT>>>`)
    expect(result).not.toBeNull()
  })

  it("stops accumulating past buffer limit", () => {
    const acc = new ReportAccumulator(CONFIG)
    // Feed 3MB of data before the markers
    const bigChunk = "x".repeat(3 * 1024 * 1024)
    acc.addChunk(bigChunk)
    const result = acc.addChunk(`<<<REPORT>>>${VALID_REPORT}<<<END_REPORT>>>`)
    expect(result).toBeNull()
  })
})
