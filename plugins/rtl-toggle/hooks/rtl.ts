// Pure text helpers for the rtl-toggle mod (no engine access, unit-testable).

// RIGHT-TO-LEFT MARK: a zero-width strong RTL character. Placed first in a
// block's content it becomes the first strong char, so renderers using
// automatic direction (dir=auto / UBA rule P2) give the block an RTL base
// direction and right alignment. Isolates (RLI...PDI) are not used because
// P2 skips isolate contents, leaving such blocks LTR-aligned.
export const RLM = '‏'
// Legacy controls: no longer emitted, still recognised by the double-mark
// guard so text marked by an older version is not marked again.
const LEGACY_RLI = '⁧'
const LEGACY_RLE = '‫'

// Dominance is counted in WORDS (maximal runs of RTL letters or of LTR
// letters), not letters. A line is marked when it has at least one RTL word and
// rtlWords / (rtlWords + ltrWords) >= MIN_RTL_WORD_SHARE, i.e. RTL words are
// at least as many as LTR words: a tie goes to RTL.
export const MIN_RTL_WORD_SHARE = 0.5

// Every block Unicode assigns to right-to-left scripts (the ranges UAX #9
// defaults to R/AL): Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic
// and the Arabic supplements/extensions (U+0590-08FF), Hebrew and Arabic
// presentation forms (U+FB1D-FDFF, U+FE70-FEFF), and the historic and modern
// RTL scripts of planes 1 (U+10800-10FFF: Hanifi Rohingya, Yezidi, ...) and
// U+1E800-1EFFF (Adlam, Arabic mathematical). Explicit ranges are ~4x faster
// than \p{Script=...} lookups. Any other letter (Latin, Cyrillic, Greek, CJK,
// ...) is LTR, so a Russian word counts against the RTL share like an English one.
const RTL_RANGES = String.raw`\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}`
const RTL_CHAR = new RegExp(`[${RTL_RANGES}]`, 'u')
const RTL_WORDS_G = new RegExp(`[${RTL_RANGES}]+`, 'gu')
// LTR word: a letter outside the RTL blocks (`[^\P{L}<rtl>]`), then more such
// letters or combining marks (Devanagari vowel signs, decomposed accents).
const LTR_LETTER = String.raw`[^\P{L}${RTL_RANGES}]`
const LTR_WORDS_G = new RegExp(String.raw`${LTR_LETTER}(?:${LTR_LETTER}|\p{M})*`, 'gu')
const FIRST_LETTER = /\p{L}/u

// Leading markdown prefix that must stay at column 0 of the rendered line:
// indentation, blockquote markers, then a list marker (with optional task
// checkbox) or an ATX heading marker. Each whitespace run belongs to exactly
// one quantifier, so a failed match cannot backtrack quadratically.
const QUOTES = String.raw`[ \t]*(?:>[ \t]*)*`
const LIST_MARKER = String.raw`(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?`
const PREFIX_RE = new RegExp(String.raw`^${QUOTES}(?:${LIST_MARKER}|#{1,6}[ \t]+)?`)
const LIST_ITEM_RE = new RegExp(String.raw`^${QUOTES}${LIST_MARKER}`)
// Link syntax removed before counting words (never from the output text):
// `](target)` of links/images (one level of parentheses allowed in the target),
// `][ref]` labels, <scheme://...> autolinks and bare http(s)/www URLs. Every
// pattern stops at the next opener, so none can rescan a line quadratically.
const LINK_NOISE_RES = [
  /\]\((?:[^()\n]|\([^()\n]*\))*\)/g,
  /\]\[[^\]]*\]/g,
  /<[A-Za-z][A-Za-z0-9+.-]*:\/\/[^<>\s]*>/g,
  /https?:\/\/\S+/gi,
  /www\.\S+/gi,
]
const INDENTED_CODE_RE = /^(?: {4}|\t)/
// Fences are recognised inside blockquotes and list items too (`> ```ts`).
const FENCE_RE = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/

// Replace inline code spans (`x`, ``x ` y``) with a space: identifiers and
// commands inside them are not prose and must not count as LTR words. A span
// closes at the next backtick run of the same length (CommonMark); an opener
// with no closer is literal. Linear: closers are found via a precomputed table.
function stripCodeSpans(s: string): string {
  if (!s.includes('`')) return s
  const starts: number[] = []
  const lens: number[] = []
  for (let i = 0; i < s.length; ) {
    if (s[i] !== '`') { i++; continue }
    let j = i
    while (s[j] === '`') j++
    starts.push(i)
    lens.push(j - i)
    i = j
  }
  // closer[k]: index of the next run with the same length as run k, or -1.
  const closer = new Array<number>(lens.length)
  const seen = new Map<number, number>()
  for (let k = lens.length - 1; k >= 0; k--) {
    closer[k] = seen.get(lens[k]!) ?? -1
    seen.set(lens[k]!, k)
  }
  let out = ''
  let pos = 0
  for (let k = 0; k < lens.length; k++) {
    const c = closer[k]!
    if (c < 0) continue
    out += s.slice(pos, starts[k]) + ' '
    pos = starts[c]! + lens[c]!
    k = c
  }
  return out + s.slice(pos)
}

export type RtlOptions = {
  // Mark table cells individually (see wrapTableRow). Off for the terminal,
  // which has no bidi layout to fix and measures column widths itself.
  tableCells?: boolean
}

