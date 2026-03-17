import { describe, it, expect } from "vitest"
import { extractProjectPath } from "./index"

describe("extractProjectPath", () => {
  it("extracts path from string system prompt", () => {
    const system = "You are an assistant.\n - Primary working directory: /Users/macbookpro/Projects/my-app\n - Platform: darwin"
    expect(extractProjectPath(system)).toBe("/Users/macbookpro/Projects/my-app")
  })

  it("extracts path from array system prompt", () => {
    const system = [
      { type: "text", text: "You are an assistant." },
      { type: "text", text: " - Primary working directory: /home/ubuntu/workspace/project\n - Platform: linux" },
    ]
    expect(extractProjectPath(system)).toBe("/home/ubuntu/workspace/project")
  })

  it("handles UUID-based workspace paths", () => {
    const system = " - Primary working directory: /private/tmp/one-workspaces/7fbf25d1-ecb9-48ce-bc88-c2288525776a/projects/1cfccb4d-6c4a-4c45-a1a1-6949d6b05d9d"
    expect(extractProjectPath(system)).toBe(
      "/private/tmp/one-workspaces/7fbf25d1-ecb9-48ce-bc88-c2288525776a/projects/1cfccb4d-6c4a-4c45-a1a1-6949d6b05d9d"
    )
  })

  it("returns null when no system prompt", () => {
    expect(extractProjectPath(null)).toBeNull()
    expect(extractProjectPath(undefined)).toBeNull()
  })

  it("returns null when system prompt has no working directory", () => {
    expect(extractProjectPath("You are a helpful assistant.")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(extractProjectPath("")).toBeNull()
  })
})
