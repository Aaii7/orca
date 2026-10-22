// Why not all non-ascii: a url may carry unencoded CJK letters or emoji, but real urls
// percent-encode non-ascii punctuation, so `。`, `、`, `」`, `）` and an ideographic space end one.
export const PROSE_URL_TERMINATOR_SOURCE = String.raw`(?=[\u0080-￿])[\p{P}\p{S}\p{Z}]`

const PROSE_URL_TERMINATOR = new RegExp(PROSE_URL_TERMINATOR_SOURCE, 'u')

export function isProseUrlTerminator(char: string): boolean {
  return PROSE_URL_TERMINATOR.test(char)
}

/** Index of the first character that ends a url running through prose, or -1. */
export function findProseUrlTerminator(text: string): number {
  return text.search(PROSE_URL_TERMINATOR)
}
