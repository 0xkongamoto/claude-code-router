# ADR-0002: Dual-path Image Processing for NSFW Pipeline

## Status

Accepted

## Date

2026-03-18

## Context

The NSFW sanitizer pipeline (see [pipeline-flow.md](../pipeline-flow.md)) routes requests through a two-phase process: Phase 1 generates clean code with placeholders via a SFW model (Claude Opus, multimodal), and Phase 2 fills placeholders with NSFW content via an uncensored model (MiniMax-M2.5-Uncensored on RunPod, **text-only**).

When a user pastes an image (e.g., a UI mockup) alongside an NSFW request, two problems arise:

1. **MiniMax cannot process images.** The NSFW fill model is text-only. It has zero context about what the user's image contains, leading to generic or mismatched placeholder fills.

2. **ImageAgent conflicts with the pipeline.** The preHandler hook chain runs ImageAgent **before** the sanitizer. When ImageAgent activates, it sets `req.agents`, which causes the `onSend` hook to enter the agent tool interception branch instead of the pipeline report extraction branch (`!req.agents` guard at `index.ts:360`). This silently breaks the entire NSFW pipeline — no report is extracted, no fill is triggered.

### Key constraints

- ImageAgent must still work unchanged for SFW requests (it provides the `analyzeImage` tool and routes to `Router.image`)
- The sanitizer must classify content before we know which image processing path to take
- Pipeline report extraction requires `req.agents` to NOT be set
- An uncensored multimodal model may or may not be available (must degrade gracefully)
- Images flow end-to-end as base64 content blocks from FE through Brain to CCR — no file upload endpoints

## Decision Drivers

* **Must not break SFW image flow** — ImageAgent's existing behavior must be preserved exactly
* **Must not break NSFW text-only flow** — requests without images must work as before
* **Must keep pipeline report extraction working** — `req.agents` must not be set on the NSFW path
* **Should provide image context to the NSFW fill model** — via text descriptions when a vision model is available
* **Should degrade gracefully** — if no uncensored vision model is configured or the vision API fails

## Considered Options

### Option 1: Image Pre-description (before sanitizer)

Add a hook before the sanitizer that describes all images via an uncensored multimodal model, then replaces image blocks with text descriptions. All downstream consumers see text only.

- **Pros**: Simple, universal — all downstream models get text
- **Cons**: Adds latency to every image request (even SFW). SFW requests lose native multimodal support since images are converted to text.

### Option 2: Extend ImageAgent with NSFW-aware routing

When sanitizer classifies NSFW, the `analyzeImage` tool routes to an uncensored vision model instead of the default `Router.image`.

- **Pros**: Minimal changes, reuses existing tool mechanism
- **Cons**: ImageAgent still sets `req.agents`, breaking report extraction. Opus must decide to call `analyzeImage` — may refuse if prompt context is too NSFW. Requires coordinating between ImageAgent and sanitizer.

### Option 3: Dual-path Image Processing (chosen)

Defer image processing until after classification. Run different paths based on SFW/NSFW:
- **SFW**: Activate ImageAgent as before
- **NSFW + vision available**: Describe images via uncensored vision model, inject descriptions into nsfwSpec, replace image blocks with text. Do NOT set `req.agents`.
- **NSFW + vision fails**: Keep images in messages (Opus is multimodal and can see them in Phase 1). Phase 2 lacks image context — acceptable degradation.
- **NSFW + no vision configured**: Strip images entirely.

- **Pros**: Clean separation. SFW flow unchanged. NSFW flow works with or without vision. Pipeline report extraction always works (no `req.agents`).
- **Cons**: More code (3 new files). Hook chain is more complex (4 hooks instead of 1). Image detection logic partially duplicated from ImageAgent.

## Decision

**Option 3: Dual-path Image Processing.**

The preHandler hook chain is restructured to separate image detection from image processing:

```
Hook 5: Image Detection        — detect + cache, do NOT activate ImageAgent
Hook 6: Sanitizer              — classify SFW/NSFW (unchanged)
Hook 7: Post-classification    — SFW → activate ImageAgent; NSFW → vision or strip
Hook 8: Non-image Agents       — run all agents except ImageAgent
```

### New components

| File | Purpose |
|------|---------|
| `agents/imageDetection.ts` | Pure functions: `detectImages()`, `replaceImagesWithDescriptions()`, `stripImages()` |
| `sanitizer/vision.ts` | `NsfwVisionService` — calls uncensored multimodal model to describe images |
| `sanitizer/imageRouting.ts` | `activateImageAgentForSfw()` + `handleNsfwImages()` — post-classification routing |

### Modified components

| File | Change |
|------|--------|
| `switcher/types.ts` | Added `ImageDescription`, `NsfwVisionConfig` interfaces; extended `NsfwSpec` + `PipelineConfig` |
| `sanitizer/store.ts` | Added `updateNsfwSpec()` method |
| `sanitizer/fill.ts` | Added "Image Context" section to fill prompt |
| `index.ts` | Restructured hook chain (4 hooks replacing 1) |

### Configuration

```json
{
  "Pipeline": {
    "nsfwVision": {
      "model": "venice-uncensored-role-play",
      "apiKey": "$VENICE_API_KEY",
      "apiUrl": "https://api.venice.ai/api/v1/chat/completions",
      "timeoutMs": 60000,
      "maxTokens": 2048
    }
  }
}
```

When `nsfwVision` is omitted or `model` is empty, the feature is disabled and images are stripped on the NSFW path.

## Rationale

1. **Deferring image processing until after classification** is the only approach that avoids the `req.agents` conflict. ImageAgent runs before the sanitizer in the original design; by splitting detection from activation, we can make the decision after classification.

2. **Keeping images on vision failure** is better than stripping them. Opus (Phase 1, multimodal) can still see the image and generate better code. Only Phase 2 (MiniMax, text-only) loses image context — but it couldn't use images regardless.

3. **Not modifying ImageAgent** minimizes risk. The existing `shouldHandle` + `reqHandler` logic is complex (two code paths based on image position). Rewriting it would affect all SFW image handling. Instead, the new routing layer calls into ImageAgent's existing methods for the SFW path.

4. **Pure functions in imageDetection.ts** make the detection logic testable and reusable, vs being buried inside ImageAgent's methods.

## Consequences

### Positive

- NSFW requests with images no longer break the pipeline
- When vision is configured: MiniMax receives image descriptions for better placeholder fills
- When vision fails: Opus still sees images natively (graceful degradation)
- SFW image flow is completely unchanged
- Pipeline report extraction always works on NSFW path

### Negative

- Hook chain complexity increased (4 hooks instead of 1)
- Image detection logic partially duplicated from ImageAgent (Path A tool_result extraction)
- Requires an uncensored multimodal model for full functionality
- Vision API call adds latency to NSFW+image requests (~2-30s depending on model)

### Risks

- **Vision model quality varies.** Poor descriptions lead to poor NSFW fills. Mitigation: the fill prompt includes full nsfwSpec context alongside descriptions — descriptions are supplementary, not the sole input.
- **Hook ordering is implicit.** The 4-hook sequence depends on registration order in `index.ts`. Mitigation: comments document required order.
- **ImageAgent Path A logic is duplicated** in `imageRouting.ts`. If ImageAgent changes, the copy must be updated. Mitigation: the original ImageAgent was not modified and the routing file cross-references the relevant lines.

## Related Decisions

- ADR-0001: Platform-Orchestrated Pipeline Triggering — established the pipeline architecture this decision extends
