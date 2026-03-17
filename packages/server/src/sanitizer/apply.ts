import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises"
import { existsSync } from "fs"
import { resolve, join } from "path"
import { execFile } from "child_process"
import {
  ApplyConfig,
  ApplyResult,
  FillResult,
  FileApplyResult,
  ContentFileApplyResult,
  PlaceholderScanResult,
} from "../switcher/types"
import { SKIP_DIRS, SCANNABLE_EXTS, PLACEHOLDER_RE } from "./constants"

// ── Error Classification ──

type ApplyErrorKind =
  | "validation_error"
  | "file_not_found"
  | "permission_denied"
  | "path_traversal"
  | "file_too_large"
  | "build_failed"
  | "git_error"
  | "partial_apply"

class ApplyError extends Error {
  readonly kind: ApplyErrorKind

  constructor(kind: ApplyErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

// ── Forbidden system directories ──

const FORBIDDEN_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/var", "/tmp", "/dev", "/proc", "/sys"]


export class ApplyService {
  private readonly config: ApplyConfig
  private readonly logger: any

  constructor(config: ApplyConfig, parentLogger: any) {
    this.config = config
    this.logger = parentLogger.child({ module: "apply-service" })

    this.logger.info(
      {
        buildCommand: this.config.buildCommand,
        buildTimeoutMs: this.config.buildTimeoutMs,
        gitEnabled: this.config.gitEnabled,
        maxFileSizeBytes: this.config.maxFileSizeBytes,
      },
      "ApplyService: initialized"
    )
  }

  async executeApply(fillResult: FillResult, projectPath: string, options?: { skipBuild?: boolean }): Promise<ApplyResult> {
    const startTime = Date.now()
    const skipBuild = !!options?.skipBuild

    if (fillResult.edits.length === 0 && fillResult.contentFiles.length === 0) {
      this.logger.info("ApplyService: empty fillResult, nothing to apply")
      return {
        editsApplied: [],
        contentFilesWritten: [],
        totalReplacementsApplied: 0,
        totalContentFilesWritten: 0,
        remainingPlaceholders: [],
        buildVerification: { attempted: false, success: true },
        rolledBack: false,
        latencyMs: Date.now() - startTime,
      }
    }

    this.validateProjectPath(projectPath)

    const isGitRepo = !skipBuild && this.config.gitEnabled && existsSync(join(projectPath, ".git"))
    let snapshotHash: string | null = null

    if (isGitRepo) {
      try {
        snapshotHash = await this.createGitSnapshot(projectPath)
      } catch (err: any) {
        this.logger.warn({ error: err.message }, "ApplyService: git snapshot failed, proceeding without rollback safety")
      }
    } else if (!skipBuild && this.config.gitEnabled) {
      this.logger.warn("ApplyService: gitEnabled but project is not a git repo, proceeding without git")
    }

    const editsApplied = await this.applyFileEdits(projectPath, fillResult)
    const contentFilesWritten = await this.writeContentFiles(projectPath, fillResult)
    const remainingPlaceholders = await this.scanPlaceholders(projectPath)

    const totalReplacementsApplied = editsApplied.reduce((sum, e) => sum + e.replacementsApplied, 0)
    const totalContentFilesWritten = contentFilesWritten.filter((c) => c.status !== "error").length

    if (skipBuild) {
      const latencyMs = Date.now() - startTime
      this.logger.info(
        { totalReplacementsApplied, totalContentFilesWritten, remainingPlaceholders: remainingPlaceholders.length, skipBuild, latencyMs },
        "ApplyService: apply complete (build skipped)"
      )
      return {
        editsApplied,
        contentFilesWritten,
        totalReplacementsApplied,
        totalContentFilesWritten,
        remainingPlaceholders,
        buildVerification: { attempted: false, success: true },
        rolledBack: false,
        latencyMs,
      }
    }

    this.logger.info(
      {
        totalReplacementsApplied,
        totalContentFilesWritten,
        remainingPlaceholders: remainingPlaceholders.length,
      },
      "ApplyService: edits applied, verifying build"
    )

    const buildVerification = await this.verifyBuild(projectPath)
    let rolledBack = false

    if (!buildVerification.success && snapshotHash) {
      this.logger.warn("ApplyService: build failed, rolling back")
      try {
        await this.gitRollback(projectPath, snapshotHash)
        rolledBack = true
      } catch (err: any) {
        this.logger.error({ error: err.message }, "ApplyService: rollback failed")
      }
    } else if (buildVerification.success && isGitRepo) {
      try {
        await this.gitCommitApply(projectPath, this.config.gitCommitMessage)
      } catch (err: any) {
        this.logger.warn({ error: err.message }, "ApplyService: post-apply commit failed")
      }
    }

    const latencyMs = Date.now() - startTime
    this.logger.info(
      { totalReplacementsApplied, totalContentFilesWritten, rolledBack, latencyMs },
      "ApplyService: apply complete"
    )

    return {
      editsApplied,
      contentFilesWritten,
      totalReplacementsApplied,
      totalContentFilesWritten,
      remainingPlaceholders,
      buildVerification,
      rolledBack,
      latencyMs,
    }
  }

  private validateProjectPath(projectPath: string): void {
    if (!projectPath || typeof projectPath !== "string") {
      throw new ApplyError("validation_error", "projectPath is required")
    }

    if (!resolve(projectPath).startsWith("/")) {
      throw new ApplyError("validation_error", "projectPath must be absolute")
    }

    if (projectPath.includes("\0")) {
      throw new ApplyError("path_traversal", "projectPath contains null bytes")
    }

    if (projectPath.includes("..")) {
      throw new ApplyError("path_traversal", "projectPath contains '..' traversal")
    }

    const resolved = resolve(projectPath)
    if (resolved === "/") {
      throw new ApplyError("path_traversal", "projectPath cannot be root")
    }

    for (const prefix of FORBIDDEN_PREFIXES) {
      if (resolved === prefix || resolved.startsWith(prefix + "/")) {
        throw new ApplyError("path_traversal", `projectPath cannot be under ${prefix}`)
      }
    }

    if (!existsSync(resolved)) {
      throw new ApplyError("file_not_found", `projectPath does not exist: ${resolved}`)
    }
  }

  private resolveAndValidatePath(projectPath: string, relativePath: string): string {
    if (relativePath.includes("\0")) {
      throw new ApplyError("path_traversal", `File path contains null bytes: ${relativePath}`)
    }

    const resolved = resolve(projectPath, relativePath)
    const normalizedProject = resolve(projectPath)

    if (!resolved.startsWith(normalizedProject + "/") && resolved !== normalizedProject) {
      throw new ApplyError("path_traversal", `Path escapes project: ${relativePath}`)
    }

    return resolved
  }

  private async applyFileEdits(projectPath: string, fillResult: FillResult): Promise<FileApplyResult[]> {
    const results: FileApplyResult[] = []

    for (const edit of fillResult.edits) {
      try {
        const filePath = this.resolveAndValidatePath(projectPath, edit.file)

        if (!existsSync(filePath)) {
          this.logger.warn({ file: edit.file }, "ApplyService: file not found, skipping")
          results.push({ file: edit.file, replacementsApplied: 0, status: "skipped", error: "File not found" })
          continue
        }

        const fileStat = await stat(filePath)
        if (fileStat.size > this.config.maxFileSizeBytes) {
          this.logger.warn({ file: edit.file, size: fileStat.size }, "ApplyService: file too large, skipping")
          results.push({ file: edit.file, replacementsApplied: 0, status: "skipped", error: `File too large: ${fileStat.size} bytes` })
          continue
        }

        let content = await readFile(filePath, "utf-8")
        let replacementsApplied = 0

        for (const replacement of edit.replacements) {
          const before = content
          content = content.replaceAll(replacement.find, replacement.replace)
          if (content !== before) {
            const occurrences = (before.split(replacement.find).length - 1)
            replacementsApplied += occurrences
          } else {
            this.logger.warn(
              { file: edit.file, placeholder: replacement.find },
              "ApplyService: placeholder not found in file"
            )
          }
        }

        const resultSize = Buffer.byteLength(content, "utf-8")
        if (resultSize > this.config.maxFileSizeBytes) {
          throw new ApplyError(
            "file_too_large",
            `File ${edit.file} grew to ${resultSize} bytes after edits, max is ${this.config.maxFileSizeBytes}`
          )
        }

        await writeFile(filePath, content, "utf-8")
        results.push({ file: edit.file, replacementsApplied, status: "success" })
      } catch (err: any) {
        if (err instanceof ApplyError) throw err
        this.logger.error({ file: edit.file, error: err.message }, "ApplyService: error applying edits")
        results.push({ file: edit.file, replacementsApplied: 0, status: "error", error: err.message })
      }
    }

    return results
  }

  private async writeContentFiles(projectPath: string, fillResult: FillResult): Promise<ContentFileApplyResult[]> {
    const results: ContentFileApplyResult[] = []

    for (const cf of fillResult.contentFiles) {
      try {
        const filePath = this.resolveAndValidatePath(projectPath, cf.file)
        const contentBuffer = Buffer.from(cf.content, "utf-8")

        if (contentBuffer.length > this.config.maxFileSizeBytes) {
          throw new ApplyError(
            "file_too_large",
            `Content file ${cf.file} is ${contentBuffer.length} bytes, max is ${this.config.maxFileSizeBytes}`
          )
        }

        const dir = resolve(filePath, "..")
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true })
        }

        const existed = existsSync(filePath)
        await writeFile(filePath, cf.content, "utf-8")
        results.push({ file: cf.file, status: existed ? "overwritten" : "created" })
      } catch (err: any) {
        if (err instanceof ApplyError) throw err
        this.logger.error({ file: cf.file, error: err.message }, "ApplyService: error writing content file")
        results.push({ file: cf.file, status: "error", error: err.message })
      }
    }

