import { LRUCache } from "lru-cache"
import {
  PipelineState,
  PipelineStatus,
  NsfwSpec,
  ImplementationReport,
  ContentClassification,
  FillResult,
  ApplyResult,
} from "../switcher/types"

export class PipelineStore {
  private readonly cache: LRUCache<string, PipelineState>
  private readonly logger: any

  constructor(maxSize: number, ttlMs: number, logger: any) {
    this.logger = logger.child({ module: "pipeline-store" })
    this.cache = new LRUCache<string, PipelineState>({
      max: maxSize,
      ttl: ttlMs,
    })
  }

  initSession(
    sessionId: string,
    nsfwSpec: NsfwSpec,
    classification: ContentClassification
  ): PipelineState {
    const now = Date.now()
    const state: PipelineState = {
      sessionId,
      status: "sfw_in_progress",
      nsfwSpec,
      implementationReport: null,
      fillResult: null,
      applyResult: null,
      originalClassification: classification,
      createdAt: now,
      updatedAt: now,
    }
    this.cache.set(sessionId, state)
    this.logger.info({ sessionId, classification }, "Pipeline: session initialized")
    return state
  }

  getSession(sessionId: string): PipelineState | null {
    return this.cache.get(sessionId) ?? null
  }

  setReport(sessionId: string, report: ImplementationReport): PipelineState | null {
    const existing = this.cache.get(sessionId)
    if (!existing) {
      this.logger.warn({ sessionId }, "Pipeline: setReport called for unknown session")
      return null
    }
    const updated: PipelineState = {
      ...existing,
      implementationReport: report,
      status: "sfw_complete",
      updatedAt: Date.now(),
    }
    this.cache.set(sessionId, updated)
    this.logger.info(
      { sessionId, placeholderCount: report.placeholders.length },
      "Pipeline: implementation report captured"
    )
    return updated
  }

  setFillResult(sessionId: string, fillResult: FillResult): PipelineState | null {
    const existing = this.cache.get(sessionId)
    if (!existing) {
      this.logger.warn({ sessionId }, "Pipeline: setFillResult called for unknown session")
      return null
    }
    const updated: PipelineState = {
      ...existing,
      fillResult,
      status: "nsfw_complete",
      updatedAt: Date.now(),
    }
    this.cache.set(sessionId, updated)
    this.logger.info(
      {
        sessionId,
        editCount: fillResult.edits.length,
        contentFileCount: fillResult.contentFiles.length,
      },
      "Pipeline: fill result stored"
    )
    return updated
  }

  setApplyResult(sessionId: string, applyResult: ApplyResult): PipelineState | null {
    const existing = this.cache.get(sessionId)
    if (!existing) {
      this.logger.warn({ sessionId }, "Pipeline: setApplyResult called for unknown session")
      return null
    }
    const updated: PipelineState = {
      ...existing,
      applyResult,
      status: "apply_complete",
      updatedAt: Date.now(),
    }
    this.cache.set(sessionId, updated)
    this.logger.info(
      {
        sessionId,
        totalReplacementsApplied: applyResult.totalReplacementsApplied,
        totalContentFilesWritten: applyResult.totalContentFilesWritten,
        rolledBack: applyResult.rolledBack,
      },
      "Pipeline: apply result stored"
    )
    return updated
  }

  setStatus(sessionId: string, status: PipelineStatus, error?: string): PipelineState | null {
    const existing = this.cache.get(sessionId)
    if (!existing) {
      this.logger.warn({ sessionId }, "Pipeline: setStatus called for unknown session")
      return null
    }
    const updated: PipelineState = {
      ...existing,
      status,
      updatedAt: Date.now(),
      ...(error !== undefined ? { error } : {}),
    }
    this.cache.set(sessionId, updated)
    this.logger.info({ sessionId, status, error }, "Pipeline: status updated")
    return updated
  }

  listSessions(): PipelineState[] {
    const sessions: PipelineState[] = []
    for (const [, value] of this.cache.entries()) {
      sessions.push(value)
    }
    return sessions
  }
}
