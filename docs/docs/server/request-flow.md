# Request Flow: Cách CCR Hoạt Động

Tài liệu này giải thích chi tiết luồng xử lý request khi bạn chạy `claude -p "Hi"` thông qua Claude Code Router (CCR).

## Tổng Quan

CCR là một **proxy server chạy local**, đứng giữa **Claude CLI** và các **LLM provider**. Nó chặn các API request của Claude, định tuyến chúng tới các model/provider khác nhau dựa trên cấu hình, chuyển đổi format request, và stream response trở lại.

```
┌──────────┐    POST /v1/messages    ┌──────────────┐   Request đã     ┌──────────────┐
│          │ ──────────────────────► │              │  chuyển đổi ──►  │              │
│ Claude   │   (localhost:3456)      │  CCR Server  │                  │ LLM Provider │
│ CLI      │                         │  (Fastify)   │                  │ (OpenAI,     │
│          │ ◄────────────────────── │              │ ◄──────────────  │  Gemini, etc)│
└──────────┘    SSE Stream           └──────────────┘  SSE Stream      └──────────────┘
                                            │
                                     ┌──────┴──────┐
                                     │  Config     │
                                     │  Router     │
                                     │  Agents     │
                                     │  Sanitizer  │
                                     └─────────────┘
```

## Luồng Xử Lý Từng Bước

### Bước 1: Khởi Động CLI

Khi bạn chạy `ccr code` (hoặc `ccr start` + `claude`):

**File:** `packages/cli/src/cli.ts`

1. CLI kiểm tra xem CCR service đã chạy chưa
2. Nếu chưa, spawn một **background process** chạy server
3. Đợi server sẵn sàng (health check với timeout)
4. Tạo các biến môi trường trỏ Claude tới proxy local
5. Spawn tiến trình `claude` với các biến môi trường đó

### Bước 2: Inject Biến Môi Trường

**File:** `packages/cli/src/utils/createEnvVariables.ts`

CCR thiết lập các biến môi trường trước khi khởi chạy Claude:

| Biến | Giá trị | Mục đích |
|------|---------|----------|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:3456` | Chuyển hướng API call của Claude sang server local |
| `ANTHROPIC_AUTH_TOKEN` | APIKEY từ config hoặc `"test"` | Token xác thực cho proxy |
| `NO_PROXY` | `127.0.0.1` | Bypass system proxy cho traffic local |
| `DISABLE_TELEMETRY` | `true` | Tắt telemetry |
| `API_TIMEOUT_MS` | Giá trị config hoặc `600000` | Timeout cho request |

> Bạn cũng có thể dùng `eval $(ccr activate)` để thiết lập thủ công trong shell.

### Bước 3: Claude Gửi Request

Claude CLI tưởng rằng nó đang nói chuyện với `api.anthropic.com`, nhưng base URL đã bị đổi sang `localhost:3456`. Nó gửi một request chuẩn Anthropic API:

```
POST http://127.0.0.1:3456/v1/messages
Content-Type: application/json
x-api-key: <token>
anthropic-version: 2023-06-01

{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 8096,
  "stream": true,
  "system": [{ "type": "text", "text": "You are Claude Code..." }],
  "messages": [
    { "role": "user", "content": "Hi" }
  ],
  "metadata": { "user_id": "prefix_session_abc123" },
  "tools": [...]
}
```

### Bước 4: Server Nhận Request

**File:** `packages/server/src/index.ts`

Fastify server nhận request và chạy một chuỗi **preHandler hooks** tuần tự:

---

#### Hook 1: Xác Thực (Authentication)

**File:** `packages/server/src/middleware/auth.ts`

- Nếu `Providers` được cấu hình với `APIKEY` → xác thực header `x-api-key`
- Nếu không có provider nào → chấp nhận tất cả request (chế độ mở)
- Các endpoint công khai (`/`, `/health`, `/ui`) bỏ qua xác thực

#### Hook 2: Trích Xuất Preset & Pathname

- Nếu URL khớp `/preset/<name>/v1/messages` → gán `req.preset` cho routing theo preset
- Chuẩn hóa pathname

#### Hook 3: Trích Xuất Session ID

- Parse `metadata.user_id` từ request body
- Trích xuất session ID (dùng cho routing theo project và theo dõi usage)
- Hỗ trợ hai format:
  - JSON: `{ "session_id": "abc123" }`
  - Legacy: `prefix_session_abc123`

#### Hook 4: Loại Bỏ Thinking Blocks

- Xóa các `thinking` content block từ **các message assistant trước đó**
- Ngăn lỗi xác minh chữ ký khi chuyển tiếp tới provider không phải Anthropic

#### Hook 5: Phát Hiện Hình Ảnh

**File:** `packages/server/src/agents/imageDetection.ts`

- Quét tất cả message tìm các `image` content block
- Lưu metadata vào `req.detectedImages` (vị trí, index)
- **Chưa kích hoạt ImageAgent** — chỉ phát hiện thôi

#### Hook 6: Phân Loại Nội Dung (Sanitizer)

**File:** `packages/server/src/sanitizer/index.ts`

Chỉ chạy nếu `Pipeline` được cấu hình:

- Trích xuất text từ tất cả message
- Gửi tới LLM phân loại (thường là Claude Haiku)
- Trả về phân loại: `sfw`, `nsfw`, hoặc `mixed`
- Với NSFW: phân tách nội dung thành placeholder an toàn + NSFW spec
- Kết quả được cache qua LRU cache
- Gán `req.sanitizerResult`

> Với message đơn giản `"Hi"`, nó được phân loại là `sfw` và luồng tiếp tục bình thường.

#### Hook 7: Định Tuyến Hình Ảnh Sau Phân Loại

**File:** `packages/server/src/sanitizer/imageRouting.ts`

Dựa trên kết quả phân loại:

- **SFW + có hình ảnh** → Kích hoạt ImageAgent (inject tool `analyzeImage`)
- **NSFW + có hình ảnh** → Mô tả qua uncensored vision model, hoặc loại bỏ hình ảnh
- **Không có hình ảnh** → Bỏ qua (đây là trường hợp `"Hi"` của chúng ta)

#### Hook 8: Phát Hiện Agent (Không Phải Image)

**File:** `packages/server/src/agents/index.ts`

- Duyệt qua tất cả agent đã đăng ký (trừ ImageAgent)
- Mỗi agent gọi `shouldHandle()` để quyết định có xử lý không
- Nếu có: `reqHandler()` sửa đổi request, tool của agent được inject
- Với `"Hi"`: không có agent nào kích hoạt

---

### Bước 5: Định Tuyến Model/Provider

**File:** Logic routing trong `@musistudio/llms` (cấu hình qua `packages/server/src/index.ts`)

Router xác định **provider và model nào** sẽ được sử dụng:

```
Đếm Token (tiktoken cl100k_base)
       │
       ▼
