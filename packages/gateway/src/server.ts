import Fastify, { FastifyInstance } from "fastify";
import { convertOpenAIToAnthropic } from "./convert/request";
import { convertAnthropicToOpenAI } from "./convert/response";
import { convertAnthropicStreamToOpenAI } from "./convert/stream";

export interface GatewayConfig {
  port: number;
  ccrUrl: string;
  logLevel: string;
}

export async function createGateway(config: GatewayConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Models endpoint (static)
  app.get("/v1/models", async () => ({
    object: "list",
    data: [
      { id: "claude-opus-4-6", object: "model", created: 0, owned_by: "ccr-gateway" },
      { id: "claude-sonnet-4-6", object: "model", created: 0, owned_by: "ccr-gateway" },
    ],
  }));

  // Main route: OpenAI chat completions
  app.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as any;
    const isStream = body.stream === true;
    const requestModel = body.model;

    // Extract Bearer token
    const authHeader = req.headers.authorization || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

    // Convert OpenAI → Anthropic
    const anthropicBody = convertOpenAIToAnthropic(body);

    // Forward to CCR
    const ccrHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    if (bearerToken) {
      ccrHeaders["x-api-key"] = bearerToken;
    }

    const ccrResponse = await fetch(`${config.ccrUrl}/v1/messages`, {
      method: "POST",
      headers: ccrHeaders,
      body: JSON.stringify(anthropicBody),
    });

    if (!ccrResponse.ok) {
      const errorText = await ccrResponse.text();
      req.log.error(`CCR error (${ccrResponse.status}): ${errorText}`);
      reply.status(ccrResponse.status);
      // Forward the error as-is from CCR/provider
      try {
        return JSON.parse(errorText);
      } catch {
        return {
          error: {
            message: errorText,
            type: "api_error",
            code: "ccr_error",
          },
        };
      }
    }

    if (!isStream) {
      // Non-streaming: parse and convert
      const anthropicResponse = await ccrResponse.json();
      const openaiResponse = convertAnthropicToOpenAI(anthropicResponse as any, requestModel);
      return openaiResponse;
    }

    // Streaming: convert SSE stream
    if (!ccrResponse.body) {
      reply.status(500);
      return { error: { message: "No response body from CCR", type: "api_error" } };
    }

    const openaiStream = convertAnthropicStreamToOpenAI(
      ccrResponse.body as any,
      requestModel
    );

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const reader = openaiStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(value);
      }
    } catch (err) {
      req.log.error(err, "Stream error");
    } finally {
      reply.raw.end();
    }

    // Return nothing — we already sent the response via raw
    return reply;
  });

  return app;
}
