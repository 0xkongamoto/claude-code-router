import { describe, it, expect } from "vitest"
import { extractUserOnlyText, extractRecentUserTexts, truncateForClassifier } from "./classifier"

describe("extractUserOnlyText", () => {
  it("extracts only user role messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "build something" },
    ]
    const result = extractUserOnlyText(messages)
    expect(result).toBe("hello\nbuild something")
    expect(result).not.toContain("hi there")
  })

  it("handles content block arrays", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "user message" },
          { type: "image", source: { data: "..." } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant response" }],
      },
    ]
    const result = extractUserOnlyText(messages)
    expect(result).toBe("user message")
  })

  it("strips system reminders from user text", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>skip this</system-reminder>" },
          { type: "text", text: "actual user message" },
        ],
      },
    ]
    const result = extractUserOnlyText(messages)
    expect(result).toBe("actual user message")
  })

  it("returns null for empty messages", () => {
    expect(extractUserOnlyText([])).toBeNull()
  })

  it("returns null for assistant-only messages", () => {
    const messages = [{ role: "assistant", content: "response" }]
    expect(extractUserOnlyText(messages)).toBeNull()
  })

  it("returns null for non-array input", () => {
    expect(extractUserOnlyText(null as any)).toBeNull()
    expect(extractUserOnlyText(undefined as any)).toBeNull()
  })

  it("skips tool_result messages", () => {
    const messages = [
      { role: "user", content: "do something" },
      { role: "assistant", content: "calling tool..." },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "123", content: "file contents here" },
        { type: "text", text: "<system-reminder>reminder</system-reminder>" },
      ]},
    ]
    const result = extractUserOnlyText(messages)
    expect(result).toBe("do something")
  })
})

describe("extractRecentUserTexts", () => {
  it("returns only [CURRENT MESSAGE] section when there is a single user turn", () => {
    const messages = [{ role: "user", content: "hi" }]
    const result = extractRecentUserTexts(messages)
    expect(result).toBe("[CURRENT MESSAGE]\nhi")
    expect(result).not.toContain("[HISTORY]")
  })

  it("separates latest user message from history using markers", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "analyze how BTC works" },
      { role: "assistant", content: "sure..." },
      { role: "user", content: "hi" },
    ]
    const result = extractRecentUserTexts(messages)
    expect(result).toContain("[HISTORY]")
    expect(result).toContain("[CURRENT MESSAGE]")
    // History keyword should live in HISTORY section
    const historyStart = result!.indexOf("[HISTORY]")
    const currentStart = result!.indexOf("[CURRENT MESSAGE]")
    expect(historyStart).toBeLessThan(currentStart)
    expect(result!.slice(historyStart, currentStart)).toContain("analyze how BTC works")
    // Latest message sits under [CURRENT MESSAGE]
    expect(result!.slice(currentStart)).toBe("[CURRENT MESSAGE]\nhi")
  })

  it("orders history chronologically (oldest first)", () => {
    const messages = [
      { role: "user", content: "first message" },
      { role: "user", content: "second message" },
      { role: "user", content: "third message" },
      { role: "user", content: "latest message" },
    ]
    const result = extractRecentUserTexts(messages)
    expect(result).toContain("[HISTORY]\nfirst message\n---\nsecond message\n---\nthird message")
    expect(result).toContain("[CURRENT MESSAGE]\nlatest message")
  })

  it("returns null when messages contain no user text", () => {
    expect(extractRecentUserTexts([{ role: "assistant", content: "hi" }])).toBeNull()
    expect(extractRecentUserTexts([])).toBeNull()
  })
})

describe("truncateForClassifier", () => {
  it("returns content unchanged when under budget", () => {
    const content = "[CURRENT MESSAGE]\nhi"
    expect(truncateForClassifier(content, 100)).toBe(content)
  })

  it("preserves the [CURRENT MESSAGE] section when history is long", () => {
    const longHistory = "a".repeat(500)
    const content = `[HISTORY]\n${longHistory}\n\n[CURRENT MESSAGE]\nhi`
    const result = truncateForClassifier(content, 100)
    expect(result).toContain("[CURRENT MESSAGE]\nhi")
    expect(result.length).toBeLessThanOrEqual(100)
    // Should drop the oldest history characters first
    expect(result).not.toContain("aaaaaaaaaa".repeat(40))
  })

  it("uses a truncated-history prefix so the classifier knows history was cut", () => {
    const longHistory = "x".repeat(500)
    const content = `[HISTORY]\n${longHistory}\n\n[CURRENT MESSAGE]\nplease continue`
    const result = truncateForClassifier(content, 200)
    expect(result).toContain("(truncated)")
    expect(result).toContain("[CURRENT MESSAGE]\nplease continue")
  })

  it("falls back to tail slice when no marker is present", () => {
    const content = "x".repeat(500) + "END"
    const result = truncateForClassifier(content, 100)
    expect(result.length).toBe(100)
    expect(result.endsWith("END")).toBe(true)
  })

  it("keeps only the current marker tail when current section exceeds budget", () => {
    const longCurrent = "y".repeat(500)
    const content = `[CURRENT MESSAGE]\n${longCurrent}`
    const result = truncateForClassifier(content, 100)
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result.startsWith("[CURRENT MESSAGE]\n")).toBe(true)
    expect(result.endsWith("y")).toBe(true)
  })
})
