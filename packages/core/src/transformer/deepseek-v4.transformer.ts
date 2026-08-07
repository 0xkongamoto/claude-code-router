import { UnifiedChatRequest } from "@/types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";

/**
 * DeepSeek V4 request adapter.
 *
 * The base `deepseek` transformer caps max_tokens and converts
 * reasoning_content on the response stream, but does nothing on the request
 * side. This transformer fills the request-side gaps:
 *
 * - reasoning-effort passthrough: DeepSeek reads a top-level `reasoning_effort`
 *   field. The unified request's `reasoning.effort` never reaches the wire
 *   (the Anthropic outbound transformer rebuilds the request from a fixed
 *   field list and drops it), so we copy it to the top level here.
 * - NOTHINK_BELOW: below a max_tokens threshold DeepSeek refuses the request
 *   or burns budget on thinking. We disable thinking entirely below the
 *   threshold instead of capping max_tokens (which truncates user intent).
 *   Disabling thinking also suppresses the effort passthrough, so the wire
 *   never carries both a reasoning effort and thinking disabled.
 * - placeholder thinking: on routes that drop thinking blocks (e.g. direct
 *   DeepSeek), outbound assistant messages may need a placeholder thinking
 *   block so Claude Code's message history stays well-formed. Only applied
 *   when thinking stays enabled, mirroring cc-ds4.
 */
export class DeepseekV4Transformer implements Transformer {
  static TransformerName = "deepseek-v4";

  private nothinkBelow: number;
  private thinkingPlaceholder: boolean;
  private placeholder: { content: string; signature: string };

  constructor(private readonly options?: TransformerOptions) {
    this.nothinkBelow = this.options?.nothinkBelow ?? 8192;
    this.thinkingPlaceholder = this.options?.thinkingPlaceholder ?? false;
    this.placeholder = this.options?.placeholder ?? {
      content: "(elided)",
      signature: "ccr-deepseek-v4",
    };
  }

  async transformRequestIn(
    request: UnifiedChatRequest
  ): Promise<UnifiedChatRequest> {
    const reasoning = request.reasoning;
    const want = request.max_tokens;

    // NOTHINK_BELOW. Missing max_tokens counts as below-threshold: without a
    // budget there is no room for thinking, and DeepSeek refuses or burns
    // budget otherwise. Disabling thinking also suppresses reasoning effort so
    // the wire never carries a contradictory reasoning_effort + thinking
    // disabled pair.
    const disableThinking =
      typeof want !== "number" || want <= this.nothinkBelow;

    // Reasoning-effort passthrough. DeepSeek reads a top-level reasoning_effort.
    // Set it from the unified field that transformRequestOut populated from the
    // Anthropic thinking budget. It reaches the wire because sendUnifiedRequest
    // serializes the whole request object. Skipped when thinking is disabled.
    if (
      reasoning?.effort &&
      reasoning.enabled !== false &&
      !disableThinking &&
      !(request as any).reasoning_effort
    ) {
      (request as any).reasoning_effort = reasoning.effort;
    }

    if (disableThinking) {
      (request as any).thinking = { type: "disabled" };
      (request as any).enable_thinking = false;
    }

    // Placeholder thinking injection. Only meaningful while thinking is on;
    // a disabled-thinking request does not need a well-formed thinking history.
    if (
      this.thinkingPlaceholder &&
      !disableThinking &&
      Array.isArray(request.messages)
    ) {
      for (const msg of request.messages) {
        if (
          msg.role === "assistant" &&
          Array.isArray(msg.content) &&
          !msg.thinking
        ) {
          const hasThinkingPart = msg.content.some(
            (c: any) => c?.type === "thinking"
          );
          if (!hasThinkingPart) {
            msg.thinking = { ...this.placeholder };
          }
        }
      }
    }

    return request;
  }
}
