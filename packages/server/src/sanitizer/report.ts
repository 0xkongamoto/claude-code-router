import { ImplementationReport, SfwAgentConfig } from "../switcher/types"

const MAX_BUFFER_SIZE = 2 * 1024 * 1024

export class ReportAccumulator {
  private textBuffer: string = ""
  private readonly markerStart: string
  private readonly markerEnd: string

  constructor(config: SfwAgentConfig) {
    this.markerStart = config.reportMarkerStart
    this.markerEnd = config.reportMarkerEnd
  }

  addChunk(text: string): ImplementationReport | null {
    if (this.textBuffer.length > MAX_BUFFER_SIZE) return null
    this.textBuffer += text
    return this.tryExtract()
  }

  reset(): void {
    this.textBuffer = ""
  }

  private tryExtract(): ImplementationReport | null {
    const startIdx = this.textBuffer.indexOf(this.markerStart)
    if (startIdx === -1) return null

    const endIdx = this.textBuffer.indexOf(this.markerEnd, startIdx + this.markerStart.length)
    if (endIdx === -1) return null

    const jsonStr = this.textBuffer.slice(
      startIdx + this.markerStart.length,
      endIdx
    ).trim()

    return parseImplementationReport(jsonStr)
  }
}

function parseImplementationReport(jsonStr: string): ImplementationReport | null {
  try {
    const parsed = JSON.parse(jsonStr)

    if (typeof parsed.summary !== "string") return null
    if (!Array.isArray(parsed.files)) return null
    if (!Array.isArray(parsed.placeholders)) return null

    const validFiles = parsed.files.filter(
      (f: any) =>
        typeof f.path === "string" &&
        typeof f.action === "string"
    )

    const validPlaceholders = parsed.placeholders.filter(
      (p: any) =>
        typeof p.id === "string" &&
        typeof p.file === "string" &&
        typeof p.line === "number"
    )

    if (validPlaceholders.length === 0 && parsed.placeholders.length > 0) {
      return null
    }

    const validContentFiles = Array.isArray(parsed.contentFiles)
      ? parsed.contentFiles.filter(
          (cf: any) =>
            typeof cf.path === "string" &&
            Array.isArray(cf.placeholderPaths)
        )
      : []

    return {
      summary: parsed.summary,
      files: validFiles,
      placeholders: validPlaceholders,
      contentFiles: validContentFiles,
      buildStatus: parsed.buildStatus === "warning" ? "warning" : "success",
      techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
      componentTree: typeof parsed.componentTree === "string" ? parsed.componentTree : "",
    }
  } catch {
    return null
  }
}
