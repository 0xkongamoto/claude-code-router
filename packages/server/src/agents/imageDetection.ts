import { ImageDescription } from "../switcher/types"

export interface ImageSource {
  type: string
  media_type: string
  data: string
}

export interface DetectedImage {
  imageIndex: number
  messageIndex: number
  blockIndex: number
  source: ImageSource
  isToolResult: boolean
}

export interface ImageDetectionResult {
  hasImages: boolean
  images: DetectedImage[]
  imagesOnlyInLastMessage: boolean
}

function isImageBlock(block: any): boolean {
  return (
    block.type === "image" ||
    (Array.isArray(block?.content) &&
      block.content.some((sub: any) => sub.type === "image"))
  )
}

/**
 * Scan messages for image content blocks without modifying them.
 * Returns detection metadata for downstream processing.
 */
export function detectImages(messages: any[]): ImageDetectionResult {
  const images: DetectedImage[] = []
  let imgCounter = 1
  let hasImagesInEarlier = false
  const lastIndex = messages.length - 1

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]

      if (block.type === "image") {
        images.push({
          imageIndex: imgCounter++,
          messageIndex: mi,
          blockIndex: bi,
          source: block.source,
          isToolResult: false,
        })
        if (mi < lastIndex) hasImagesInEarlier = true
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const sub of block.content) {
          if (sub.type === "image") {
            images.push({
              imageIndex: imgCounter++,
              messageIndex: mi,
              blockIndex: bi,
              source: sub.source,
              isToolResult: true,
            })
            if (mi < lastIndex) hasImagesInEarlier = true
          }
        }
      }
    }
  }

  return {
    hasImages: images.length > 0,
    images,
    imagesOnlyInLastMessage: images.length > 0 && !hasImagesInEarlier,
  }
}

/**
 * Replace image blocks with text descriptions (immutable).
 * Returns a new messages array.
 */
export function replaceImagesWithDescriptions(
  messages: any[],
  descriptions: ImageDescription[]
): any[] {
  const descByIndex = new Map(descriptions.map((d) => [d.imageIndex, d]))
  let imgCounter = 1

  return messages.map((msg, mi) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    let hasChange = false
    const newContent = msg.content.map((block: any, bi: number) => {
      if (block.type === "image") {
        const idx = imgCounter++
        const desc = descByIndex.get(idx)
        hasChange = true
        return {
          type: "text",
          text: desc
            ? `[Image #${idx}: ${desc.description}]`
            : `[Image #${idx}]`,
        }
      }

      if (block.type === "tool_result" && Array.isArray(block.content)) {
        let blockChanged = false
        const newSub = block.content.map((sub: any) => {
          if (sub.type === "image") {
            const idx = imgCounter++
            const desc = descByIndex.get(idx)
            hasChange = true
            blockChanged = true
            return {
              type: "text",
              text: desc
                ? `[Image #${idx}: ${desc.description}]`
                : `[Image #${idx}]`,
            }
          }
          return sub
        })
        return blockChanged ? { ...block, content: newSub } : block
      }

      return block
    })

    return hasChange ? { ...msg, content: newContent } : msg
  })
}

/**
 * Remove all image blocks from messages (immutable).
 * Fallback for NSFW requests when no vision model is configured.
 */
export function stripImages(messages: any[]): any[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    let hasChange = false
    const newContent: any[] = []

    for (const block of msg.content) {
      if (block.type === "image") {
        hasChange = true
        continue
      }

      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const filtered = block.content.filter((sub: any) => sub.type !== "image")
        if (filtered.length !== block.content.length) {
          hasChange = true
          newContent.push({
            ...block,
            content: filtered.length > 0 ? filtered : "image content removed",
          })
          continue
        }
      }

      newContent.push(block)
    }

    return hasChange ? { ...msg, content: newContent } : msg
  })
}
