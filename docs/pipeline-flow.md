# NSFW Pipeline Flow: Request → Finished App

**Date:** 2026-03-16
**Log reference:** `~/.claude-code-router/logs/ccr-20260316100554.log` (62 requests, 53 NSFW, 9 SFW)

---

## Architecture Overview

```
User Request
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│  PHASE 1: SFW Generation                                 │
│                                                          │
│  ┌────────────┐    ┌────────────┐    ┌────────────────┐  │
│  │ Sanitizer  │───▶│  Replace   │───▶│  SFW Model     │  │
│  │ (classify  │    │  Messages  │    │  (Claude Opus)  │  │
│  │  + decomp) │    │  (clean)   │    │  generates app  │  │
│  └────────────┘    └────────────┘    │  with {{NSFW_*}}│  │
│   Sonnet 4.6                         │  placeholders   │  │
│   ~2-13s (miss)                      └───────┬────────┘  │
│   <1ms (cached)                              │           │
│                                              ▼           │
│                                   ┌──────────────────┐   │
│                                   │ Report Extraction │   │
│                                   │ (onSend hook)     │   │
│                                   │ parse markers     │   │
│                                   └────────┬─────────┘   │
│                                            │             │
└────────────────────────────────────────────┼─────────────┘
                                             │
              Trigger: POST /api/pipeline/:id/fill
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────┐
│  PHASE 2: NSFW Fill + Apply                              │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────────┐ │
│  │ NSFW Fill        │───▶│ Apply Service                │ │
│  │ (uncensored LLM) │    │ 1. Write file edits          │ │
│  │ MiniMax on       │    │ 2. Write content files        │ │
│  │ RunPod           │    │ 3. Scan remaining {{NSFW_*}}  │ │
│  │                  │    │ 4. npm run build (verify)      │ │
│  │ fills            │    │ 5. Git commit or rollback      │ │
│  │ {{NSFW_*}} →     │    └──────────────────────────────┘ │
│  │ real values      │                                     │
│  └─────────────────┘                                      │
│                                                           │
└───────────────────────────────────────────────────────────┘
                        │
                        ▼
                  Finished App
```

---

## Component Map

| Component | File | Purpose |
|-----------|------|---------|
| **Sanitizer** | `server/src/sanitizer/sanitizer.ts` | Classifies content (SFW/NSFW), generates cleanPrompt + nsfwSpec |
| **SanitizerHook** | `server/src/sanitizer/index.ts` | preHandler hook — orchestrates sanitization per request |
| **Replace** | `server/src/sanitizer/replace.ts` | Replaces NSFW text in ALL user messages with clean versions |
| **PipelineStore** | `server/src/sanitizer/store.ts` | LRU session state machine tracking pipeline phases |
| **ReportAccumulator** | `server/src/sanitizer/report.ts` | Extracts implementation report from streaming response |
| **NsfwFillService** | `server/src/sanitizer/fill.ts` | Calls uncensored model to fill `{{NSFW_*}}` placeholders |
| **ApplyService** | `server/src/sanitizer/apply.ts` | Writes filled values to project files, verifies build |
| **Pipeline API** | `server/src/index.ts` (lines 564-670) | REST endpoints for fill/apply/status |

---

## Phase 1: SFW Generation (Automatic)

Runs automatically on every `/v1/messages` request.

### Step 1 — Classification (`sanitizer.ts`)

The sanitizer calls Claude Sonnet 4.6 with a decomposition prompt. It extracts all user message text and classifies it.

**Input:** User's raw messages
**Output:**
```typescript
SanitizerResult {
  classification: "sfw" | "nsfw" | "mixed"
  confidence: 0-1
  cleanPrompt: string | null    // e.g. "Build a game with {{NSFW_GAME_TITLE}}"
  nsfwSpec: {
    codeChanges: [{ placeholder, description, location }]
    contentChanges: [{ file, path, description }]
    context: string  // "An adult trivia quiz game..."
  }
}
```

**Placeholder naming convention:** `{{NSFW_<CATEGORY>_<DESCRIPTION>}}`
Categories: LABEL, DIALOGUE, PROMPT, STATE, LOGIC, STYLE, CONFIG

**From log (req-h, t=1773630864868):**
```
classification: "nsfw", confidence: 0.97
cleanPrompt: "Update the current trivia quiz application to pre-process all images..."
  placeholders: {{NSFW_STATE_CLOTHING_ITEM}}, {{NSFW_STATE_CLOTHING_REMOVAL_STEPS}}
```

### Step 2 — Message Sanitization (`replace.ts`)

After classification, the hook sanitizes ALL user messages — not just the last one.

