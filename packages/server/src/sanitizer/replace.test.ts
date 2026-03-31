// import { describe, it, expect } from "vitest"
// import { sanitizeAllUserMessages, replaceLastUserMessageContent } from "./replace"

// describe("replaceLastUserMessageContent", () => {
//   it("replaces text in last user message string content", () => {
//     const messages = [
//       { role: "user", content: "original text" },
//       { role: "assistant", content: "response" },
//     ]
//     const result = replaceLastUserMessageContent(messages, "clean prompt")
//     expect(result[0].content).toBe("clean prompt")
//   })

//   it("replaces last non-system-reminder text block in content array", () => {
//     const messages = [
//       {
//         role: "user",
//         content: [
//           { type: "text", text: "<system-reminder>skip</system-reminder>" },
//           { type: "text", text: "original nsfw text" },
//         ],
//       },
//     ]
//     const result = replaceLastUserMessageContent(messages, "clean prompt")
//     const blocks = result[0].content as any[]
//     expect(blocks[0].text).toContain("<system-reminder>")
//     expect(blocks[1].text).toBe("clean prompt")
//   })

//   it("appends text block when last user message has only tool_result blocks", () => {
//     const messages = [
//       { role: "user", content: "original prompt" },
//       { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
//       {
//         role: "user",
//         content: [
//           { type: "tool_result", tool_use_id: "t1", content: "file contents" },
//         ],
//       },
//     ]
//     const result = replaceLastUserMessageContent(messages, "clean prompt")
//     const lastUserContent = result[2].content as any[]
//     expect(lastUserContent).toHaveLength(2)
//     expect(lastUserContent[0].type).toBe("tool_result")
//     expect(lastUserContent[1]).toEqual({ type: "text", text: "clean prompt" })
//   })

//   it("returns unchanged if no user messages", () => {
//     const messages = [{ role: "assistant", content: "response" }]
//     const result = replaceLastUserMessageContent(messages, "clean")
//     expect(result).toEqual(messages)
//   })
// })

// describe("sanitizeAllUserMessages", () => {
//   it("single user message: replaces with cleanPrompt, no [Prior context]", () => {
//     const messages = [
//       {
//         role: "user",
//         content: [
//           { type: "text", text: "<system-reminder>sys</system-reminder>" },
//           { type: "text", text: "nsfw prompt" },
//         ],
//       },
//     ]
//     const result = sanitizeAllUserMessages(messages, "clean prompt")
//     const blocks = result[0].content as any[]
//     expect(blocks[1].text).toBe("clean prompt")
//     // system-reminder preserved
//     expect(blocks[0].text).toContain("<system-reminder>")
//   })

//   it("multi-turn: sanitizes first user msg, injects cleanPrompt in last", () => {
//     const messages = [
//       {
//         role: "user",
//         content: [
//           { type: "text", text: "<system-reminder>sys</system-reminder>" },
//           { type: "text", text: "nsfw prompt" },
//         ],
//       },
//       { role: "assistant", content: "response" },
//       { role: "user", content: "follow up" },
//     ]
//     const result = sanitizeAllUserMessages(messages, "clean prompt")

//     // First user message: text sanitized to [Prior context]
//     const firstBlocks = result[0].content as any[]
//     expect(firstBlocks[0].text).toContain("<system-reminder>")
//     expect(firstBlocks[1].text).toBe("[Prior context]")

//     // Last user message: replaced with cleanPrompt
//     expect(result[2].content).toBe("clean prompt")
//   })

//   it("multi-turn with tool-result-only last message: appends cleanPrompt as text block", () => {
//     const messages = [
//       {
//         role: "user",
//         content: [
//           { type: "text", text: "<system-reminder>sys</system-reminder>" },
//           { type: "text", text: "nsfw prompt" },
//         ],
//       },
//       {
//         role: "assistant",
//         content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
//       },
//       {
//         role: "user",
//         content: [
//           { type: "tool_result", tool_use_id: "t1", content: "file data" },
//         ],
//       },
//     ]
//     const result = sanitizeAllUserMessages(messages, "clean prompt")

//     // First user message: text sanitized to [Prior context]
//     const firstBlocks = result[0].content as any[]
//     expect(firstBlocks[1].text).toBe("[Prior context]")

//     // Last user message: cleanPrompt appended as text block
//     const lastBlocks = result[2].content as any[]
//     expect(lastBlocks[0].type).toBe("tool_result")
//     expect(lastBlocks[1]).toEqual({ type: "text", text: "clean prompt" })
//   })

//   it("multi-turn with multiple tool calls: cleanPrompt always present", () => {
//     const messages = [
//       {
//         role: "user",
//         content: [
//           { type: "text", text: "<system-reminder>skills</system-reminder>" },
//           { type: "text", text: "<system-reminder>claudeMd</system-reminder>" },
//           { type: "text", text: "nsfw prompt" },
//         ],
//       },
//       {
//         role: "assistant",
//         content: [
//           { type: "tool_use", id: "t1", name: "Read", input: {} },
//           { type: "tool_use", id: "t2", name: "Read", input: {} },
//         ],
//       },
//       {
//         role: "user",
//         content: [
//           { type: "tool_result", tool_use_id: "t1", content: "data1" },
//           { type: "tool_result", tool_use_id: "t2", content: "data2" },
//         ],
//       },
//       {
//         role: "assistant",
//         content: [
//           { type: "text", text: "Let me explore more." },
//           { type: "tool_use", id: "t3", name: "Bash", input: {} },
//           { type: "tool_use", id: "t4", name: "Read", input: {} },
//           { type: "tool_use", id: "t5", name: "Read", input: {} },
//         ],
//       },
//       {
//         role: "user",
//         content: [
//           { type: "tool_result", tool_use_id: "t3", content: "bash output" },
//           { type: "tool_result", tool_use_id: "t4", content: "data3" },
//           { type: "tool_result", tool_use_id: "t5", content: "data4" },
//         ],
//       },
//     ]

//     const result = sanitizeAllUserMessages(messages, "clean prompt")

//     // First user message: NSFW text sanitized
//     const firstBlocks = result[0].content as any[]
//     expect(firstBlocks[2].text).toBe("[Prior context]")

//     // Last user message (tool-result-only): cleanPrompt appended
//     const lastBlocks = result[4].content as any[]
//     expect(lastBlocks).toHaveLength(4)
//     expect(lastBlocks[0].type).toBe("tool_result")
//     expect(lastBlocks[1].type).toBe("tool_result")
//     expect(lastBlocks[2].type).toBe("tool_result")
//     expect(lastBlocks[3]).toEqual({ type: "text", text: "clean prompt" })
//   })

//   it("does not mutate original messages", () => {
//     const original = [
//       {
//         role: "user",
//         content: [
//           { type: "text", text: "nsfw prompt" },
//         ],
//       },
//       { role: "assistant", content: "resp" },
//       {
//         role: "user",
//         content: [
//           { type: "tool_result", tool_use_id: "t1", content: "data" },
//         ],
//       },
//     ]
//     const originalJson = JSON.stringify(original)
//     sanitizeAllUserMessages(original, "clean")
//     expect(JSON.stringify(original)).toBe(originalJson)
//   })
// })
