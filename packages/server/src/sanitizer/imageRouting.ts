import {
  ImageDetectionResult,
  replaceImagesWithDescriptions,
  stripImages,
} from "../agents/imageDetection"
import { NsfwVisionService } from "./vision"
import { PipelineStore } from "./store"
import { imageAgent } from "../agents/image.agent"

/**
 * SFW path: activate ImageAgent as before.
 *
 * Path A: images only in last message + !forceUseImageAgent
 *   → route to Router.image, extract tool_result images, no agent activation
 * Path B: images in earlier messages or forceUseImageAgent
 *   → call reqHandler, inject analyzeImage tool, set req.agents
 */
export function activateImageAgentForSfw(
  req: any,
  config: any,
  detection: ImageDetectionResult
): void {
  if (!config.Router?.image || req.body.model === config.Router.image) return

  if (detection.imagesOnlyInLastMessage && !config.forceUseImageAgent) {
    // Path A: route entire request to multimodal model (no agent)
    req.body = { ...req.body, model: config.Router.image }

    // Extract images from tool_result blocks in last message and promote to top level
    // (replicates ImageAgent.shouldHandle lines 74-87)
    const lastMessage = req.body.messages[req.body.messages.length - 1]
    if (lastMessage?.role === "user" && Array.isArray(lastMessage.content)) {
      const extracted: any[] = []
      const newContent = lastMessage.content.map((item: any) => {
        if (item.type === "tool_result" && Array.isArray(item.content)) {
          const images = item.content.filter((el: any) => el.type === "image")
          const rest = item.content.filter((el: any) => el.type !== "image")
          if (images.length > 0) {
            extracted.push(...images)
            return {
              ...item,
              content: rest.length > 0 ? rest : "read image successfully",
            }
          }
        }
        return item
      })

      req.body = {
        ...req.body,
        messages: [
          ...req.body.messages.slice(0, -1),
          { ...lastMessage, content: [...newContent, ...extracted] },
        ],
      }
    }

    return
  }

  // Path B: activate ImageAgent (images in earlier messages)
  // NOTE: imageAgent.reqHandler mutates messages in-place (legacy behavior, image.agent.ts not modified)
  imageAgent.reqHandler(req, config)

  if (imageAgent.tools.size) {
    if (!req.body?.tools?.length) {
      req.body = { ...req.body, tools: [] }
    }
    req.body = {
      ...req.body,
      tools: [
        ...Array.from(imageAgent.tools.values()).map((item) => ({
          name: item.name,
          description: item.description,
          input_schema: item.input_schema,
        })),
        ...req.body.tools,
      ],
    }
  }

  req.agents = req.agents ? [...req.agents, "image"] : ["image"]
}

/**
 * NSFW path: describe images via uncensored vision model, inject descriptions,
 * and strip image blocks. Does NOT set req.agents so pipeline report extraction works.
 */
export async function handleNsfwImages(
  req: any,
  detection: ImageDetectionResult,
  visionService: NsfwVisionService | null,
  store: PipelineStore | null,
  logger: any,
  requestApiKey?: string
): Promise<void> {
  if (visionService?.isAvailable) {
    const contextHint = req.sanitizerResult?.nsfwSpec?.context || "image analysis"
    const descriptions = await visionService.describeImages(
      detection.images,
      contextHint,
      requestApiKey
    )

    if (descriptions.length > 0) {
      // Vision succeeded: attach descriptions to nsfwSpec and replace images with text
      if (req.sanitizerResult?.nsfwSpec) {
        req.sanitizerResult = {
          ...req.sanitizerResult,
          nsfwSpec: {
            ...req.sanitizerResult.nsfwSpec,
            imageDescriptions: descriptions,
          },
        }
      }

      req.body = {
        ...req.body,
        messages: replaceImagesWithDescriptions(req.body.messages, descriptions),
      }

      if (store && req.sessionId && req.sanitizerResult?.nsfwSpec) {
        store.updateNsfwSpec(req.sessionId, req.sanitizerResult.nsfwSpec)
      }

      logger.info(
        {
          sessionId: req.sessionId,
          imageCount: detection.images.length,
          descriptionsCount: descriptions.length,
        },
        "Pipeline: NSFW images described and replaced with text"
      )
    } else {
      // Vision failed (API error, timeout, etc.): keep images in messages so the SFW model
      // (Opus, multimodal) can still see them in Phase 1. Only Phase 2 (MiniMax, text-only)
      // will lack image context — acceptable degradation vs losing images for both phases.
      logger.warn(
        {
          sessionId: req.sessionId,
          imageCount: detection.images.length,
        },
        "Pipeline: vision failed, keeping images for SFW model (Phase 1) — Phase 2 will lack image context"
      )
    }
  } else {
    // No vision model configured: strip images entirely
    logger.warn(
      { sessionId: req.sessionId, imageCount: detection.images.length },
      "Pipeline: NSFW request contains images but no vision model configured, stripping images"
    )
    req.body = {
      ...req.body,
      messages: stripImages(req.body.messages),
    }
  }
}
