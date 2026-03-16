import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, writeFile, mkdir, readFile, rm } from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { execSync } from "child_process"
import { ApplyService } from "./apply"
import { ApplyConfig, FillResult } from "../switcher/types"

// ── Helpers ──

const DEFAULT_CONFIG: ApplyConfig = {
  buildCommand: "echo build-ok",
  buildTimeoutMs: 10000,
  gitEnabled: false,
  gitCommitMessage: "test: apply",
  maxFileSizeBytes: 1048576,
}

// Use home dir to avoid /var forbidden prefix (macOS tmpdir resolves to /var/folders)
const TEST_TMP_BASE = join(homedir(), ".apply-test-tmp")

const noopLogger = {
  child: () => noopLogger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

function createFillResult(overrides: Partial<FillResult> = {}): FillResult {
  return {
    edits: [],
    contentFiles: [],
    modelUsed: "test-model",
    latencyMs: 100,
    ...overrides,
  }
}

async function createTempProject(): Promise<string> {
  await mkdir(TEST_TMP_BASE, { recursive: true })
  const dir = await mkdtemp(join(TEST_TMP_BASE, "test-"))
  await mkdir(join(dir, "src"), { recursive: true })
  return dir
}

async function initGitRepo(dir: string): Promise<void> {
  execSync("git init && git add -A && git commit -m 'init' --allow-empty", {
    cwd: dir,
    stdio: "ignore",
  })
}

// ── Tests ──

describe("ApplyService", () => {
  let projectDir: string
  let service: ApplyService

  beforeEach(async () => {
    projectDir = await createTempProject()
    service = new ApplyService(DEFAULT_CONFIG, noopLogger)
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  // ── Path Validation ──

  describe("validateProjectPath", () => {
    it("rejects relative paths", async () => {
      const fill = createFillResult({ edits: [{ file: "a.ts", replacements: [{ find: "a", replace: "b" }] }] })
      await expect(service.executeApply(fill, "relative/path")).rejects.toThrow("does not exist")
    })

    it("rejects paths with '..' traversal", async () => {
      const fill = createFillResult({ edits: [{ file: "a.ts", replacements: [{ find: "a", replace: "b" }] }] })
      await expect(service.executeApply(fill, "/tmp/../etc/passwd")).rejects.toThrow("traversal")
    })

    it("rejects null bytes in path", async () => {
      const fill = createFillResult({ edits: [{ file: "a.ts", replacements: [{ find: "a", replace: "b" }] }] })
      await expect(service.executeApply(fill, "/tmp/project\0evil")).rejects.toThrow("null bytes")
    })

    it("rejects root path", async () => {
      const fill = createFillResult({ edits: [{ file: "a.ts", replacements: [{ find: "a", replace: "b" }] }] })
      await expect(service.executeApply(fill, "/")).rejects.toThrow("cannot be root")
    })

    it("rejects system directories", async () => {
      const fill = createFillResult({ edits: [{ file: "a.ts", replacements: [{ find: "a", replace: "b" }] }] })
      await expect(service.executeApply(fill, "/etc")).rejects.toThrow("cannot be under /etc")
      await expect(service.executeApply(fill, "/usr/local")).rejects.toThrow("cannot be under /usr")
    })

    it("rejects non-existent path", async () => {
      const fill = createFillResult({ edits: [{ file: "a.ts", replacements: [{ find: "a", replace: "b" }] }] })
      const fakePath = join(homedir(), "nonexistent-apply-test-" + Date.now())
      await expect(service.executeApply(fill, fakePath)).rejects.toThrow("does not exist")
    })

    it("accepts valid project path", async () => {
      const fill = createFillResult()
      const result = await service.executeApply(fill, projectDir)
      expect(result.rolledBack).toBe(false)
    })
  })

  // ── Path Traversal in File Edits ──

  describe("path traversal in file references", () => {
    it("rejects edits referencing files outside project", async () => {
      const fill = createFillResult({
        edits: [{ file: "../../../etc/passwd", replacements: [{ find: "a", replace: "b" }] }],
      })
      await expect(service.executeApply(fill, projectDir)).rejects.toThrow("escapes project")
    })

    it("rejects content files referencing paths outside project", async () => {
      const fill = createFillResult({
        contentFiles: [{ file: "../../../tmp/evil.json", content: "{}" }],
      })
      await expect(service.executeApply(fill, projectDir)).rejects.toThrow("escapes project")
    })
  })

  // ── Empty FillResult ──

  describe("empty fillResult", () => {
    it("returns immediately with zero counts", async () => {
      const fill = createFillResult()
      const result = await service.executeApply(fill, projectDir)

      expect(result.editsApplied).toEqual([])
      expect(result.contentFilesWritten).toEqual([])
      expect(result.totalReplacementsApplied).toBe(0)
      expect(result.totalContentFilesWritten).toBe(0)
      expect(result.rolledBack).toBe(false)
      expect(result.buildVerification.attempted).toBe(false)
    })
  })

  // ── File Edits ──

  describe("applyFileEdits", () => {
    it("replaces placeholders in existing files", async () => {
      const filePath = join(projectDir, "src", "app.ts")
      await writeFile(filePath, 'const title = "{{__SLOT_001__}}"\nconst desc = "{{__SLOT_002__}}"')

      const fill = createFillResult({
        edits: [
          {
            file: "src/app.ts",
            replacements: [
              { find: "{{__SLOT_001__}}", replace: "My Title" },
              { find: "{{__SLOT_002__}}", replace: "My Description" },
            ],
          },
        ],
      })

      const result = await service.executeApply(fill, projectDir)

      expect(result.editsApplied).toHaveLength(1)
      expect(result.editsApplied[0].status).toBe("success")
      expect(result.editsApplied[0].replacementsApplied).toBe(2)
      expect(result.totalReplacementsApplied).toBe(2)

      const content = await readFile(filePath, "utf-8")
      expect(content).toBe('const title = "My Title"\nconst desc = "My Description"')
    })

    it("replaces multiple occurrences of same placeholder", async () => {
      const filePath = join(projectDir, "src", "multi.ts")
      await writeFile(filePath, "{{__SLOT_003__}} and {{__SLOT_003__}} again")

      const fill = createFillResult({
        edits: [
          {
            file: "src/multi.ts",
            replacements: [{ find: "{{__SLOT_003__}}", replace: "replaced" }],
          },
        ],
      })

      const result = await service.executeApply(fill, projectDir)
      expect(result.editsApplied[0].replacementsApplied).toBe(2)

      const content = await readFile(filePath, "utf-8")
      expect(content).toBe("replaced and replaced again")
    })

    it("skips missing files without throwing", async () => {
      const fill = createFillResult({
        edits: [
          {
            file: "src/nonexistent.ts",
            replacements: [{ find: "{{__SLOT_003__}}", replace: "y" }],
          },
        ],
      })

      const result = await service.executeApply(fill, projectDir)
      expect(result.editsApplied).toHaveLength(1)
      expect(result.editsApplied[0].status).toBe("skipped")
      expect(result.editsApplied[0].error).toBe("File not found")
    })

    it("handles placeholder not found in file (0 replacements)", async () => {
      const filePath = join(projectDir, "src", "no-match.ts")
      await writeFile(filePath, "no placeholders here")

      const fill = createFillResult({
        edits: [
          {
            file: "src/no-match.ts",
            replacements: [{ find: "{{__SLOT_004__}}", replace: "value" }],
          },
        ],
      })

      const result = await service.executeApply(fill, projectDir)
      expect(result.editsApplied[0].status).toBe("success")
      expect(result.editsApplied[0].replacementsApplied).toBe(0)
    })
  })

  // ── Content Files ──

  describe("writeContentFiles", () => {
    it("creates new content files", async () => {
      const fill = createFillResult({
        contentFiles: [{ file: "content/data.json", content: '{"key": "value"}' }],
      })

      const result = await service.executeApply(fill, projectDir)

      expect(result.contentFilesWritten).toHaveLength(1)
      expect(result.contentFilesWritten[0].status).toBe("created")
      expect(result.totalContentFilesWritten).toBe(1)

      const content = await readFile(join(projectDir, "content", "data.json"), "utf-8")
      expect(content).toBe('{"key": "value"}')
    })

    it("overwrites existing content files", async () => {
      const contentDir = join(projectDir, "content")
      await mkdir(contentDir, { recursive: true })
      await writeFile(join(contentDir, "data.json"), "old content")

      const fill = createFillResult({
        contentFiles: [{ file: "content/data.json", content: "new content" }],
      })

      const result = await service.executeApply(fill, projectDir)
      expect(result.contentFilesWritten[0].status).toBe("overwritten")
    })

    it("creates nested directories", async () => {
      const fill = createFillResult({
        contentFiles: [{ file: "content/deep/nested/file.json", content: "{}" }],
      })

      const result = await service.executeApply(fill, projectDir)
      expect(result.contentFilesWritten[0].status).toBe("created")
      expect(existsSync(join(projectDir, "content", "deep", "nested", "file.json"))).toBe(true)
    })

    it("rejects files exceeding maxFileSizeBytes", async () => {
      const smallService = new ApplyService({ ...DEFAULT_CONFIG, maxFileSizeBytes: 10 }, noopLogger)
      const fill = createFillResult({
        contentFiles: [{ file: "content/big.json", content: "a".repeat(100) }],
      })

      await expect(smallService.executeApply(fill, projectDir)).rejects.toThrow("max is 10")
    })
  })

  // ── Placeholder Scanning ──

  describe("scanPlaceholders", () => {
    it("finds remaining placeholders in src/", async () => {
      await writeFile(join(projectDir, "src", "partial.ts"), 'const a = "{{__SLOT_005__}}"')
      // Need a non-empty fill to trigger the full apply flow (empty returns early)
      await writeFile(join(projectDir, "src", "other.ts"), "{{__SLOT_006__}}")
      const fill = createFillResult({
        edits: [{ file: "src/other.ts", replacements: [{ find: "{{__SLOT_006__}}", replace: "done" }] }],
      })
      const result = await service.executeApply(fill, projectDir)

      expect(result.remainingPlaceholders).toHaveLength(1)
      expect(result.remainingPlaceholders[0].placeholder).toBe("{{__SLOT_005__}}")
      expect(result.remainingPlaceholders[0].line).toBe(1)
    })

    it("finds placeholders in content/ directory", async () => {
      const contentDir = join(projectDir, "content")
      await mkdir(contentDir, { recursive: true })
      await writeFile(join(contentDir, "data.json"), '{"title": "{{__SLOT_001__}}"}')
      // Need a non-empty fill to trigger full flow
      await writeFile(join(projectDir, "src", "dummy.ts"), "{{__SLOT_003__}}")
      const fill = createFillResult({
        edits: [{ file: "src/dummy.ts", replacements: [{ find: "{{__SLOT_003__}}", replace: "y" }] }],
      })
      const result = await service.executeApply(fill, projectDir)

      expect(result.remainingPlaceholders).toHaveLength(1)
      expect(result.remainingPlaceholders[0].placeholder).toBe("{{__SLOT_001__}}")
    })

    it("finds multiple placeholders on same line", async () => {
      await writeFile(
        join(projectDir, "src", "multi.ts"),
        '"{{__SLOT_007__}}" + "{{__SLOT_008__}}"'
      )
      // Need a non-empty fill to trigger full flow
      await writeFile(join(projectDir, "src", "dummy.ts"), "{{__SLOT_003__}}")
      const fill = createFillResult({
        edits: [{ file: "src/dummy.ts", replacements: [{ find: "{{__SLOT_003__}}", replace: "y" }] }],
      })
      const result = await service.executeApply(fill, projectDir)

      expect(result.remainingPlaceholders).toHaveLength(2)
      expect(result.remainingPlaceholders.map((p) => p.placeholder)).toEqual(["{{__SLOT_007__}}", "{{__SLOT_008__}}"])
    })

    it("reports zero remaining after successful full apply", async () => {
      await writeFile(join(projectDir, "src", "app.ts"), 'const x = "{{__SLOT_009__}}"')

      const fill = createFillResult({
        edits: [
          {
            file: "src/app.ts",
            replacements: [{ find: "{{__SLOT_009__}}", replace: "done" }],
          },
        ],
      })

      const result = await service.executeApply(fill, projectDir)
      expect(result.remainingPlaceholders).toHaveLength(0)
    })

    it("skips node_modules and .git directories", async () => {
      await mkdir(join(projectDir, "src", "node_modules"), { recursive: true })
      await writeFile(join(projectDir, "src", "node_modules", "lib.ts"), "{{__SLOT_010__}}")
      // Need a non-empty fill to trigger full flow
      await writeFile(join(projectDir, "src", "dummy.ts"), "{{__SLOT_003__}}")
      const fill = createFillResult({
        edits: [{ file: "src/dummy.ts", replacements: [{ find: "{{__SLOT_003__}}", replace: "y" }] }],
      })
      const result = await service.executeApply(fill, projectDir)

      expect(result.remainingPlaceholders).toHaveLength(0)
    })
  })

  // ── Build Verification ──

  describe("buildVerification", () => {
    it("reports success when build command succeeds", async () => {
      const fill = createFillResult({
        edits: [{ file: "src/app.ts", replacements: [{ find: "{{__SLOT_003__}}", replace: "y" }] }],
      })
      await writeFile(join(projectDir, "src", "app.ts"), "{{__SLOT_003__}}")

      const result = await service.executeApply(fill, projectDir)
      expect(result.buildVerification.attempted).toBe(true)
      expect(result.buildVerification.success).toBe(true)
    })

    it("reports failure when build command fails", async () => {
      const failService = new ApplyService(
        { ...DEFAULT_CONFIG, buildCommand: "exit 1" },
        noopLogger
      )
      await writeFile(join(projectDir, "src", "app.ts"), "{{__SLOT_003__}}")
      const fill = createFillResult({
        edits: [{ file: "src/app.ts", replacements: [{ find: "{{__SLOT_003__}}", replace: "y" }] }],
      })

      const result = await failService.executeApply(fill, projectDir)
      expect(result.buildVerification.attempted).toBe(true)
      expect(result.buildVerification.success).toBe(false)
    })

    it("reports failure on build timeout", async () => {
      const slowService = new ApplyService(
        { ...DEFAULT_CONFIG, buildCommand: "sleep 60", buildTimeoutMs: 500 },
        noopLogger
      )
      await writeFile(join(projectDir, "src", "app.ts"), "{{__SLOT_003__}}")
      const fill = createFillResult({
        edits: [{ file: "src/app.ts", replacements: [{ find: "{{__SLOT_003__}}", replace: "y" }] }],
      })

      const result = await slowService.executeApply(fill, projectDir)
      expect(result.buildVerification.success).toBe(false)
    })

    it("skips build for empty fillResult", async () => {
      const result = await service.executeApply(createFillResult(), projectDir)
      expect(result.buildVerification.attempted).toBe(false)
    })
  })

  // ── Git Integration ──

  describe("git integration", () => {
    let gitService: ApplyService

    beforeEach(async () => {
      gitService = new ApplyService({ ...DEFAULT_CONFIG, gitEnabled: true }, noopLogger)
      await initGitRepo(projectDir)
    })

    it("commits applied changes on successful build", async () => {
      await writeFile(join(projectDir, "src", "app.ts"), "{{__SLOT_003__}}")
      execSync("git add -A && git commit -m 'add file'", { cwd: projectDir, stdio: "ignore" })

      const fill = createFillResult({
        edits: [{ file: "src/app.ts", replacements: [{ find: "{{__SLOT_003__}}", replace: "done" }] }],
      })

      const result = await gitService.executeApply(fill, projectDir)
      expect(result.rolledBack).toBe(false)

      const log = execSync("git log --oneline -3", { cwd: projectDir, encoding: "utf-8" })
      expect(log).toContain("test: apply")
    })

    it("rolls back on build failure", async () => {
      const failGitService = new ApplyService(
        { ...DEFAULT_CONFIG, gitEnabled: true, buildCommand: "exit 1" },
        noopLogger
      )
      await writeFile(join(projectDir, "src", "app.ts"), "{{__SLOT_012__}}")
      execSync("git add -A && git commit -m 'add file'", { cwd: projectDir, stdio: "ignore" })

      const fill = createFillResult({
        edits: [{ file: "src/app.ts", replacements: [{ find: "{{__SLOT_012__}}", replace: "broken" }] }],
      })

      const result = await failGitService.executeApply(fill, projectDir)
      expect(result.rolledBack).toBe(true)
      expect(result.buildVerification.success).toBe(false)

      const content = await readFile(join(projectDir, "src", "app.ts"), "utf-8")
      expect(content).toBe("{{__SLOT_012__}}")
    })

    it("proceeds without git when not a git repo", async () => {
      const nonGitDir = await createTempProject()
      try {
        await writeFile(join(nonGitDir, "src", "app.ts"), "{{__SLOT_003__}}")
        const fill = createFillResult({
          edits: [{ file: "src/app.ts", replacements: [{ find: "{{__SLOT_003__}}", replace: "y" }] }],
        })

        const nonGitService = new ApplyService({ ...DEFAULT_CONFIG, gitEnabled: true }, noopLogger)
        const result = await nonGitService.executeApply(fill, nonGitDir)
        expect(result.rolledBack).toBe(false)
        expect(result.buildVerification.success).toBe(true)
      } finally {
        await rm(nonGitDir, { recursive: true, force: true })
      }
    })
  })

  // ── Combined Flow ──

  describe("full apply flow", () => {
    it("applies edits + writes content files + scans placeholders", async () => {
      await writeFile(
        join(projectDir, "src", "page.tsx"),
        'const title = "{{__SLOT_001__}}"\nconst x = "{{__SLOT_011__}}"'
      )

      const fill = createFillResult({
        edits: [
          {
            file: "src/page.tsx",
            replacements: [{ find: "{{__SLOT_001__}}", replace: "Adult Game" }],
          },
        ],
        contentFiles: [
          { file: "content/items.json", content: '[{"name": "item1"}]' },
        ],
      })

      const result = await service.executeApply(fill, projectDir)

      expect(result.totalReplacementsApplied).toBe(1)
      expect(result.totalContentFilesWritten).toBe(1)
      expect(result.remainingPlaceholders).toHaveLength(1)
      expect(result.remainingPlaceholders[0].placeholder).toBe("{{__SLOT_011__}}")
      expect(result.buildVerification.success).toBe(true)
      expect(result.rolledBack).toBe(false)
      expect(result.latencyMs).toBeGreaterThan(0)
    })
  })
})
