// Shared constants for sanitizer scanning

export const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"])

export const SCANNABLE_EXTS = new Set(["ts", "tsx", "js", "jsx", "json", "md", "css", "html", "env"])

export const PLACEHOLDER_RE = /\{\{__SLOT_[0-9]{3}__\}\}/g
