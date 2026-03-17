import { describe, it, expect, vi } from "vitest"
import { PipelineStore } from "./store"
import { ApplyResult, NsfwSpec } from "../switcher/types"

const noopLogger = {
  child: () => noopLogger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const SPEC: NsfwSpec = {
  contentChanges: [],
  codeChanges: [],
  context: "test context",
}

function makeApplyResult(overrides: Partial<ApplyResult> = {}): ApplyResult {
  return {
    editsApplied: [],
    contentFilesWritten: [],
    totalReplacementsApplied: 0,
    totalContentFilesWritten: 0,
    remainingPlaceholders: [],
    buildVerification: { attempted: true, success: true },
    rolledBack: false,
    latencyMs: 100,
    ...overrides,
  }
}

describe("PipelineStore", () => {
  describe("initSession", () => {
    it("initializes with applyResult: null", () => {
      const store = new PipelineStore(10, 60000, noopLogger)
      const state = store.initSession("s1", SPEC, "nsfw")

      expect(state.applyResult).toBeNull()
      expect(state.fillResult).toBeNull()
      expect(state.projectPath).toBeNull()
      expect(state.status).toBe("sfw_in_progress")
    })

    it("stores projectPath when provided", () => {
      const store = new PipelineStore(10, 60000, noopLogger)
      const state = store.initSession("s1", SPEC, "nsfw", "/home/user/project")

      expect(state.projectPath).toBe("/home/user/project")
    })
  })

  describe("initSessionIfNeeded", () => {
    it("creates session when none exists", () => {
      const store = new PipelineStore(10, 60000, noopLogger)
      const state = store.initSessionIfNeeded("s1", SPEC, "nsfw")
      expect(state.status).toBe("sfw_in_progress")
      expect(state.sessionId).toBe("s1")
    })

    it("returns existing session without overwriting", () => {
      const store = new PipelineStore(10, 60000, noopLogger)
      store.initSession("s1", SPEC, "nsfw")
      store.setReport("s1", {
        summary: "test report",
        files: [],
        placeholders: [],
        contentFiles: [],
        buildStatus: "success",
        techStack: [],
        componentTree: "",
      })

      const state = store.initSessionIfNeeded("s1", SPEC, "nsfw")
      expect(state.implementationReport).not.toBeNull()
      expect(state.implementationReport!.summary).toBe("test report")
      expect(state.status).toBe("sfw_complete")
    })
  })

  describe("setApplyResult", () => {
    it("stores apply result and sets status to apply_complete", () => {
      const store = new PipelineStore(10, 60000, noopLogger)
      store.initSession("s1", SPEC, "nsfw")

      const applyResult = makeApplyResult({ totalReplacementsApplied: 5 })
      const updated = store.setApplyResult("s1", applyResult)

      expect(updated).not.toBeNull()
      expect(updated!.status).toBe("apply_complete")
      expect(updated!.applyResult).toEqual(applyResult)
      expect(updated!.applyResult!.totalReplacementsApplied).toBe(5)
    })

    it("returns null for unknown session", () => {
      const store = new PipelineStore(10, 60000, noopLogger)
      const result = store.setApplyResult("unknown", makeApplyResult())
      expect(result).toBeNull()
    })

    it("preserves existing fields when setting apply result", () => {
      const store = new PipelineStore(10, 60000, noopLogger)
      store.initSession("s1", SPEC, "nsfw")
      store.setReport("s1", {
        summary: "test",
        files: [],
        placeholders: [],
        contentFiles: [],
        buildStatus: "success",
        techStack: ["react"],
        componentTree: "App",
      })
      store.setFillResult("s1", {
        edits: [],
        contentFiles: [],
        modelUsed: "test",
        latencyMs: 50,
      })

      const updated = store.setApplyResult("s1", makeApplyResult())

      expect(updated!.nsfwSpec).toEqual(SPEC)
      expect(updated!.implementationReport).not.toBeNull()
      expect(updated!.fillResult).not.toBeNull()
      expect(updated!.applyResult).not.toBeNull()
      expect(updated!.originalClassification).toBe("nsfw")
    })
  })

  describe("status transitions", () => {
    it("supports full pipeline status flow", () => {
      const store = new PipelineStore(10, 60000, noopLogger)
      store.initSession("s1", SPEC, "nsfw")
      expect(store.getSession("s1")!.status).toBe("sfw_in_progress")

      store.setStatus("s1", "sfw_complete")
      expect(store.getSession("s1")!.status).toBe("sfw_complete")

      store.setStatus("s1", "nsfw_pending")
      store.setStatus("s1", "nsfw_in_progress")
      store.setStatus("s1", "nsfw_complete")
      expect(store.getSession("s1")!.status).toBe("nsfw_complete")

      store.setStatus("s1", "apply_pending")
      expect(store.getSession("s1")!.status).toBe("apply_pending")

      store.setStatus("s1", "apply_in_progress")
      expect(store.getSession("s1")!.status).toBe("apply_in_progress")

      store.setApplyResult("s1", makeApplyResult())
      expect(store.getSession("s1")!.status).toBe("apply_complete")
    })
  })
})
