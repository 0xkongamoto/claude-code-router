import { describe, it, expect, vi, beforeEach } from "vitest"
import { LRUCache } from "lru-cache"
import { sanitizeContent } from "./sanitizer"
import { SanitizerModelConfig, SanitizerResult } from "../switcher/types"

const noopLogger = {
  child: () => noopLogger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const CONFIG: SanitizerModelConfig = {
  model: "test-model",
  apiKey: "test-key",
  apiUrl: "http://localhost:9999",
  maxContentLength: 4000,
  timeoutMs: 5000,
  cacheEnabled: false,
  cacheTtlMs: 0,
  cacheMaxSize: 0,
}

const CONFIG_WITH_CACHE: SanitizerModelConfig = {
  ...CONFIG,
  cacheEnabled: true,
  cacheTtlMs: 300000,
  cacheMaxSize: 100,
}

function sfwResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({
      content: [{ text: '{"classification":"sfw","confidence":0.9,"cleanPrompt":null,"nsfwSpec":null}' }],
    }),
  }
}

function mixedResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({
      content: [{ text: '{"classification":"mixed","confidence":0.9,"cleanPrompt":"clean version","nsfwSpec":null}' }],
    }),
  }
}

describe("sanitizeContent", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("returns sfw fallback on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }))

    const result = await sanitizeContent("test content", "test content", CONFIG, null, noopLogger)
    expect(result.classification).toBe("sfw")
    expect(result.confidence).toBe(0)
    expect(result.nsfwSpec).toBeNull()
  })

  it("parses valid SFW response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: '{"classification":"sfw","confidence":0.95,"cleanPrompt":null,"nsfwSpec":null}' }],
      }),
    }))

    const result = await sanitizeContent("hello world", "hello world", CONFIG, null, noopLogger)
    expect(result.classification).toBe("sfw")
    expect(result.confidence).toBe(0.95)
    expect(result.cleanPrompt).toBeNull()
    expect(result.nsfwSpec).toBeNull()
  })

  it("parses valid NSFW response with nsfwSpec validation", async () => {
    const response = {
      classification: "nsfw",
      confidence: 0.9,
      cleanPrompt: "Build a card game with {{__SLOT_001__}} as title",
      nsfwSpec: {
        contentChanges: [{ file: "content/data.json", path: "title", description: "Adult title" }],
        codeChanges: [{ type: "string", placeholder: "{{__SLOT_001__}}", description: "Strip Poker", location: "Header" }],
        context: "Adult game",
      },
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: JSON.stringify(response) }] }),
    }))

    const result = await sanitizeContent("build strip poker", "build strip poker", CONFIG, null, noopLogger)
    expect(result.classification).toBe("nsfw")
    expect(result.cleanPrompt).toContain("{{__SLOT_001__}}")
    expect(result.nsfwSpec).not.toBeNull()
    expect(result.nsfwSpec!.codeChanges).toHaveLength(1)
    expect(result.nsfwSpec!.contentChanges).toHaveLength(1)
    expect(result.nsfwSpec!.context).toBe("Adult game")
  })

  it("validates nsfwSpec — filters invalid entries", async () => {
    const response = {
      classification: "nsfw",
      confidence: 0.8,
      cleanPrompt: "Build a game",
      nsfwSpec: {
        contentChanges: [
          { file: "a.json", path: "x", description: "valid" },
          { missing: "fields" },
        ],
        codeChanges: [
          { placeholder: "{{__SLOT_002__}}", description: "valid" },
          { noPlaceholder: true },
        ],
        context: "test",
      },
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: JSON.stringify(response) }] }),
    }))

    const result = await sanitizeContent("test", "test", CONFIG, null, noopLogger)
    expect(result.nsfwSpec!.contentChanges).toHaveLength(1)
    expect(result.nsfwSpec!.codeChanges).toHaveLength(1)
  })

  it("extracts JSON from surrounding text", async () => {
    const json = '{"classification":"mixed","confidence":0.85,"cleanPrompt":"clean","nsfwSpec":null}'
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: `Here is my analysis:\n${json}\nThat's my answer.` }],
      }),
    }))

    const result = await sanitizeContent("test", "test", CONFIG, null, noopLogger)
    expect(result.classification).toBe("mixed")
    expect(result.confidence).toBe(0.85)
  })

  it("falls back to keyword detection when JSON fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: 'I think this is "nsfw" content because...' }],
      }),
    }))

    const result = await sanitizeContent("test", "test", CONFIG, null, noopLogger)
    expect(result.classification).toBe("nsfw")
    expect(result.confidence).toBe(0.5)
  })

  it("returns sfw on timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("timeout"), { name: "AbortError" })
    ))

    const result = await sanitizeContent("test", "test", CONFIG, null, noopLogger)
    expect(result.classification).toBe("sfw")
    expect(result.confidence).toBe(0)
  })

  it("clamps confidence to [0, 1]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ text: '{"classification":"sfw","confidence":5.0,"cleanPrompt":null,"nsfwSpec":null}' }],
      }),
    }))

    const result = await sanitizeContent("test", "test", CONFIG, null, noopLogger)
    expect(result.confidence).toBe(1)
  })

  it("truncates classificationContent exceeding maxContentLength", async () => {
    let capturedBody = ""
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = opts.body
      return {
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '{"classification":"sfw","confidence":0.9,"cleanPrompt":null,"nsfwSpec":null}' }],
        }),
      }
    }))

    const longContent = "a".repeat(10000)
    await sanitizeContent("short key", longContent, { ...CONFIG, maxContentLength: 100 }, null, noopLogger)

    const parsed = JSON.parse(capturedBody)
    const messageContent = parsed.messages[0].content
    expect(messageContent.length).toBeLessThan(longContent.length)
  })

  it("uses cacheKeyContent for cache key and classificationContent for API", async () => {
    let capturedBody = ""
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = opts.body
      return sfwResponse()
    }))

    await sanitizeContent(
      "user text only",
      "user text only\nassistant text\ntool results",
      CONFIG,
      null,
      noopLogger
    )

    const parsed = JSON.parse(capturedBody)
    expect(parsed.messages[0].content).toContain("assistant text")
    expect(parsed.messages[0].content).toContain("tool results")
  })

  it("cache hit when user text same but assistant text differs", async () => {
    const cache = new LRUCache<string, SanitizerResult>({ max: 100, ttl: 300000 })
    const fetchMock = vi.fn().mockResolvedValue(mixedResponse())
    vi.stubGlobal("fetch", fetchMock)

    // First call: cache miss
    await sanitizeContent("user query", "user query\nassistant response 1", CONFIG_WITH_CACHE, cache, noopLogger)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Second call: same user text, different assistant text → cache hit
    const result = await sanitizeContent("user query", "user query\nassistant response 2\ntool result", CONFIG_WITH_CACHE, cache, noopLogger)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.cached).toBe(true)
  })

  it("sends temperature: 0 in API request", async () => {
    let capturedBody: any = {}
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return sfwResponse()
    }))

    await sanitizeContent("test", "test", CONFIG, null, noopLogger)
    expect(capturedBody.temperature).toBe(0)
  })
})
