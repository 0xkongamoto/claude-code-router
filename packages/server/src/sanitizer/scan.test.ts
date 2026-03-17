import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, writeFile, rm } from "fs/promises"
import { join } from "path"
import { homedir } from "os"
import {
  scanProjectPlaceholders,
  buildSyntheticReport,
  inferPlaceholderType,
  ScanResult,
} from "./scan"

const TEST_TMP_BASE = join(homedir(), ".scan-test-tmp")

let testDir: string

beforeEach(async () => {
  testDir = join(TEST_TMP_BASE, `test-${Date.now()}`)
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {})
})

describe("scanProjectPlaceholders", () => {
  it("finds placeholders in project files", async () => {
    await mkdir(join(testDir, "src"), { recursive: true })
    await writeFile(
      join(testDir, "src", "app.tsx"),
      'const title = "{{__SLOT_001__}}"\nconst desc = "{{__SLOT_002__}}"',
      "utf-8"
    )

    const results = await scanProjectPlaceholders(testDir)

    expect(results).toHaveLength(2)
    expect(results[0].placeholder).toBe("{{__SLOT_001__}}")
    expect(results[0].relativePath).toBe("src/app.tsx")
    expect(results[0].line).toBe(1)
    expect(results[1].placeholder).toBe("{{__SLOT_002__}}")
    expect(results[1].line).toBe(2)
  })

  it("skips node_modules and .git", async () => {
    await mkdir(join(testDir, "node_modules", "pkg"), { recursive: true })
    await mkdir(join(testDir, ".git", "objects"), { recursive: true })
    await mkdir(join(testDir, "src"), { recursive: true })

    await writeFile(
      join(testDir, "node_modules", "pkg", "index.js"),
      "const x = {{__SLOT_001__}}",
      "utf-8"
    )
    await writeFile(
      join(testDir, ".git", "objects", "data.json"),
      '{"val": "{{__SLOT_002__}}"}',
      "utf-8"
    )
    await writeFile(
      join(testDir, "src", "index.ts"),
      "const y = {{__SLOT_003__}}",
      "utf-8"
    )

    const results = await scanProjectPlaceholders(testDir)

    expect(results).toHaveLength(1)
    expect(results[0].placeholder).toBe("{{__SLOT_003__}}")
  })

  it("skips non-scannable extensions", async () => {
    await writeFile(join(testDir, "image.png"), "{{__SLOT_001__}}", "utf-8")
    await writeFile(join(testDir, "data.json"), '{"v": "{{__SLOT_002__}}"}', "utf-8")

    const results = await scanProjectPlaceholders(testDir)

    expect(results).toHaveLength(1)
    expect(results[0].placeholder).toBe("{{__SLOT_002__}}")
  })

  it("returns empty for projects without placeholders", async () => {
    await writeFile(join(testDir, "index.ts"), "const x = 42", "utf-8")

    const results = await scanProjectPlaceholders(testDir)

    expect(results).toHaveLength(0)
  })

  it("extracts surrounding context lines", async () => {
    const content = [
      "line 1",
      "line 2",
      'const val = "{{__SLOT_001__}}"',
      "line 4",
      "line 5",
    ].join("\n")
    await writeFile(join(testDir, "file.ts"), content, "utf-8")

    const results = await scanProjectPlaceholders(testDir)

    expect(results).toHaveLength(1)
    expect(results[0].context).toContain("line 2")
    expect(results[0].context).toContain("{{__SLOT_001__}}")
    expect(results[0].context).toContain("line 4")
  })

  it("handles multiple placeholders on the same line", async () => {
    await writeFile(
      join(testDir, "multi.ts"),
      'const a = "{{__SLOT_001__}}" + "{{__SLOT_002__}}"',
      "utf-8"
    )

    const results = await scanProjectPlaceholders(testDir)

    expect(results).toHaveLength(2)
    expect(results[0].placeholder).toBe("{{__SLOT_001__}}")
    expect(results[1].placeholder).toBe("{{__SLOT_002__}}")
  })
})

describe("inferPlaceholderType", () => {
  it("detects string inside double quotes", () => {
    const result = inferPlaceholderType('"{{__SLOT_001__}}"', "{{__SLOT_001__}}")
    expect(result).toBe("string")
  })

  it("detects string inside single quotes", () => {
    const result = inferPlaceholderType("'{{__SLOT_001__}}'", "{{__SLOT_001__}}")
    expect(result).toBe("string")
  })

  it("detects style context with className", () => {
    const result = inferPlaceholderType(
      'className= {{__SLOT_001__}}',
      "{{__SLOT_001__}}"
    )
    expect(result).toBe("style")
  })

  it("detects logic context with if", () => {
    const result = inferPlaceholderType(
      "if ({{__SLOT_001__}}",
      "{{__SLOT_001__}}"
    )
    expect(result).toBe("logic")
  })

  it("detects logic context with ternary", () => {
    const result = inferPlaceholderType(
      "return {{__SLOT_001__}} ? a : b",
      "{{__SLOT_001__}}"
    )
    expect(result).toBe("logic")
  })

  it("detects array when followed by [", () => {
    const result = inferPlaceholderType(
      "const arr = {{__SLOT_001__}} [1, 2]",
      "{{__SLOT_001__}}"
    )
    expect(result).toBe("array")
  })

  it("detects object when followed by {", () => {
    const result = inferPlaceholderType(
      "const obj = {{__SLOT_001__}} { key: 1 }",
      "{{__SLOT_001__}}"
    )
    expect(result).toBe("object")
  })

  it("defaults to string for ambiguous context", () => {
    const result = inferPlaceholderType(
      "const x = {{__SLOT_001__}}",
      "{{__SLOT_001__}}"
    )
    expect(result).toBe("string")
  })
})

