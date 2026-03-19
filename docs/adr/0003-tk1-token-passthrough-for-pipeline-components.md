# ADR-0003: TK1 Token Passthrough for Pipeline Components

## Status

Accepted

## Date

2026-03-18

## Context

The NSFW sanitizer pipeline has three service components that make direct API calls to upstream providers:

- **Sanitizer** (`sanitizer.ts`) — classifies content via Claude Sonnet on `smart-agent-api` proxy
- **NsfwFillService** (`fill.ts`) — fills placeholders via MiniMax Uncensored on `smart-agent-api` proxy
- **NsfwVisionService** (`vision.ts`) — describes images via Venice model on `smart-agent-api` proxy

Previously, each component used a **static API key** from its config section (`Pipeline.sanitizer.apiKey`, `Pipeline.nsfwAgent.apiKey`, etc.). The `smart-agent-api` proxy, however, authenticates using **TK1 tokens** — session-bound tokens sent by the client (Claude Code CLI) in the `x-api-key` request header.

This created two problems:

1. **Authentication mismatch**: The `smart-agent-api` proxy expects TK1 format tokens (`TK1 BKHW...bQA=`), but pipeline components sent static API keys (`open_5fb5863c...` or `VENICE-INFERENCE-KEY-...`). Some endpoints accepted the static key as a fallback, others returned 401.

2. **Key management burden**: Each pipeline component required its own `apiKey` in the config file. When all endpoints route through the same proxy, a single shared token is simpler.

The Router's existing "Token Passthrough" mechanism already solves this for normal request routing — it extracts TK1 from the incoming request header and forwards it to the upstream Provider. But pipeline components bypass the Router entirely (they make direct `fetch()` calls), so they never benefited from this mechanism.

### Key constraints

- TK1 tokens are per-request (session-bound), not static config values
- Pipeline components are instantiated once at startup — they cannot store per-request state
- The NsfwFillService runs asynchronously via an event handler (`pipeline:reportCaptured`) — it has no access to the original request object
- Must fall back gracefully to static config API key when TK1 is not available (e.g., requests without authentication, or manual API calls)

## Decision Drivers

* **Must use TK1 when available** — the `smart-agent-api` proxy requires it for proper authentication
* **Must fall back to static config** — not all requests carry TK1 (e.g., trigger-complete from platform)
* **Must work for async phases** — NsfwFillService runs after the request completes, via event handler
* **Should minimize API surface changes** — add optional parameter, don't break existing signatures

## Considered Options

### Option 1: Route pipeline calls through CCR itself

Make pipeline components call `http://localhost:${PORT}/v1/messages` (like ImageAgent does), letting the Router handle token passthrough.

- **Pros**: Reuses existing Token Passthrough, no new parameter threading
- **Cons**: Sanitizer would recurse through its own hook (infinite loop). Fill/Vision use OpenAI format, but CCR expects Anthropic format. Would need separate namespaces or bypass flags. High complexity.

### Option 2: Thread TK1 through function parameters (chosen)

Extract TK1 from the incoming request header. Pass it as an optional `requestApiKey` parameter through the call chain. Store it in `PipelineState` for async phases.

- **Pros**: Minimal changes. Each service decides: use TK1 if available, fall back to config. No routing changes. Works for both sync (sanitizer, vision) and async (fill) phases.
- **Cons**: Parameter threading through multiple functions. `PipelineState` now stores a token (short-lived, LRU-cached).

### Option 3: Global request-scoped context

Use AsyncLocalStorage or similar to make TK1 available globally during request processing.

- **Pros**: No parameter threading
- **Cons**: Doesn't solve the async event handler case (fill runs outside request scope). Adds framework-level complexity.

## Decision

**Option 2: Thread TK1 through function parameters.**

### Token extraction

In the sanitizer hook (`sanitizer/index.ts`), extract the token from the incoming request:

```typescript
const requestApiKey: string | undefined =
  req.headers?.["x-api-key"] || req.headers?.authorization || undefined
```

### Token flow

```
Client request (x-api-key: TK1 BKHW...bQA=)
    │
    ▼
Sanitizer Hook: extract from req.headers → req.pipelineApiKey
    │
    ├── sanitizer.decompose(messages, requestApiKey)
    │   └── sanitizeContent() → header: x-api-key: TK1 || config.apiKey
    │
    ├── store.initSessionIfNeeded(..., requestApiKey)
    │   └── PipelineState.requestApiKey = TK1 (persisted for async phases)
    │
    ├── handleNsfwImages(..., requestApiKey)
    │   └── visionService.describeImages() → header: Authorization: TK1 || Bearer config.apiKey
    │
    └── event: pipeline:reportCaptured
        └── fillService.executeFill(..., state.requestApiKey)
            └── callModel() → header: Authorization: TK1 || Bearer config.apiKey
```

