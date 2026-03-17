import { readFile, readdir, stat } from "fs/promises"
import { join, relative, basename, dirname } from "path"
import { SKIP_DIRS, SCANNABLE_EXTS, PLACEHOLDER_RE } from "./constants"
import { ImplementationReport, PlaceholderEntry, FileEntry, ContentFileEntry } from "../switcher/types"

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024
const CONTEXT_LINES = 2

export interface ScanResult {
  file: string
  relativePath: string
  line: number
  placeholder: string
  context: string
  lineContent: string
}

export async function scanProjectPlaceholders(
  projectPath: string,
  maxFileSizeBytes: number = DEFAULT_MAX_FILE_SIZE
): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  await walkDirectory(projectPath, projectPath, results, maxFileSizeBytes)
  return results
}

async function walkDirectory(
  dir: string,
  projectPath: string,
  results: ScanResult[],
  maxFileSizeBytes: number
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walkDirectory(fullPath, projectPath, results, maxFileSizeBytes)
        continue
      }

      if (!entry.isFile()) continue

      const ext = entry.name.split(".").pop()?.toLowerCase()
      if (!ext || !SCANNABLE_EXTS.has(ext)) continue

      try {
        const fileStat = await stat(fullPath)
        if (fileStat.size > maxFileSizeBytes) continue

        const content = await readFile(fullPath, "utf-8")
        const lines = content.split("\n")

        for (let i = 0; i < lines.length; i++) {
          const re = new RegExp(PLACEHOLDER_RE.source, "g")
          let match: RegExpExecArray | null
          while ((match = re.exec(lines[i])) !== null) {
            const contextStart = Math.max(0, i - CONTEXT_LINES)
            const contextEnd = Math.min(lines.length - 1, i + CONTEXT_LINES)
            const contextSlice = lines.slice(contextStart, contextEnd + 1).join("\n")

            results.push({
              file: fullPath,
              relativePath: relative(projectPath, fullPath),
              line: i + 1,
              placeholder: match[0],
              context: contextSlice,
              lineContent: lines[i],
            })
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

export function inferPlaceholderType(
  lineContent: string,
  placeholder: string
): PlaceholderEntry["type"] {
  const idx = lineContent.indexOf(placeholder)
  const before = lineContent.slice(0, idx).trimEnd()
  const after = lineContent.slice(idx + placeholder.length).trimStart()

  // Check style context
  if (/className\s*[=:]\s*$/.test(before) || /style\s*[=:]\s*$/.test(before)) {
    return "style"
  }

  // Check logic context
  if (/\b(if|else|switch|case|\?|&&|\|\||return)\s*[\(]?\s*$/.test(before)) {
    return "logic"
  }
  if (/^\s*\?/.test(after) || /^\s*&&/.test(after) || /^\s*\|\|/.test(after)) {
    return "logic"
  }

  // Check array
  if (/^\s*\[/.test(after)) {
    return "array"
  }

  // Check object
  if (/^\s*\{/.test(after)) {
    return "object"
  }

  // Check number context
  if (/[:=]\s*$/.test(before) && /^\s*[,;\n\r)\]}]/.test(after)) {
    // Ambiguous, but inside quotes means string
    if (before.endsWith('"') || before.endsWith("'") || before.endsWith("`")) {
      return "string"
    }
  }

  // Inside quotes
  if (
    (before.endsWith('"') && after.startsWith('"')) ||
    (before.endsWith("'") && after.startsWith("'")) ||
    (before.endsWith("`") && after.startsWith("`"))
  ) {
    return "string"
  }

  return "string"
}

export function buildSyntheticReport(
  projectPath: string,
  scanResults: ScanResult[]
): ImplementationReport {
  const placeholders: PlaceholderEntry[] = scanResults.map((sr) => ({
    id: sr.placeholder.replace(/\{\{|\}\}/g, ""),
    file: sr.relativePath,
    line: sr.line,
    type: inferPlaceholderType(sr.lineContent, sr.placeholder),
    currentValue: sr.placeholder,
    context: sr.context,
  }))

  // Deduplicate files
  const fileSet = new Map<string, FileEntry>()
  for (const sr of scanResults) {
    if (!fileSet.has(sr.relativePath)) {
      const ext = sr.relativePath.split(".").pop()?.toLowerCase() || ""
      fileSet.set(sr.relativePath, {
        path: sr.relativePath,
        action: "modified",
        purpose: `Contains ${scanResults.filter((s) => s.relativePath === sr.relativePath).length} placeholder(s)`,
        linesOfCode: 0,
      })
    }
  }

  // Identify content files: .json files under content/ or data/ dirs
  const contentFiles: ContentFileEntry[] = []
  const contentDirs = ["content", "data"]
  const seenContentPaths = new Set<string>()
  for (const sr of scanResults) {
    const dir = dirname(sr.relativePath)
    const ext = sr.relativePath.split(".").pop()?.toLowerCase()
    const isContentDir = contentDirs.some(
      (cd) => dir === cd || dir.startsWith(cd + "/")
    )
    if (ext === "json" && isContentDir && !seenContentPaths.has(sr.relativePath)) {
      seenContentPaths.add(sr.relativePath)
      const filePlaceholders = scanResults
        .filter((s) => s.relativePath === sr.relativePath)
        .map((s) => s.placeholder)
      contentFiles.push({
        path: sr.relativePath,
        schema: {},
        placeholderPaths: filePlaceholders,
      })
    }
  }

  // Infer tech stack from file extensions
  const extSet = new Set<string>()
  for (const sr of scanResults) {
    const ext = sr.relativePath.split(".").pop()?.toLowerCase()
    if (ext) extSet.add(ext)
  }
  const techStack: string[] = []
  if (extSet.has("tsx") || extSet.has("jsx")) techStack.push("React")
  if (extSet.has("ts") || extSet.has("tsx")) techStack.push("TypeScript")
  if (extSet.has("js") || extSet.has("jsx")) techStack.push("JavaScript")
  if (extSet.has("css")) techStack.push("CSS")

  // Build component tree from file paths
  const componentTree = [...fileSet.keys()].sort().join("\n")

  return {
    summary: `Synthetic report: ${placeholders.length} placeholder(s) found across ${fileSet.size} file(s)`,
    files: [...fileSet.values()],
    placeholders,
    contentFiles,
    buildStatus: "success",
    techStack,
    componentTree,
  }
}