describe("buildSyntheticReport", () => {
  it("builds a valid ImplementationReport", () => {
    const scanResults: ScanResult[] = [
      {
        file: "/project/src/app.tsx",
        relativePath: "src/app.tsx",
        line: 5,
        placeholder: "{{__SLOT_001__}}",
        context: 'const title = "{{__SLOT_001__}}"',
        lineContent: 'const title = "{{__SLOT_001__}}"',
      },
      {
        file: "/project/src/app.tsx",
        relativePath: "src/app.tsx",
        line: 10,
        placeholder: "{{__SLOT_002__}}",
        context: 'className= {{__SLOT_002__}}',
        lineContent: 'className= {{__SLOT_002__}}',
      },
    ]

    const report = buildSyntheticReport("/project", scanResults)

    expect(report.summary).toContain("2 placeholder(s)")
    expect(report.summary).toContain("1 file(s)")
    expect(report.placeholders).toHaveLength(2)
    expect(report.files).toHaveLength(1)
    expect(report.files[0].path).toBe("src/app.tsx")
    expect(report.buildStatus).toBe("success")
    expect(report.placeholders[0].id).toBe("__SLOT_001__")
    expect(report.placeholders[1].type).toBe("style")
  })

  it("deduplicates files", () => {
    const scanResults: ScanResult[] = [
      {
        file: "/p/a.ts",
        relativePath: "a.ts",
        line: 1,
        placeholder: "{{__SLOT_001__}}",
        context: "x",
        lineContent: "{{__SLOT_001__}}",
      },
      {
        file: "/p/a.ts",
        relativePath: "a.ts",
        line: 2,
        placeholder: "{{__SLOT_002__}}",
        context: "y",
        lineContent: "{{__SLOT_002__}}",
      },
      {
        file: "/p/b.ts",
        relativePath: "b.ts",
        line: 1,
        placeholder: "{{__SLOT_003__}}",
        context: "z",
        lineContent: "{{__SLOT_003__}}",
      },
    ]

    const report = buildSyntheticReport("/p", scanResults)

    expect(report.files).toHaveLength(2)
    expect(report.placeholders).toHaveLength(3)
  })

  it("identifies content files under content/ directory", () => {
    const scanResults: ScanResult[] = [
      {
        file: "/p/content/posts.json",
        relativePath: "content/posts.json",
        line: 3,
        placeholder: "{{__SLOT_001__}}",
        context: '{"title": "{{__SLOT_001__}}"}',
        lineContent: '"title": "{{__SLOT_001__}}"',
      },
    ]

    const report = buildSyntheticReport("/p", scanResults)

    expect(report.contentFiles).toHaveLength(1)
    expect(report.contentFiles[0].path).toBe("content/posts.json")
    expect(report.contentFiles[0].placeholderPaths).toContain("{{__SLOT_001__}}")
  })

  it("infers tech stack from file extensions", () => {
    const scanResults: ScanResult[] = [
      {
        file: "/p/app.tsx",
        relativePath: "app.tsx",
        line: 1,
        placeholder: "{{__SLOT_001__}}",
        context: "x",
        lineContent: "{{__SLOT_001__}}",
      },
      {
        file: "/p/style.css",
        relativePath: "style.css",
        line: 1,
        placeholder: "{{__SLOT_002__}}",
        context: "y",
        lineContent: "{{__SLOT_002__}}",
      },
    ]

    const report = buildSyntheticReport("/p", scanResults)

    expect(report.techStack).toContain("React")
    expect(report.techStack).toContain("TypeScript")
    expect(report.techStack).toContain("CSS")
  })

  it("returns empty contentFiles for non-content directories", () => {
    const scanResults: ScanResult[] = [
      {
        file: "/p/src/config.json",
        relativePath: "src/config.json",
        line: 1,
        placeholder: "{{__SLOT_001__}}",
        context: "x",
        lineContent: "{{__SLOT_001__}}",
      },
    ]

    const report = buildSyntheticReport("/p", scanResults)

    expect(report.contentFiles).toHaveLength(0)
  })
})