```
BEFORE (3-message conversation):
  msg[0] user: "Build me a strip poker game"      ← NSFW history
  msg[1] assistant: "I'll plan that..."
  msg[2] user: "Now add the undressing logic"      ← Current NSFW request

AFTER sanitizeAllUserMessages():
  msg[0] user: "[Prior context]"                   ← Sanitized
  msg[1] assistant: "I'll plan that..."            ← Unchanged
  msg[2] user: "Add game logic with {{NSFW_*}}..." ← cleanPrompt
```

**Logic:**
- Last user message → replaced with `cleanPrompt`
- Earlier user messages → replaced with `[Prior context]` placeholder
- `<system-reminder>` blocks preserved (they contain tool/skill metadata)
- Non-text blocks preserved (tool_result, images, etc.)

### Step 3 — System Prompt Injection (`index.ts`)

The hook appends a report instruction to `req.body.system`:

```
IMPORTANT: After completing the implementation, output a structured
implementation report wrapped in markers.

<<<IMPLEMENTATION_REPORT>>>
{
  "summary": "...",
  "files": [...],
  "placeholders": [{ "id": "{{NSFW_GAME_TITLE}}", "file": "...", "line": 12, "type": "string" }],
  ...
}
<<<END_IMPLEMENTATION_REPORT>>>
```

This forces the SFW model to output a machine-parseable report listing every `{{NSFW_*}}` placeholder with its file, line, and type.

### Step 4 — Routing Decision

Based on classification:

| Condition | Route | Model |
|-----------|-------|-------|
| SFW | SFW provider | Claude Opus 4.6 |
| NSFW + cleanPrompt exists | SFW provider (content is clean) | Claude Opus 4.6 |
| NSFW + NO cleanPrompt | NSFW provider (uncensored) | MiniMax Uncensored (RunPod) |

**From log:**
- `hasCleanPrompt:true` → Opus via `smart-agent-api.eternalai.org` (9 requests)
- `hasCleanPrompt:false` → MiniMax via `p2b5yivc05me87-8000.proxy.runpod.net` (44 requests)

### Step 5 — Report Extraction (onSend hook)

While streaming the response to the client, the onSend hook tees the stream:

```
Response Stream
    │
    tee()
    ├──▶ Client (original stream, unmodified)
    │
    └──▶ ReportAccumulator
         │ Parses SSE events
         │ Accumulates text_delta chunks
         │ Looks for <<<IMPLEMENTATION_REPORT>>> markers
         │
         ▼
         PipelineStore.setReport(sessionId, report)
         State: sfw_in_progress → sfw_complete
```

**Trigger condition (`index.ts:328`):**
```typescript
if (req.sanitizerResult && pipelineStore && !req.agents)
```

Only runs when: sanitizer classified as NSFW + cleanPrompt was used + not an agent request.

---

## Phase Transition: SFW → NSFW

**Trigger:** Client calls `POST /api/pipeline/:sessionId/fill`

This is NOT automatic. The client must:
1. Poll `GET /api/pipeline/:sessionId` until `status === "sfw_complete"`
2. Then POST to `/fill` to start the NSFW phase

**State machine:**
```
sfw_in_progress → sfw_complete → nsfw_pending → nsfw_in_progress → nsfw_complete
                       ▲                                                  │
                       │                                                  ▼
                  Report extracted                              apply_pending → apply_complete
                  from stream
```

---

## Phase 2: NSFW Fill + Apply (Client-Triggered)

### Step 6 — NSFW Fill (`fill.ts`)

The fill service calls an uncensored model with the nsfwSpec + implementation report.

**Input:**
```
# NSFW Specification
**Theme/Context:** An adult trivia quiz game where correct answers
                    progressively undress a subject

## Code Changes Required
- {{NSFW_STATE_CLOTHING_ITEM}}: "Name of clothing item being removed"
- {{NSFW_STATE_CLOTHING_REMOVAL_STEPS}}: "Undressing progression steps"

# Implementation Report
**Summary:** Built trivia quiz app with image processing
**Placeholders by File:**
  src/components/Game.tsx:
    - Line 12: {{NSFW_STATE_CLOTHING_ITEM}} (type: string)
    - Line 45: {{NSFW_STATE_CLOTHING_REMOVAL_STEPS}} (type: array)
```

**Model:** `NikolaSigmoid/MiniMax-M2.5-Uncensored-FP8` on RunPod
**Timeout:** 120s, max 2 retries

**Output:**
```json
{
  "edits": [
    {
      "file": "src/components/Game.tsx",
      "replacements": [
        { "find": "{{NSFW_STATE_CLOTHING_ITEM}}", "replace": "bra" },
        { "find": "{{NSFW_STATE_CLOTHING_REMOVAL_STEPS}}", "replace": "[\"shirt\", \"pants\", \"bra\", \"panties\"]" }
      ]
    }
  ],
  "contentFiles": [
    { "file": "public/adult-content.json", "content": "{ ... }" }
  ]
}
```

