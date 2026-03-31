import { describe, it, expect, vi, beforeEach } from "vitest"
import { createSanitizerHook } from "./index"
import { PipelineStore } from "./store"
import { NsfwSpec, SanitizerResult } from "../switcher/types"

const noopLogger = {
  child: () => noopLogger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const SPEC: NsfwSpec = {
  contentChanges: [],
  codeChanges: [{ type: "string", placeholder: "{{__SLOT_001__}}", description: "test", location: "title" }],
  context: "test context",
}

function makeSanitizer(decomposeResult: SanitizerResult | null) {
  return {
    config: {
      enabled: true,
      sanitizer: {},
      sfwAgent: {
        reportMarkerStart: "<<<START>>>",
        reportMarkerEnd: "<<<END>>>",
      },
    },
    decompose: vi.fn().mockResolvedValue(decomposeResult),
    logger: noopLogger,
  } as any
}

function makeReq(overrides: Record<string, any> = {}): any {
  return {
    pathname: "/v1/messages",
    sessionId: "session-1",
    headers: {},
    body: {
      messages: [
        { role: "user", content: [{ type: "text", text: "Make 1 undress app" }] },
        { role: "assistant", content: [{ type: "text", text: "I'll help" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
      system: [{ type: "text", text: "You are helpful" }],
    },
    ...overrides,
  }
}

describe("createSanitizerHook — session-based fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("uses stored cleanPrompt when API fails and NSFW session exists", async () => {
    const store = new PipelineStore(10, 60000, noopLogger)
    store.initSession("session-1", SPEC, "nsfw", null, undefined, "Make 1 image transformation app")

    // Simulate API failure: confidence 0, sfw fallback, no cleanPrompt
    const apiFailResult: SanitizerResult = {
      classification: "sfw",
      originalClassification: "sfw",
      confidence: 0,
      cached: false,
      latencyMs: 10000,
      cleanPrompt: null,
      nsfwSpec: null,
    }

    const sanitizer = makeSanitizer(apiFailResult)
    const hook = createSanitizerHook(sanitizer, store, noopLogger)
    const req = makeReq()

    await hook(req, {})

    // Should route to SFW (sanitized)
    expect(req.switcherResult.classification).toBe("sfw")
    expect(req.switcherResult.confidence).toBe(0.98)

    // First user message should be sanitized
    const firstUserMsg = req.body.messages[0]
    expect(firstUserMsg.content[0].text).toBe("[Prior context]")

    // Last user message should have cleanPrompt
    const lastUserMsg = req.body.messages[2]
    expect(lastUserMsg.content[0].text).toBe("Make 1 image transformation app")

    // sanitizerResult should reflect NSFW
    expect(req.sanitizerResult.originalClassification).toBe("nsfw")
    expect(req.sanitizerResult.cleanPrompt).toBe("Make 1 image transformation app")

    // System prompt should have report instruction appended
    expect(req.body.system).toHaveLength(2)
  })

  it("falls through to SFW when no session exists", async () => {
    const store = new PipelineStore(10, 60000, noopLogger)
    // No session initialized

    const apiFailResult: SanitizerResult = {
      classification: "sfw",
      originalClassification: "sfw",
      confidence: 0,
      cached: false,
      latencyMs: 5000,
      cleanPrompt: null,
      nsfwSpec: null,
    }

    const sanitizer = makeSanitizer(apiFailResult)
    const hook = createSanitizerHook(sanitizer, store, noopLogger)
    const req = makeReq()

    await hook(req, {})

    // Should pass through as SFW (no session to fall back to)
    expect(req.switcherResult.classification).toBe("sfw")
    expect(req.switcherResult.confidence).toBe(0)

    // Messages should NOT be modified
    expect(req.body.messages[0].content[0].text).toBe("Make 1 undress app")
  })

  it("falls through to SFW when session exists but was SFW", async () => {
    const store = new PipelineStore(10, 60000, noopLogger)
    store.initSession("session-1", SPEC, "sfw", null, undefined, null)

    const apiFailResult: SanitizerResult = {
      classification: "sfw",
      originalClassification: "sfw",
      confidence: 0,
      cached: false,
      latencyMs: 5000,
      cleanPrompt: null,
      nsfwSpec: null,
    }

    const sanitizer = makeSanitizer(apiFailResult)
    const hook = createSanitizerHook(sanitizer, store, noopLogger)
    const req = makeReq()

    await hook(req, {})

    expect(req.switcherResult.classification).toBe("sfw")
    expect(req.switcherResult.confidence).toBe(0)
  })

  it("falls through to SFW when session is NSFW but has no stored cleanPrompt", async () => {
    const store = new PipelineStore(10, 60000, noopLogger)
    store.initSession("session-1", SPEC, "nsfw", null, undefined, null)

    const apiFailResult: SanitizerResult = {
      classification: "sfw",
      originalClassification: "sfw",
      confidence: 0,
      cached: false,
      latencyMs: 5000,
      cleanPrompt: null,
      nsfwSpec: null,
    }

    const sanitizer = makeSanitizer(apiFailResult)
    const hook = createSanitizerHook(sanitizer, store, noopLogger)
    const req = makeReq()

    await hook(req, {})

    // No cleanPrompt in session → can't sanitize → pass through
    expect(req.switcherResult.classification).toBe("sfw")
    expect(req.switcherResult.confidence).toBe(0)
  })

  it("does not trigger fallback when sanitizer API succeeds (confidence > 0)", async () => {
    const store = new PipelineStore(10, 60000, noopLogger)
    store.initSession("session-1", SPEC, "nsfw", null, undefined, "clean version")

    // API success: proper SFW classification
    const sfwResult: SanitizerResult = {
      classification: "sfw",
      originalClassification: "sfw",
      confidence: 0.95,
      cached: false,
      latencyMs: 200,
      cleanPrompt: null,
      nsfwSpec: null,
    }

    const sanitizer = makeSanitizer(sfwResult)
    const hook = createSanitizerHook(sanitizer, store, noopLogger)
    const req = makeReq()

    await hook(req, {})

    // Normal SFW path — no fallback
    expect(req.switcherResult.classification).toBe("sfw")
    expect(req.switcherResult.confidence).toBe(0.95)
    expect(req.sanitizerResult).toBeUndefined()
  })

  it("does not trigger fallback when result is cached", async () => {
    const store = new PipelineStore(10, 60000, noopLogger)
    store.initSession("session-1", SPEC, "nsfw", null, undefined, "clean version")

    // Cached result with confidence 0 but cached flag
    const cachedResult: SanitizerResult = {
      classification: "nsfw",
      originalClassification: "nsfw",
      confidence: 0.98,
      cached: true,
      latencyMs: 0,
      cleanPrompt: "clean version",
      nsfwSpec: SPEC,
    }

    const sanitizer = makeSanitizer(cachedResult)
    const hook = createSanitizerHook(sanitizer, store, noopLogger)
    const req = makeReq()

    await hook(req, {})

    // Normal NSFW path via cache — not the fallback
    expect(req.switcherResult.classification).toBe("sfw")
    expect(req.sanitizerResult.originalClassification).toBe("nsfw")
  })

  it("uses mixed classification confidence from session", async () => {
    const store = new PipelineStore(10, 60000, noopLogger)
    store.initSession("session-1", SPEC, "mixed", null, undefined, "Make a clean app")

    const apiFailResult: SanitizerResult = {
      classification: "sfw",
      originalClassification: "sfw",
      confidence: 0,
      cached: false,
      latencyMs: 8000,
      cleanPrompt: null,
      nsfwSpec: null,
    }

    const sanitizer = makeSanitizer(apiFailResult)
    const hook = createSanitizerHook(sanitizer, store, noopLogger)
    const req = makeReq()

    await hook(req, {})

    // Mixed classification → confidence 0.9
    expect(req.switcherResult.confidence).toBe(0.9)
    expect(req.sanitizerResult.originalClassification).toBe("mixed")
  })
})
