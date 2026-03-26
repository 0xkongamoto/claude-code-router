import { FastifyRequest, FastifyReply } from "fastify";

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  type?: string;
}

export function createApiError(
  message: string,
  statusCode: number = 500,
  code: string = "internal_error",
  type: string = "api_error"
): ApiError {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code;
  error.type = type;
  return error;
}

export async function errorHandler(
  error: ApiError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  request.log.error(error);

  const statusCode = error.statusCode || 500;

  // If we have a raw provider error, forward it as-is
  if ((error as any).rawProviderError) {
    const raw = (error as any).rawProviderError;
    try {
      const parsed = JSON.parse(raw);
      return reply.code(statusCode).send(parsed);
    } catch {
      // If not valid JSON, wrap minimally
      return reply.code(statusCode).send({
        error: {
          message: raw,
          type: "api_error",
          code: "provider_response_error",
        },
      });
    }
  }

  const response = {
    error: {
      message: error.message || "Internal Server Error",
      type: error.type || "api_error",
      code: error.code || "internal_error",
    },
  };

  return reply.code(statusCode).send(response);
}
