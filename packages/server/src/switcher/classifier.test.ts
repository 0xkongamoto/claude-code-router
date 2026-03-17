import { describe, it, expect } from "vitest"
import { extractUserOnlyText } from "./classifier"

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
