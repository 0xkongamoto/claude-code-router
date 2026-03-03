Patch `enhanced-client.js` with a simple conditional:
- If `config.api_key != ''` → use `api_key` from `config.json` (normal behavior, for official providers)
- If `config.api_key == ''` → read the client's **`x-api-key`** header (which Claude Code sends `ANTHROPIC_API_KEY` through) and forward it as `Authorization: Bearer <user_token>` to the LLM gateway

**Patch to `providers/openai/enhanced-client.js`:**

```diff
  // Add request interceptor for authentication
  this.httpClient.interceptors.request.use((config) => {
-     if (this.apiKey) {
-         config.headers['Authorization'] = `Bearer ${this.apiKey}`;
-     }
+     if (this.apiKey) {
+         // api_key is set → use it (normal case: official provider)
+         config.headers['Authorization'] = `Bearer ${this.apiKey}`;
+     } else if (this._clientXApiKey) {
+         // api_key is empty → passthrough: Claude Code sends tk1 via x-api-key header
+         // Forward as Authorization: Bearer <user_token> to our LLM gateway
+         config.headers['Authorization'] = `Bearer ${this._clientXApiKey}`;
+     }
      return config;
  });
```

Also patch `server.js` to capture the incoming `x-api-key` header before calling the provider:

```diff
  // Step 3: Send to provider
+ // Capture x-api-key from Claude Code so provider can forward tk1 token when api_key is empty
+ provider._clientXApiKey = request.headers['x-api-key'] || '';
  providerResponse = await provider.sendRequest(baseRequest);
```

**`~/.claude-code-router/config.json` — set `api_key` to `""` for the LLM gateway:**

```json
{
  "Providers": [
    {
      "name": "my-gateway",
      "api_base_url": "https://my-llm-gateway.example.com/v1/chat/completions",
      "api_key": "",
      "models": ["grok-4", "grok-4-fast"]
    }
  ],
  "Router": {
    "default": "my-gateway,grok-4"
  }
}
```

**Full flow with this patch:**

```
Claude Code spawned with ANTHROPIC_API_KEY=user_token
         ↓
Claude CLI  →  x-api-key: user_token  (Claude Code always uses this header)
               ↓
           Router receives request
           provider._clientXApiKey = request.headers['x-api-key']  → "user_token"
               ↓
           api_key == "" → use _clientXApiKey
               ↓
LLM Gateway ←  Authorization: Bearer user_token  ✅
```

**Pros:** Minimal patch (~10 lines), retains full router ecosystem (routing, transformers, model mapping), no new service needed
**Cons:** Requires patching the installed package (or maintaining a fork); patch must be reapplied after upgrades

---

### Option C: Encode tk1 token in provider `api_key` in config.json

Set `api_key` in config.json to the tk1 token.

**Problem:** `config.json` is a static file — cannot be set per-user dynamically.
**Not viable** for multi-user scenarios.