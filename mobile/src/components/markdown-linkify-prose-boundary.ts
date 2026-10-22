import type MarkdownIt from 'markdown-it'
import { findProseUrlTerminator } from '../../../src/shared/prose-url-boundary'

type Linkify = MarkdownIt['linkify']
type LinkifyMatch = NonNullable<ReturnType<Linkify['matchAtStart']>>

// Why: linkify-it lets non-ascii punctuation run on in a url path, so `…/1078）。` kept `）。`;
// re-matching the text before it lets linkify's own trim run on just the url.
export function endLinkifyUrlsAtProsePunctuation(linkify: Linkify): void {
  const match = linkify.match.bind(linkify)
  const matchAtStart = linkify.matchAtStart.bind(linkify)

  const endAtProse = (link: LinkifyMatch): LinkifyMatch | null => {
    const cut = findProseUrlTerminator(link.raw)
    if (cut === -1) {
      return link
    }
    const [url] = match(link.raw.slice(0, cut)) ?? []
    if (url?.index !== 0) {
      return null
    }
    return { ...url, index: link.index, lastIndex: link.index + url.lastIndex }
  }

  linkify.match = (text) => match(text)?.flatMap((link) => endAtProse(link) ?? []) ?? null
  linkify.matchAtStart = (text) => {
    const link = matchAtStart(text)
    return link && endAtProse(link)
  }
}
