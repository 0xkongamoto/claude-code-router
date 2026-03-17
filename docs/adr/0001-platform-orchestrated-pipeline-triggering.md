# ADR-0001: Platform-Orchestrated Pipeline Triggering

## Status

Accepted

## Date

2026-03-17

## Context

The NSFW sanitizer pipeline has three phases: scan placeholders, fill with NSFW LLM, and apply edits to project files. Previously, the pipeline was triggered via a **Claude Code Stop hook** — a `curl` command baked into each project's `.claude/settings.json` that POSTed to CCR's `/api/pipeline/trigger-complete` when Claude Code finished a session.

This created a **race condition**: after Claude Code completes, BOTH the Stop hook (`curl trigger-complete`) and the platform's `handleCompletionWithHealthCheck` fire simultaneously. The ApplyService runs `npm run build` to verify the build, which conflicts with the already-running `next dev` server, corrupting `.next/` build artifacts. The health check then sees a broken app, triggers the auto-fix loop, and spirals into 20+ wasted LLM requests trying to "fix" what is actually a build artifact corruption — not a real code error.

### Key constraints

- The platform already has a post-completion flow (`handleCompletionWithHealthCheck`) that starts the dev server, waits for HMR, and health-checks the app
- The `next dev` server is always running in the platform environment — running `npm run build` alongside it corrupts shared `.next/` state
- The pipeline apply step only needs to write files; HMR handles recompilation
- CCR and the platform run on the same machine (localhost)
- Existing projects already have the Stop hook in their `.claude/settings.json`

## Decision Drivers

* **Must eliminate the build conflict** between ApplyService's `npm run build` and the running `next dev` server
* **Must maintain a single orchestration point** for post-completion work to avoid race conditions
* **Should be non-fatal** — if CCR is down, the platform's existing health check flow must work uninterrupted
* **Should be idempotent** — duplicate triggers (from old Stop hooks on existing projects) must not cause errors
* **Should minimize latency** — pipeline fill + apply should complete before the health check runs

## Considered Options

### Option 1: Fix the Stop hook to skip build (CCR-only change)

Add `skipBuild` to the Stop hook's curl command body.

- **Pros**: Minimal change, no platform modification needed
- **Cons**: Still two independent triggers racing. Stop hook timing is unpredictable (fires after Claude session ends, not synchronized with health check). No way to poll for completion before health check runs.

### Option 2: Platform-orchestrated triggering (chosen)

Remove the Stop hook. Call `trigger-complete` from inside `handleCompletionWithHealthCheck` BEFORE the health check, with `skipBuild=true`. Platform polls until pipeline completes, then proceeds to health check.

- **Pros**: Single orchestrator, sequential flow, no race condition, platform can poll for completion, health check verifies real content
- **Cons**: Cross-repo change (CCR + platform), platform now depends on CCR API availability (mitigated by try/catch + `isAvailable()` check)

### Option 3: Event-driven via webhook callback

CCR calls the platform back when apply completes, platform then runs health check.

- **Pros**: Decoupled, event-driven
- **Cons**: Requires platform to expose a callback endpoint, adds complexity, harder to reason about flow ordering, needs correlation IDs

## Decision

**Option 2: Platform-orchestrated triggering.**

The platform becomes the sole orchestrator of the post-completion flow. The Stop hook is removed from new projects. CCR's `trigger-complete` endpoint and `ApplyService.executeApply` accept a `skipBuild` option so the apply phase only writes files without running `npm run build` or git operations.

### Changes across repos

#### CCR repo (`packages/server/`)

1. **`sanitizer/apply.ts`** — `executeApply` accepts `options?: { skipBuild?: boolean }`. When `skipBuild`:
   - Skips `verifyBuild()` (no `npm run build`)
   - Skips git snapshot, rollback, and commit
   - Still runs: `applyFileEdits()`, `writeContentFiles()`, `scanPlaceholders()`

2. **`index.ts`** (trigger-complete endpoint) — Accepts `projectPath` and `skipBuild` in request body. Filters sessions by `projectPath` when provided. Passes `{ skipBuild }` through the `pipeline:reportCaptured` event.

3. **`index.ts`** (event listener) — `pipeline:reportCaptured` handler accepts `options` and forwards to `executeApply`.

#### Platform repo (`backend/src/`)

4. **`config/env.ts`** — Added `CCR_URL` env var (optional, no default). When not set, pipeline is silently skipped.

5. **`services/PipelineService.ts`** — New service (~80 lines) with three methods:
   - `isAvailable()` — 2s timeout GET to `/api/pipeline`
   - `triggerComplete(projectPath)` — POST with `{ projectPath, skipBuild: true }`
   - `pollUntilComplete(sessionId, 60s)` — polls every 2s until `apply_complete` or `error`

6. **`routes/websocket.ts`** — Inserted "Step 0" in `handleCompletionWithHealthCheck` before `autoStartDevServer`: trigger pipeline, poll until complete, then continue to health check. Entire block wrapped in try/catch (non-fatal).

7. **`services/ProjectService.ts`** — Removed Stop hook from `scaffoldProject`'s `.claude/settings.json`.

## Rationale

1. **Single orchestrator eliminates the race condition.** The platform controls the exact ordering: pipeline apply (write files) -> start dev server -> wait for HMR -> health check. No concurrent `npm run build`.

2. **`skipBuild` is the right granularity.** The platform's dev server + HMR already handles recompilation. ApplyService only needs to write files. Build verification is redundant and actively harmful in this environment.

3. **Natural idempotency for existing projects.** Old projects still have the Stop hook, but `trigger-complete` filters by `sfw_in_progress` status. After the platform's call completes the pipeline, the Stop hook's subsequent call finds no eligible sessions — zero triggered, no error.

4. **Non-fatal design preserves independence.** If CCR is down, `isAvailable()` returns false in 2s, the pipeline block is skipped, and the existing health check flow runs exactly as before.

## Consequences

### Positive

- Eliminates `.next/` artifact corruption from concurrent builds
- Eliminates the auto-fix spiral (20+ wasted LLM requests)
- Health check now verifies real NSFW content (applied before check, not racing with it)
- Cleaner project scaffolding (no hook in settings.json)
- Pipeline completion is observable from platform logs

### Negative

- Platform now has a soft dependency on CCR's API (mitigated: non-fatal, 2s availability check)
- Cross-repo coupling: platform must know CCR's API contract
- Polling adds up to 60s to the post-completion flow (only when pipeline has work to do)

### Risks

- **CCR API changes break platform integration.** Mitigation: the entire pipeline block is wrapped in try/catch; failures are logged and silently skipped.
- **Poll timeout (60s) may be insufficient for large fills.** Mitigation: timeout returns gracefully, health check still runs. Fill result will apply on next trigger or can be manually triggered.

## Final Flow

```
Claude Code: session done
    |
    v
Platform: handleCompletionWithHealthCheck()
    |
    +-- Step 0: pipelineService.triggerComplete(projectPath, skipBuild=true)
    |     +-- CCR scans project for {{__SLOT_NNN__}} placeholders
    |     +-- Fill via NSFW LLM (~5-30s)
    |     +-- Apply: write files only (no npm run build, no git)
    |     Poll every 2s until apply_complete (max 60s)
    |
    +-- Step 1: autoStartDevServer (existing)
    +-- Step 2: wait 3s for HMR to pick up written files
    +-- Step 3: health check GET / -> verify with real content
    |     +-- OK -> done
    |     +-- FAIL -> auto-fix (fixes real issues, not build artifacts)
    |
    +-- Feature suggestions (existing)
```