// Whether a line or cell body (markdown prefix already removed) should get a
// leading RLM: it starts with an LTR letter and RTL words are at least as many
// as LTR words.
function needsMark(rest: string): boolean {
  if (rest.startsWith(RLM) || rest.startsWith(LEGACY_RLI) || rest.startsWith(LEGACY_RLE)) return false // already marked

  const first = FIRST_LETTER.exec(rest)
  if (!first || RTL_CHAR.test(first[0])) return false // empty, or already RTL-leading

  const countable = LINK_NOISE_RES.reduce((t, re) => t.replace(re, ' '), stripCodeSpans(rest))
  const rtl = (countable.match(RTL_WORDS_G) ?? []).length
  const ltr = (countable.match(LTR_WORDS_G) ?? []).length
  return rtl >= 1 && rtl / (rtl + ltr) >= MIN_RTL_WORD_SHARE
}

// Mark each qualifying cell of a `|`-led table row right after its leading
// whitespace, so renderers that pick each cell's direction from its first
// strong char right-align it. Cells split on unescaped `|` (GFM: `\|` inside
// a cell, code spans included, is a literal pipe).
function wrapTableRow(line: string): string {
  let out = ''
  let cell = -1 // start of the current cell's text, -1 before the first pipe
  const flush = (end: number) => {
    const body = line.slice(cell, end)
    const lead = body.length - body.trimStart().length
    out += needsMark(body.slice(lead)) ? body.slice(0, lead) + RLM + body.slice(lead) : body
  }
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue }
    if (line[i] !== '|') continue
    if (cell < 0) out += line.slice(0, i + 1)
    else { flush(i); out += '|' }
    cell = i + 1
  }
  flush(line.length) // a row without a trailing pipe ends in a cell; whitespace is never marked
  return out
}

// Mark one line (no newline, no trailing \r) when RTL words are at least as many as
// LTR words but it starts with an LTR letter. Markdown prefixes stay in front of the RLM.
export function wrapLineIfNeeded(line: string, options: RtlOptions = {}): string {
  if (!RTL_CHAR.test(line)) return line // no RTL content at all
  if (line.trimStart().startsWith('|')) return options.tableCells ? wrapTableRow(line) : line
  if (INDENTED_CODE_RE.test(line) && !LIST_ITEM_RE.test(line)) return line // indented code block

  const prefix = PREFIX_RE.exec(line)![0]
  const rest = line.slice(prefix.length)
  return needsMark(rest) ? `${prefix}${RLM}${rest}` : line
}

type Fence = { char: string; length: number } | null

// Rewrite a run of lines starting in fence state `fence`; returns the new state.
function convertLines(lines: string[], fence: Fence, options: RtlOptions): { out: string[]; fence: Fence } {
  const out = lines.map(raw => {
    const hasCr = raw.endsWith('\r')
    const line = hasCr ? raw.slice(0, -1) : raw
    const m = FENCE_RE.exec(line)
    const marker = m?.[1] ?? ''
    const info = m?.[2] ?? ''

    if (fence) {
      if (m && marker[0] === fence.char && marker.length >= fence.length && info.trim() === '') fence = null
      return raw
    }
    if (m && !(marker[0] === '`' && info.includes('`'))) {
      fence = { char: marker[0]!, length: marker.length }
      return raw
    }

    return wrapLineIfNeeded(line, options) + (hasCr ? '\r' : '')
  })
  return { out, fence }
}

// Messages are redrawn far more often than they change: every streamed chunk
// redraws the growing answer, and scrolling or toggling redraws old ones.
// Finished results are kept in a small LRU bounded by total size, and the
// last converted text's complete lines are reused when the next text extends
// it, so a streaming answer only converts its newest lines. One memo per set
// of options, since they change the result.
const CACHE_BUDGET = 4_000_000 // chars, across all cached results of one memo

type Memo = {
  cache: Map<string, string>
  size: number
  stream: { src: string; out: string; fence: Fence }
}
const memos = new Map<boolean, Memo>()

function remember(memo: Memo, text: string, result: string) {
  if (text.length > CACHE_BUDGET) return
  memo.cache.set(text, result)
  memo.size += text.length
  for (const [k] of memo.cache) {
    if (memo.size <= CACHE_BUDGET) break
    memo.cache.delete(k)
    memo.size -= k.length
  }
}

// Rewrite a whole message: skips fenced code blocks (and their fence lines)
// and keeps CRLF endings intact.
export function toRtl(text: string, options: RtlOptions = {}): string {
  if (!RTL_CHAR.test(text)) return text

  const key = !!options.tableCells
  let memo = memos.get(key)
  if (!memo) memos.set(key, (memo = { cache: new Map(), size: 0, stream: { src: '', out: '', fence: null } }))

  const hit = memo.cache.get(text)
  if (hit !== undefined) {
    memo.cache.delete(text) // refresh LRU position
    memo.cache.set(text, hit)
    return hit
  }

  const base = memo.stream.src && text.startsWith(memo.stream.src) ? memo.stream : { src: '', out: '', fence: null }
  const cut = text.lastIndexOf('\n') + 1 // end of the last complete line
  let head = base.out
  let fence = base.fence
  if (cut > base.src.length) {
    const done = convertLines(text.slice(base.src.length, cut - 1).split('\n'), fence, options)
    head += done.out.join('\n') + '\n'
    fence = done.fence
    memo.stream = { src: text.slice(0, cut), out: head, fence }
  }
  const result = head + convertLines([text.slice(cut)], fence, options).out[0]

  remember(memo, text, result)
  return result
}
