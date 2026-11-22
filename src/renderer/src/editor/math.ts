// Markdown syntax extension for LaTeX math: $inline$, $$display$$ and multi-line
//
//   $$
//   \int_0^1 x^2 \, dx
//   $$
//
// The math content is parsed a second time by CodeMirror's sTeX mode (parseMixed), so it is
// syntax highlighted while you edit it, exactly like a fenced code block.

import { StreamLanguage } from '@codemirror/language'
import { stexMath } from '@codemirror/legacy-modes/mode/stex'
import type { EditorState } from '@codemirror/state'
import { parseMixed, type SyntaxNode } from '@lezer/common'
import { tags as t } from '@lezer/highlight'
import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from '@lezer/markdown'

const DOLLAR = 36
const BACKSLASH = 92

const latex = StreamLanguage.define(stexMath)

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13
const isDigit = (c: number): boolean => c >= 48 && c <= 57

/**
 * Inline math follows Pandoc's rules so prices like "$5 and $10" are not math:
 * the opening $ must not be followed by whitespace, and the closing $ must not be
 * preceded by whitespace or followed by a digit.
 */
function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR) return -1
  const display = cx.char(pos + 1) === DOLLAR
  const markLen = display ? 2 : 1
  const start = pos + markLen
  if (!display) {
    const first = cx.char(start)
    if (first < 0 || isSpace(first) || first === DOLLAR) return -1
  }
  for (let i = start; i < cx.end; i++) {
    const c = cx.char(i)
    if (c === BACKSLASH) {
      i++
      continue
    }
    if (c !== DOLLAR) continue
    if (display) {
      if (cx.char(i + 1) !== DOLLAR) continue
      if (i === start) return -1
    } else if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) {
      continue
    }
    const end = i + markLen
    return cx.addElement(
      cx.elt('InlineMath', pos, end, [
        cx.elt('MathMark', pos, start),
        cx.elt('MathContent', start, i),
        cx.elt('MathMark', i, end)
      ])
    )
  }
  return -1
}

const isMathFence = (line: Line): boolean =>
  line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR

function parseBlockMath(cx: BlockContext, line: Line): boolean {
  if (!isMathFence(line)) return false
  const from = cx.lineStart + line.pos
  const children: Element[] = [cx.elt('MathMark', from, from + 2)]

  // Single line: $$ ... $$
  const rest = line.text.slice(line.pos + 2).trimEnd()
  if (rest.length >= 2 && rest.endsWith('$$')) {
    const close = from + rest.length
    if (close > from + 2) children.push(cx.elt('MathContent', from + 2, close))
    children.push(cx.elt('MathMark', close, close + 2))
    cx.nextLine()
    cx.addElement(cx.elt('BlockMath', from, close + 2, children))
    return true
  }

  // Multi-line: content until a line ending in $$ (or the end of the enclosing container).
  let end = cx.lineStart + line.text.length
  if (end > from + 2) children.push(cx.elt('MathContent', from + 2, end))
  // Same continuation rule as @lezer/markdown's FencedCode: stop when leaving the container
  // (block quote, list item) the math started in. Its markers become children of the node.
  // (`Line.depth` is marked internal in the typings but is what FencedCode itself uses.)
  const depth = cx.depth
  const lineDepth = (): number => (line as unknown as { depth: number }).depth
  while (cx.nextLine() && lineDepth() >= depth) {
    children.push(...line.markers)
    const lineStart = cx.lineStart
    const contentFrom = lineStart + line.pos
    const trimmed = line.text.trimEnd()
    if (trimmed.endsWith('$$') && trimmed.length - 2 >= line.pos) {
      const close = lineStart + trimmed.length - 2
      if (close > contentFrom) children.push(cx.elt('MathContent', contentFrom, close))
      children.push(cx.elt('MathMark', close, close + 2))
      end = close + 2
      cx.nextLine()
      break
    }
    const lineEnd = lineStart + line.text.length
    if (lineEnd > contentFrom) children.push(cx.elt('MathContent', contentFrom, lineEnd))
    end = lineEnd
  }
  cx.addElement(cx.elt('BlockMath', from, end, children))
  return true
}

export const mathExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath' },
    { name: 'BlockMath', block: true },
    { name: 'MathMark', style: t.processingInstruction },
    { name: 'MathContent' }
  ],
  parseInline: [{ name: 'InlineMath', parse: parseInlineMath, before: 'Emphasis' }],
  parseBlock: [
    {
      name: 'BlockMath',
      parse: parseBlockMath,
      // Allow $$ to start right after a paragraph line without a blank line in between.
      endLeaf: (_cx, line) => isMathFence(line),
      before: 'FencedCode'
    }
  ],
  // Highlight the LaTeX with one continuous range from the first to the last content piece.
  // (Per-line overlay ranges crash the stream parser's gap handling when the first piece
  // starts mid-line, e.g. "$$ x" on the opening line. Inside a block quote this means the
  // "> " markers are lexed as LaTeX too, which is harmless.)
  wrap: parseMixed((ref) => {
    if (ref.name !== 'InlineMath' && ref.name !== 'BlockMath') return null
    const parts = ref.node.getChildren('MathContent')
    if (!parts.length) return null
    return { parser: latex.parser, overlay: [{ from: parts[0].from, to: parts[parts.length - 1].to }] }
  })
}

/** The TeX source of an InlineMath or BlockMath node, without delimiters or quote markers. */
export function mathSource(state: EditorState, node: SyntaxNode): string {
  const parts = node.getChildren('MathContent').map((c) => state.doc.sliceString(c.from, c.to))
  return parts.join(node.name === 'BlockMath' ? '\n' : '')
}