┌─ tokens > longContextThreshold (60k)? ──► Router.longContext
│
├─ Có tag <CCR-SUBAGENT-MODEL>?          ──► Dùng model chỉ định
│
├─ Là biến thể Claude Haiku?             ──► Router.background
│
├─ Có web_search tools?                  ──► Router.webSearch
│
├─ Có thinking block?                    ──► Router.think
│
└─ Mặc định                              ──► Router.default
```

Mỗi route có thể có biến thể SFW/NSFW:
```json
{
  "default": { "sfw": "openai,gpt-4o", "nsfw": "provider,uncensored-model" }
}
```

**Override theo project:** Nếu tồn tại file `~/.claude/projects/<project-id>/claude-code-router.json`, cấu hình Router trong đó sẽ được ưu tiên.

Với ví dụ `"Hi"` của chúng ta (~100 tokens) → sử dụng model `Router.default`.

### Bước 6: Chuyển Đổi Request (Transformation)

**Transformer pipeline** chuyển đổi request từ format Anthropic sang format của provider đích:

```
Format Anthropic ──► [Chuỗi Transformer] ──► Format riêng của Provider
```

Mỗi provider có một transformer (ví dụ: `anthropic`, `openai`, `gemini`, `deepseek`, `openrouter`):

- **Chuyển đổi Auth**: Đổi `x-api-key` thành `Bearer` token, hoặc header riêng của provider
- **Chuyển đổi Body**: Điều chỉnh format message, xử lý system prompt, schema tools
- **Chuyển đổi Feature**: Xử lý giới hạn `maxtoken`, `reasoning` tokens, tương thích `enhancetool`

Transformer có thể áp dụng toàn cục (tất cả model từ một provider) hoặc theo từng model.

### Bước 7: Chuyển Tiếp Tới Provider

Server gửi HTTP request tới endpoint của provider với body đã chuyển đổi. Ví dụ:

- Anthropic: `POST https://api.anthropic.com/v1/messages`
- OpenAI: `POST https://api.openai.com/v1/chat/completions`
- Gemini: `POST https://generativelanguage.googleapis.com/v1beta/...`

### Bước 8: Xử Lý SSE Stream

**Files:**
- `packages/server/src/utils/SSEParser.transform.ts`
- `packages/server/src/utils/SSESerializer.transform.ts`
- `packages/server/src/utils/rewriteStream.ts`

Provider trả về một Server-Sent Events (SSE) stream. **onSend hook** xử lý nó:

#### Đường Đi Chuẩn (không có agent — trường hợp "Hi" của chúng ta):

```
SSE Stream từ Provider
       │
       ▼
  [Response Transformer]  ← Chuyển format provider về format Anthropic
       │
       ▼
  [Usage Caching]         ← Trích xuất token usage từ event message_delta
       │
       ▼
  Stream tới Claude CLI
```

#### Đường Đi Agent (khi có agent hoạt động):