    return results
  }

  private async scanPlaceholders(projectPath: string): Promise<PlaceholderScanResult[]> {
    const results: PlaceholderScanResult[] = []
    // Scan entire project, not just src/ and content/
    await this.scanDirectory(projectPath, results)
    return results
  }

  private async scanDirectory(dir: string, results: PlaceholderScanResult[]): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)

        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          await this.scanDirectory(fullPath, results)
          continue
        }

        if (!entry.isFile()) continue

        const ext = entry.name.split(".").pop()?.toLowerCase()
        if (!ext || !SCANNABLE_EXTS.has(ext)) continue

        try {
          const fileStat = await stat(fullPath)
          if (fileStat.size > this.config.maxFileSizeBytes) continue

          const content = await readFile(fullPath, "utf-8")
          const lines = content.split("\n")

          for (let i = 0; i < lines.length; i++) {
            const re = new RegExp(PLACEHOLDER_RE.source, "g")
            let match: RegExpExecArray | null
            while ((match = re.exec(lines[i])) !== null) {
              results.push({
                file: fullPath,
                line: i + 1,
                placeholder: match[0],
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

  private async verifyBuild(projectPath: string): Promise<ApplyResult["buildVerification"]> {
    try {
      const output = await this.execShell(this.config.buildCommand, projectPath, this.config.buildTimeoutMs)
      return { attempted: true, success: true, output: output.slice(-2000) }
    } catch (err: any) {
      return {
        attempted: true,
        success: false,
        error: err.message?.slice(0, 2000),
        output: err.stdout?.slice(-2000),
      }
    }
  }

  private async createGitSnapshot(projectPath: string): Promise<string> {
    try {
      await this.execGit(["add", "-A"], projectPath)
    } catch {
      // Nothing to add is fine
    }

    try {
      await this.execGit(["commit", "-m", "pre-apply snapshot", "--allow-empty"], projectPath)
    } catch {
      // Nothing to commit is fine
    }

    const hash = await this.execGit(["rev-parse", "HEAD"], projectPath)
    return hash.trim()
  }

  private async gitRollback(projectPath: string, snapshotHash: string): Promise<void> {
    await this.execGit(["reset", "--hard", snapshotHash], projectPath)
    await this.execGit(["clean", "-fd"], projectPath)
  }

  private async gitCommitApply(projectPath: string, message: string): Promise<void> {
    await this.execGit(["add", "-A"], projectPath)
    try {
      await this.execGit(["commit", "-m", message], projectPath)
    } catch {
      // Nothing to commit (edits may have been no-ops)
    }
  }

  private execGit(args: string[], cwd: string, timeoutMs = 30000): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, CI: "true" },
        },
        (error, stdout, stderr) => {
          if (error) {
            const enriched: any = new Error(`git ${args[0]} failed: ${stderr || stdout}`)
            enriched.stdout = stdout
            enriched.stderr = stderr
            reject(enriched)
            return
          }
          resolvePromise(stdout)
        }
      )
    })
  }

  private execShell(command: string, cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, CI: "true" },
        },
        (error, stdout, stderr) => {
          if (error) {
            const enriched: any = new Error(`Command failed: ${command}\n${stderr || stdout}`)
            enriched.stdout = stdout
            enriched.stderr = stderr
            reject(enriched)
            return
          }
          resolvePromise(stdout)
        }
      )
    })
  }
}
