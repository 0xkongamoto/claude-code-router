import { describe, it, expect } from "vitest"
import { parsePipelineConfig } from "./types"

describe("parsePipelineConfig", () => {
  describe("apply config defaults", () => {
    it("uses defaults when apply section is absent", () => {
      const config = parsePipelineConfig({ enabled: true })

      expect(config.apply).toEqual({
        buildCommand: "npm run build",
        buildTimeoutMs: 120000,
        gitEnabled: true,
        gitCommitMessage: "nsfw: fill placeholders with content",
        maxFileSizeBytes: 5242880,
      })
    })

    it("uses defaults when apply is empty object", () => {
      const config = parsePipelineConfig({ enabled: true, apply: {} })

      expect(config.apply.buildCommand).toBe("npm run build")
      expect(config.apply.buildTimeoutMs).toBe(120000)
      expect(config.apply.gitEnabled).toBe(true)
      expect(config.apply.gitCommitMessage).toBe("nsfw: fill placeholders with content")
      expect(config.apply.maxFileSizeBytes).toBe(5242880)
    })
  })

  describe("apply config overrides", () => {
    it("accepts valid overrides", () => {
      const config = parsePipelineConfig({
        enabled: true,
        apply: {
          buildCommand: "pnpm build",
          buildTimeoutMs: 60000,
          gitEnabled: false,
          gitCommitMessage: "custom message",
          maxFileSizeBytes: 1048576,
        },
      })

      expect(config.apply.buildCommand).toBe("pnpm build")
      expect(config.apply.buildTimeoutMs).toBe(60000)
      expect(config.apply.gitEnabled).toBe(false)
      expect(config.apply.gitCommitMessage).toBe("custom message")
      expect(config.apply.maxFileSizeBytes).toBe(1048576)
    })

    it("rejects buildTimeoutMs below minimum (1000)", () => {
      const config = parsePipelineConfig({
        enabled: true,
        apply: { buildTimeoutMs: 500 },
      })
      expect(config.apply.buildTimeoutMs).toBe(120000)
    })

    it("rejects maxFileSizeBytes below minimum (1024)", () => {
      const config = parsePipelineConfig({
        enabled: true,
        apply: { maxFileSizeBytes: 100 },
      })
      expect(config.apply.maxFileSizeBytes).toBe(5242880)
    })

    it("rejects non-string buildCommand", () => {
      const config = parsePipelineConfig({
        enabled: true,
        apply: { buildCommand: 123 },
      })
      expect(config.apply.buildCommand).toBe("npm run build")
    })

    it("rejects non-boolean gitEnabled", () => {
      const config = parsePipelineConfig({
        enabled: true,
        apply: { gitEnabled: "yes" },
      })
      expect(config.apply.gitEnabled).toBe(true)
    })

    it("rejects non-string gitCommitMessage", () => {
      const config = parsePipelineConfig({
        enabled: true,
        apply: { gitCommitMessage: 42 },
      })
      expect(config.apply.gitCommitMessage).toBe("nsfw: fill placeholders with content")
    })
  })

  describe("backward compatibility", () => {
    it("does not break existing config fields", () => {
      const config = parsePipelineConfig({
        enabled: true,
        sanitizer: { model: "custom-model" },
        sfwAgent: { reportMarkerStart: "<<<START>>>" },
        nsfwAgent: { model: "MiniMax-M1" },
      })

      expect(config.enabled).toBe(true)
      expect(config.sanitizer.model).toBe("custom-model")
      expect(config.sfwAgent.reportMarkerStart).toBe("<<<START>>>")
      expect(config.nsfwAgent.model).toBe("MiniMax-M1")
      expect(config.apply).toBeDefined()
    })
  })
})