### Step 7 — Apply to Disk (`apply.ts`)

**Trigger:** Client calls `POST /api/pipeline/:sessionId/apply` with `{ projectPath }`

**Flow:**
1. **Git snapshot** — commit current state (rollback point)
2. **Apply edits** — for each file: read → `content.replaceAll(find, replace)` → write
3. **Write content files** — create new files from fill result
4. **Scan remaining** — regex `{{NSFW_[A-Z0-9_]+}}` across project (should be 0)
5. **Build verify** — run `npm run build` (120s timeout)
6. **Git commit or rollback**:
   - Build OK → `git commit -m "nsfw: fill placeholders with content"`
   - Build FAIL → `git reset --hard` to snapshot

**Security:**
- Path traversal blocked (no `..`, null bytes)
- Forbidden system dirs (`/etc`, `/usr`, `/bin`, etc.)
- Max file size: 5MB

---

## Placeholder Replacement Logic (Detail)

### How Placeholders Flow Through the System

```
                    Sanitizer                    SFW Model (Opus)              NSFW Model (MiniMax)
                    ─────────                    ────────────────              ────────────────────
User says:          Decomposes to:               Generates code with:         Fills with:
"strip poker"  →    cleanPrompt with             {{NSFW_GAME_TITLE}}     →   "Strip Poker Showdown"
                    {{NSFW_GAME_TITLE}}           in actual .tsx files

                    nsfwSpec records:             Report records:
                    placeholder: GAME_TITLE       file: Game.tsx
                    description: "game title      line: 12
                    for adult card game"          type: string
                                                  context: <h1>{GAME_TITLE}</h1>
```

### Placeholder Types & Fill Rules

| Type | What It Is | Example Find → Replace |
|------|-----------|----------------------|
| `string` | Text in quotes | `{{NSFW_LABEL_TITLE}}` → `"Strip Poker"` |
| `array` | JSON array literal | `{{NSFW_CONFIG_STEPS}}` → `["shirt","pants","bra"]` |
| `object` | JSON object literal | `{{NSFW_CONFIG_SETTINGS}}` → `{"explicit":true}` |
| `number` | Numeric value | `{{NSFW_CONFIG_MAX_LEVEL}}` → `5` |
| `logic` | Code expression | `{{NSFW_LOGIC_IS_NAKED}}` → `clothingItems.length === 0` |
| `style` | CSS class/inline | `{{NSFW_STYLE_BLUR}}` → `blur-none opacity-100` |

### `replaceAll` Strategy (`apply.ts`)

The apply service uses `String.replaceAll()` — simple text substitution:

```typescript
// For each file in fillResult.edits:
for (const replacement of edit.replacements) {
  content = content.replaceAll(replacement.find, replacement.replace)
}
```

This means:
- Same placeholder used in multiple places within a file → ALL replaced
- Placeholder must match EXACTLY (case-sensitive)
- No AST parsing — pure string replacement

---

## Log Evidence (ccr-20260316100554.log)

### Session Statistics

| Metric | Value |
|--------|-------|
| Total requests | 62 |
| NSFW classified | 53 (85%) |
| SFW classified | 9 (15%) |
| NSFW with cleanPrompt | 9 → routed to Opus |
| NSFW without cleanPrompt | 44 → routed to MiniMax Uncensored |
| Cache hits | 44 (84% of NSFW) |
| Cache misses | 9 (latency 2-13s) |
| Fill/Apply triggered | 0 (services initialized but not invoked) |

### Example: Clean Route (req-h)

```
t+0s     incoming request (req-h)
t+12.8s  Sanitizer: nsfw, confidence=0.97, cleanPrompt=✓, nsfwSpec=✓
t+12.9s  Route → Opus via smart-agent-api.eternalai.org
t+23.4s  Response complete (stop_reason: tool_use)
         → Opus generating code with {{NSFW_STATE_*}} placeholders
```

### Example: Uncensored Route (req-7)

```
t+0s     incoming request (req-7)
t+8.1s   Sanitizer: nsfw, confidence=0.97, cleanPrompt=✗, nsfwSpec=✓
t+8.2s   Route → MiniMax Uncensored via RunPod
t+12.9s  Response complete (stop_reason: tool_use)
         → MiniMax handling raw NSFW prompt directly
```

### Note: Fill/Apply Not Triggered

In this session, the client never called `/api/pipeline/:sessionId/fill` or `/apply`. The NsfwFillService and ApplyService were initialized at startup but remained dormant. The pipeline completed Phase 1 (SFW generation with placeholders) but Phase 2 (NSFW fill + apply) was not triggered.
