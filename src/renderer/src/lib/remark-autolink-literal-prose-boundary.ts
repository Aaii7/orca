import type { Processor } from 'unified'
import { findProseUrlTerminator } from '../../../shared/prose-url-boundary'

type MarkdownNode = {
  type: string
  value?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

/** The text of a bare-url link written as itself, not `<url>` or `[url](url)`. */
function autolinkLiteralText(node: MarkdownNode): string | null {
  const [child, ...rest] = node.children ?? []
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (node.type !== 'link' || child?.type !== 'text' || rest.length > 0) {
    return null
  }
  if (child.value === undefined || start === undefined || end === undefined) {
    return null
  }
  return end - start === child.value.length ? child.value : null
}

function removePositions(node: MarkdownNode): void {
  delete node.position
  node.children?.forEach(removePositions)
}

// Why: GFM ends a bare url only at whitespace and trims only ASCII punctuation, so the url
// in `(https://…/1078)。` kept `)。`; cutting at prose punctuation and re-parsing each side
// lets GFM's own trim and balanced-paren rule run on just the url.
export function remarkAutolinkLiteralProseBoundary(this: Processor): (tree: MarkdownNode) => void {
  const parseInline = (text: string): MarkdownNode[] => {
    const tree: MarkdownNode = this.parse(text)
    splitAutolinkLiterals(tree)
    const [paragraph] = tree.children ?? []
    if (paragraph?.type !== 'paragraph' || !paragraph.children) {
      return [{ type: 'text', value: text }]
    }
    paragraph.children.forEach(removePositions)
    return paragraph.children
  }

  const splitAutolinkLiterals = (node: MarkdownNode): void => {
    if (!node.children) {
      return
    }
    node.children = node.children.flatMap((child) => {
      const literal = autolinkLiteralText(child)
      const cut = literal === null ? -1 : findProseUrlTerminator(literal)
      if (literal === null || cut === -1) {
        splitAutolinkLiterals(child)
        return [child]
      }
      return [...parseInline(literal.slice(0, cut)), ...parseInline(literal.slice(cut))]
    })
  }

  return splitAutolinkLiterals
}
