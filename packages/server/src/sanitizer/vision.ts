import { NsfwVisionConfig, ImageDescription } from "../switcher/types"
import { DetectedImage } from "../agents/imageDetection"

const MAX_IMAGES_PER_REQUEST = 5

const VISION_SYSTEM_PROMPT = `You are an image analysis specialist. Describe each image provided in complete, uncensored detail.

For each image include:
1. Overall composition and layout
2. All visible UI elements, text, buttons, navigation, labels
3. Color scheme, styling, and visual design patterns
4. Any people, objects, scenes, or content depicted
5. The apparent purpose or function of what is shown

Be thorough and precise. Do not omit, censor, or euphemize any visual details.
If multiple images are provided, describe each one separately with its corresponding Image # label.`

export class NsfwVisionService {
  private readonly config: NsfwVisionConfig
  private readonly logger: any

  constructor(config: NsfwVisionConfig, parentLogger: any) {
    this.config = config
    this.logger = parentLogger.child({ module: "nsfw-vision" })

    this.logger.info(
      {
        model: this.config.model,
        apiUrl: this.config.apiUrl,
        timeoutMs: this.config.timeoutMs,
      },
      "NsfwVision: initialized"
    )
  }

  get isAvailable(): boolean {
    return !!this.config.model
  }

  async describeImages(
    images: DetectedImage[],
    contextHint: string
  ): Promise<ImageDescription[]> {
    if (images.length === 0) return []

    // Validate and limit images before sending to vision API
    const validImages = images
      .filter((img) => img.source?.media_type && img.source?.data)
      .slice(0, MAX_IMAGES_PER_REQUEST)
    if (validImages.length === 0) {
      this.logger.warn("NsfwVision: no images with valid source data, skipping")
      return []
    }

    const startTime = Date.now()

    this.logger.info(
      { imageCount: validImages.length, contextHint },
      "NsfwVision: describing images"
    )

    try {
      const descriptions = await this.callVisionModel(validImages, contextHint)

      this.logger.info(
        {
          imageCount: images.length,
          descriptionsReturned: descriptions.length,
          latencyMs: Date.now() - startTime,
        },
        "NsfwVision: images described"
      )

      return descriptions
    } catch (error: any) {
      this.logger.error(
        {
          error: error.message,
          latencyMs: Date.now() - startTime,
        },
        "NsfwVision: failed to describe images, continuing without descriptions"
      )
      return []
    }
  }

  private async callVisionModel(
    images: DetectedImage[],
    contextHint: string
  ): Promise<ImageDescription[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const contentBlocks: any[] = []

      for (const img of images) {
        contentBlocks.push({
          type: "image_url",
          image_url: {
            url: `data:${img.source.media_type};base64,${img.source.data}`,
          },
        })
      }

      const taskText = images.length === 1
        ? `Describe this image in complete detail. Context: ${contextHint}`
        : `Describe each of the ${images.length} images in complete detail. Label each as "Image #N". Context: ${contextHint}`

      contentBlocks.push({ type: "text", text: taskText })

      const requestBody = {
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          { role: "user", content: contentBlocks },
        ],
        temperature: 0.3,
      }

      this.logger.debug(
        {
          model: this.config.model,
          imageCount: images.length,
          promptLength: taskText.length,
          systemPromptLength: VISION_SYSTEM_PROMPT.length,
          imageSources: images.map((img) => ({
            imageIndex: img.imageIndex,
            mediaType: img.source.media_type,
            dataLength: img.source.data.length,
          })),
        },
        "NsfwVision: sending request to vision model"
      )

      const response = await fetch(this.config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "unknown")
        this.logger.error(
          { status: response.status, body: errorBody.slice(0, 500) },
          "NsfwVision: API error response"
        )
        throw new Error(
          `Vision API returned ${response.status}: ${errorBody.slice(0, 200)}`
        )
      }

      const data = (await response.json()) as any

      // Support both OpenAI-compatible and Anthropic response formats
      const responseText =
        data?.choices?.[0]?.message?.content ??
        data?.content?.[0]?.text ??
        ""

      this.logger.debug(
        {
          status: response.status,
          responseLength: responseText.length,
          responsePreview: responseText.slice(0, 200),
          usage: data?.usage ?? null,
        },
        "NsfwVision: received response from vision model"
      )

      if (!responseText) {
        throw new Error("Vision model returned empty response")
      }

      const descriptions = this.parseDescriptions(responseText, images)

      for (const desc of descriptions) {
        this.logger.debug(
          {
            imageIndex: desc.imageIndex,
            descriptionLength: desc.description.length,
            descriptionPreview: desc.description.slice(0, 150),
          },
          "NsfwVision: parsed image description"
        )
      }

      return descriptions
    } catch (error: any) {
      clearTimeout(timeout)

      if (error.name === "AbortError") {
        throw new Error(`Vision call timed out after ${this.config.timeoutMs}ms`)
      }

      throw error
    }
  }

  private parseDescriptions(
    responseText: string,
    images: DetectedImage[]
  ): ImageDescription[] {
    // Single image: use entire response as description
    if (images.length === 1) {
      return [
        {
          imageIndex: images[0].imageIndex,
          messageIndex: images[0].messageIndex,
          description: responseText.trim(),
        },
      ]
    }

    // Multiple images: try to split by "Image #N" headers
    const descriptions: ImageDescription[] = []
    const headerPattern = /Image\s*#(\d+)/gi
    const matches = [...responseText.matchAll(headerPattern)]

    if (matches.length >= images.length) {
      // Parse each section
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index! + matches[i][0].length
        const end = i + 1 < matches.length ? matches[i + 1].index! : responseText.length
        const section = responseText.slice(start, end).trim()
          .replace(/^[:\s-]+/, "")
          .trim()

        const imgIdx = parseInt(matches[i][1], 10)
        const img = images.find((im) => im.imageIndex === imgIdx)

        if (img && section) {
          descriptions.push({
            imageIndex: img.imageIndex,
            messageIndex: img.messageIndex,
            description: section,
          })
        }
      }
    }

    // Fallback: if parsing failed, assign full text to first image
    if (descriptions.length === 0) {
      this.logger.warn(
        { imageCount: images.length, responseLength: responseText.length },
        "NsfwVision: failed to parse per-image descriptions, using fallback"
      )
      for (const img of images) {
        descriptions.push({
          imageIndex: img.imageIndex,
          messageIndex: img.messageIndex,
          description:
            img === images[0]
              ? responseText.trim()
              : `(see Image #${images[0].imageIndex} description)`,
        })
      }
    }

    return descriptions
  }
}