### Header format

Each component sends the token in its native header format:

| Component | TK1 available | TK1 missing (fallback) |
|-----------|--------------|------------------------|
| Sanitizer | `x-api-key: TK1 BKHW...` + `Authorization: TK1 BKHW...` | `x-api-key: config.apiKey` |
| NsfwFill | `Authorization: TK1 BKHW...` | `Authorization: Bearer config.apiKey` |
| NsfwVision | `Authorization: TK1 BKHW...` | `Authorization: Bearer config.apiKey` |

When TK1 is present, the raw token value (including the `TK1` prefix) is sent as-is — matching the Router's Token Passthrough behavior. When absent, the standard `Bearer` prefix is used for OpenAI-compatible endpoints.

### Static config fallback chain

The static API key cascade (used when TK1 is not available):

```
1. Component-specific: Pipeline.sanitizer.apiKey / Pipeline.nsfwAgent.apiKey / Pipeline.nsfwVision.apiKey
2. Shared pipeline key: Pipeline.apiKey
3. Legacy fallback: Switcher.classifierApiKey
4. Default: "" (empty — will fail)
```

Hardcoded default API keys were removed from `NSFW_AGENT_DEFAULTS` to prevent accidental credential exposure.

### Changes

| File | Change |
|------|--------|
| `switcher/types.ts` | Added `requestApiKey?: string` to `PipelineState`. Removed hardcoded API key from `NSFW_AGENT_DEFAULTS`. Added `Pipeline.apiKey` shared fallback in `parsePipelineConfig`. |
| `sanitizer/store.ts` | `initSession` and `initSessionIfNeeded` accept and store `requestApiKey` |
| `sanitizer/index.ts` | Extract TK1 from `req.headers`, pass to `decompose()` and `store.initSessionIfNeeded()`, set `req.pipelineApiKey` |
| `sanitizer/sanitizer.ts` | `sanitizeContent()` accepts `requestApiKey`, uses in headers with fallback |
| `sanitizer/fill.ts` | `executeFill()` and `callModel()` accept `requestApiKey`, uses in Authorization header |
| `sanitizer/vision.ts` | `describeImages()` and `callVisionModel()` accept `requestApiKey`, uses in Authorization header |
| `sanitizer/imageRouting.ts` | `handleNsfwImages()` accepts and forwards `requestApiKey` to vision service |
| `index.ts` | Pass `req.pipelineApiKey` to post-classification hook. Event handler reads `state.requestApiKey` for fill service. |

## Rationale

1. **TK1 is the canonical auth mechanism** for the `smart-agent-api` proxy. All Provider endpoints routed through this proxy expect TK1. Using static keys was a workaround that failed for some endpoints (Venice returned 401).

2. **Storing TK1 in PipelineState** solves the async problem cleanly. The fill phase runs via event handler after the HTTP request completes — it has no access to request headers. The LRU-cached PipelineState already holds per-session data (nsfwSpec, report, projectPath), so adding `requestApiKey` is natural.

3. **Optional parameter with fallback** preserves backward compatibility. Existing deployments with static API keys continue to work. New deployments using TK1 get automatic token propagation.

4. **Removing hardcoded default keys** eliminates a security risk flagged in code review. API keys should come from config or request headers, not source code defaults.

## Consequences

### Positive

- All pipeline components authenticate with the same TK1 token as the Router
- No more 401 errors from endpoints that reject static keys
- Config simplification: `Pipeline.apiKey` or TK1 covers all components — no need for per-component `apiKey`
- Hardcoded credentials removed from source

### Negative

- `PipelineState` now contains a short-lived auth token (mitigated: LRU cache with TTL, token is session-scoped anyway)
- Parameter threading adds one optional param to 7 function signatures
- TK1 format assumption: if the proxy changes auth format, all pipeline components are affected

### Risks

- **Token expiry during long pipeline runs.** If TK1 expires between Phase 1 (SFW generation, ~60s) and Phase 2 (NSFW fill, triggered after completion), the fill call may fail with 401. Mitigation: fill has retry logic (max 2 retries with delay). The platform can re-trigger.
- **Token leakage in logs.** `PipelineState` is logged at debug level. The `requestApiKey` field should NOT be included in log output. Current implementation: `initSession` logs `sessionId`, `classification`, `projectPath` — does not log `requestApiKey`.

## Related Decisions

- ADR-0001: Platform-Orchestrated Pipeline Triggering — established the pipeline architecture
- ADR-0002: Dual-path Image Processing — added NsfwVisionService which also benefits from TK1 passthrough