```
SSE Stream từ Provider
       │
       ▼
  [SSEParserTransform]    ← Parse SSE text → event objects
       │
       ▼
  [rewriteStream]         ← Chặn các event tool_use
       │                     ├─ Tích lũy tool input JSON
       │                     ├─ Thực thi tool handler của agent
       │                     ├─ Gọi đệ quy POST /v1/messages với tool_result
       │                     └─ Stream response mới
       │
       ▼
  [SSESerializerTransform] ← Event objects → SSE text
       │
       ▼
  Stream tới Claude CLI
```

### Bước 9: Response Đến Claude CLI

Claude CLI nhận SSE stream ở format chuẩn Anthropic:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","model":"claude-sonnet-4-20250514",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"! How can"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" I help you?"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}

event: message_stop
data: {"type":"message_stop"}
```

Claude CLI hiển thị: **"Hello! How can I help you?"**

> Claude CLI không hề biết response đến từ provider khác. Trường model trong response vẫn hiển thị tên model Anthropic gốc.

## Sơ Đồ Luồng Tổng Thể

```
  User: claude -p "Hi"
         │
         ▼
  ┌─────────────────┐
  │  CCR CLI        │  1. Khởi động server nếu cần
  │  (ccr code)     │  2. Set ANTHROPIC_BASE_URL=localhost:3456
  │                 │  3. Spawn tiến trình claude
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  Claude CLI     │  Gửi POST /v1/messages
  │                 │  tới localhost:3456
  └────────┬────────┘
           │
           ▼
  ┌─────────────────────────────────────────────────────┐
  │  CCR Server (Fastify)                               │
  │                                                     │
  │  preHandler Hooks:                                  │
  │  ┌───────────┐  ┌────────┐  ┌─────────┐           │
  │  │ Xác thực  │→│ Preset │→│ Session │            │
  │  └───────────┘  └────────┘  └─────────┘           │
  │       │                                             │
  │  ┌────┴──────┐  ┌───────────┐  ┌───────────┐      │
  │  │ Loại bỏ   │→│ Phát hiện │→│ Phân loại │       │
  │  │ Thinking  │  │ hình ảnh  │  │ nội dung  │       │
  │  └───────────┘  └───────────┘  └───────────┘      │
  │       │                                             │
  │  ┌────┴──────────┐  ┌────────────┐                 │
  │  │ Định tuyến    │→│ Phát hiện │                  │
  │  │ hình ảnh      │  │  Agent    │                  │
  │  └───────────────┘  └────────────┘                 │
  │                                                     │
  │  Router: chọn provider + model                      │
  │  Transformer: chuyển đổi format request             │
  └────────┬────────────────────────────────────────────┘
           │
           ▼
  ┌─────────────────┐
  │  LLM Provider   │  VD: OpenAI, Gemini, DeepSeek
  │  API            │  Trả về SSE stream
  └────────┬────────┘
           │
           ▼
  ┌─────────────────────────────────────────────────────┐
  │  onSend Hook                                        │
  │                                                     │
  │  Chuyển đổi response về format Anthropic            │
  │  Xử lý agent tool call (nếu có)                    │
  │  Cache thống kê usage                               │
  └────────┬────────────────────────────────────────────┘
           │
           ▼
  ┌─────────────────┐
  │  Claude CLI     │  Nhận SSE format Anthropic
  │                 │  Hiển thị: "Hello! How can I help you?"
  └─────────────────┘
```

## Bảng Tham Chiếu File Quan Trọng

| Thành phần | File | Mô tả |
|------------|------|-------|
| CLI Entry | `packages/cli/src/cli.ts` | Điểm vào CLI chính |
| Spawn Claude | `packages/cli/src/utils/codeCommand.ts` | Khởi chạy claude với env vars |
| Biến môi trường | `packages/cli/src/utils/createEnvVariables.ts` | Tạo các biến môi trường proxy |
| Server Setup | `packages/server/src/index.ts` | Fastify server + tất cả hooks |
| Xác thực | `packages/server/src/middleware/auth.ts` | Kiểm tra API key |
| Phát hiện ảnh | `packages/server/src/agents/imageDetection.ts` | Quét tìm image block |
| Image Agent | `packages/server/src/agents/image.agent.ts` | Tool phân tích hình ảnh |
| Quản lý Agent | `packages/server/src/agents/index.ts` | Registry của agent |
| Sanitizer | `packages/server/src/sanitizer/index.ts` | Phân loại nội dung |
| Định tuyến ảnh | `packages/server/src/sanitizer/imageRouting.ts` | Xử lý ảnh SFW/NSFW |
| SSE Parser | `packages/server/src/utils/SSEParser.transform.ts` | Parse SSE stream |
| SSE Serializer | `packages/server/src/utils/SSESerializer.transform.ts` | Serialize SSE stream |
| Rewrite Stream | `packages/server/src/utils/rewriteStream.ts` | Chặn/sửa đổi stream |
| Response Accumulator | `packages/server/src/utils/ResponseAccumulator.ts` | Ghép response hoàn chỉnh |
| Đọc Config | `packages/server/src/utils/index.ts` | Đọc & parse config.json |
| Type Definitions | `packages/server/src/types.d.ts` | Kiểu dữ liệu @musistudio/llms |
