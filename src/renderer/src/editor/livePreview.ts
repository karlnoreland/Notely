// Obsidian-style live preview.
//
// Styling (heading sizes, bold, code highlighting) is always applied. What depends on the
// cursor is whether the *syntax* is visible:
//
//   - cursor away from an element  -> markers hidden, math/images/checkboxes rendered
//   - cursor on/in an element      -> "semi-rendered": markers visible but still styled,
//                                     math shown as highlighted LaTeX source
//
// "On" means: the same line for line-level syntax (headings, quotes, list bullets, rules),
// the element itself for inline syntax (bold, links, inline code/math), and any line of the
// block for fenced code and display math.
//
// Decorations come from a StateField (not a ViewPlugin) because rendered display math
// replaces whole lines, which CodeMirror only allows for directly provided decorations.

import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { IterMode } from '@lezer/common'
import { mathSource } from './math'
import { isRawTable, parseTable, rawTableField, tableEditing, TableWidget } from './table'
import { BulletWidget, CheckboxWidget, CodeCopyWidget, HrWidget, ImageWidget, MathWidget } from './widgets'

const noSpell = { spellcheck: 'false' }

const hidden = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const hr = Decoration.replace({ widget: new HrWidget() })
const inlineCodeMark = Decoration.mark({ class: 'cm-inline-code', attributes: noSpell })
const mathSourceMark = Decoration.mark({ class: 'cm-math-source', attributes: noSpell })
const urlMark = Decoration.mark({ class: 'cm-link-text cm-url', attributes: noSpell })
const taskDoneMark = Decoration.mark({ class: 'cm-task-done' })
const quoteLine = Decoration.line({ class: 'cm-blockquote' })
const mathLine = Decoration.line({ class: 'cm-math-block', attributes: noSpell })
const tableLine = Decoration.line({ class: 'cm-table-line' })
const headingLine = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-heading cm-heading-${level}` })
)
const codeLineCache = new Map<string, Decoration>()
function codeLine(cls: string): Decoration {
  let deco = codeLineCache.get(cls)
  if (!deco) codeLineCache.set(cls, (deco = Decoration.line({ class: cls, attributes: noSpell })))
  return deco
}

const LINK_PARENTS = new Set(['Link', 'Image', 'LinkReference'])

function buildDecorations(state: EditorState): DecorationSet {
  const { doc } = state
  const ranges = state.selection.ranges
  const out: Range<Decoration>[] = []

  const touches = (from: number, to: number): boolean =>
    ranges.some((r) => r.from <= to && r.to >= from)
  const linesTouched = (from: number, to: number): boolean =>
    touches(doc.lineAt(from).from, doc.lineAt(to).to)
  const hide = (from: number, to: number): void => {
    if (to > from) out.push(hidden.range(from, to))
  }
  const eachLine = (from: number, to: number, fn: (lineFrom: number, first: boolean, last: boolean) => void): void => {
    const first = doc.lineAt(from).number
    const last = doc.lineAt(to).number
    for (let n = first; n <= last; n++) fn(doc.line(n).from, n === first, n === last)
  }
  const nextCharIsSpace = (pos: number): boolean => /[ \t]/.test(doc.sliceString(pos, pos + 1))

  syntaxTree(state).iterate({
    // Don't descend into nested languages (code blocks, LaTeX); only Markdown nodes matter here.
    mode: IterMode.IgnoreMounts,
    enter: (ref) => {
      const { name, from, to } = ref
      switch (name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          out.push(headingLine[Number(name.slice(-1)) - 1].range(doc.lineAt(from).from))
          if (linesTouched(from, to)) break
          for (const mark of ref.node.getChildren('HeaderMark')) {
            if (mark.from === from) {
              hide(mark.from, mark.to + (nextCharIsSpace(mark.to) ? 1 : 0))
            } else {
              // Optional closing sequence: "## Title ##"
              let start = mark.from
              while (start > from && /\s/.test(doc.sliceString(start - 1, start))) start--
              hide(start, mark.to)
            }
          }
          break
        }

        case 'SetextHeading1':
        case 'SetextHeading2': {
          const deco = headingLine[name === 'SetextHeading1' ? 0 : 1]
          const underline = ref.node.getChild('HeaderMark')
          const textEnd = underline ? Math.max(from, underline.from - 1) : to
          eachLine(from, textEnd, (lineFrom) => out.push(deco.range(lineFrom)))
          if (underline && !linesTouched(from, to)) hide(underline.from, underline.to)
          break
        }

        case 'Emphasis':
        case 'StrongEmphasis':
          if (!touches(from, to)) for (const m of ref.node.getChildren('EmphasisMark')) hide(m.from, m.to)
          break

        case 'Strikethrough':
          if (!touches(from, to)) for (const m of ref.node.getChildren('StrikethroughMark')) hide(m.from, m.to)
          break

        case 'InlineCode':
          out.push(inlineCodeMark.range(from, to))
          if (!touches(from, to)) for (const m of ref.node.getChildren('CodeMark')) hide(m.from, m.to)
          break

        case 'Link': {
          // Only real links: [text](url) or [text][ref]. A bare [text] stays as typed.
          const marks = ref.node.getChildren('LinkMark')
          if (marks.length < 3 || touches(from, to)) break
          const textFrom = marks[0].to
          const textTo = marks[1].from
          if (textTo <= textFrom) break
          const url = ref.node.getChild('URL')
          const href = url ? doc.sliceString(url.from, url.to) : ''
          hide(from, textFrom)
          hide(textTo, to)
          out.push(
            Decoration.mark({
              class: 'cm-link-text',
              attributes: href ? { title: `${href}\nCtrl/Cmd+Click to open` } : {}
            }).range(textFrom, textTo)
          )
          break
        }

        case 'Autolink': {
          const marks = ref.node.getChildren('LinkMark')
          if (marks.length === 2 && !touches(from, to)) {
            hide(marks[0].from, marks[0].to)
            hide(marks[1].from, marks[1].to)
          }
          break
        }

        case 'URL': {
          const parent = ref.node.parent?.name
          if (!parent || !LINK_PARENTS.has(parent)) out.push(urlMark.range(from, to))
          break
        }

        case 'Image': {
          const url = ref.node.getChild('URL')
          if (!url) break
          const marks = ref.node.getChildren('LinkMark')
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : ''
          const src = doc.sliceString(url.from, url.to)
          if (touches(from, to)) {
            // Editing: keep the source visible and show the image under it.
            out.push(Decoration.widget({ widget: new ImageWidget(src, alt, 0), side: 1 }).range(to))
            break
          }
          out.push(Decoration.replace({ widget: new ImageWidget(src, alt, 2) }).range(from, to))
          return false
        }

        case 'Table': {
          // Tables stay rendered (and editable cell by cell) wherever the cursor is, unless
          // "Edit Table as Markdown" was chosen. Tables inside quotes/lists stay as source.
          const startsLine = doc.lineAt(from).from === from && doc.lineAt(to).to === to
          const table = startsLine && !isRawTable(state, from, to) ? parseTable(state, ref.node) : null
          if (!table) {
            eachLine(from, to, (lineFrom) => out.push(tableLine.range(lineFrom)))
            break
          }
          const widget = new TableWidget(doc.sliceString(from, to), table)
          out.push(Decoration.replace({ widget, block: true }).range(from, to))
          return false
        }

        case 'Blockquote':
          eachLine(from, to, (lineFrom) => out.push(quoteLine.range(lineFrom)))
          break

        case 'QuoteMark':
          if (!linesTouched(from, to)) hide(from, to + (nextCharIsSpace(to) ? 1 : 0))
          break

        case 'ListMark': {
          if (linesTouched(from, to)) break
          const list = ref.node.parent?.parent?.name
          if (list !== 'BulletList') break
          const next = ref.node.nextSibling
          // Task items show only the checkbox, like Obsidian.
          if (next?.name === 'Task') hide(from, next.from)
          else out.push(bullet.range(from, to))
          break
        }

        case 'TaskMarker': {
          const checked = /x/i.test(doc.sliceString(from, to))
          const task = ref.node.parent
          if (checked && task && task.to > to) out.push(taskDoneMark.range(to, task.to))
          if (!linesTouched(from, to)) {
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to))
          }
          break
        }

        case 'HorizontalRule':
          if (!linesTouched(from, to)) out.push(hr.range(from, to))
          break

        case 'FencedCode': {
          eachLine(from, to, (lineFrom, first, last) => {
            let cls = 'cm-codeblock'
            if (first) cls += ' cm-codeblock-begin'
            if (last) cls += ' cm-codeblock-end'
            out.push(codeLine(cls).range(lineFrom))
          })
          if (linesTouched(from, to)) break
          const marks = ref.node.getChildren('CodeMark')
          const info = ref.node.getChild('CodeInfo')
          const open = marks[0]
          if (open) {
            const lang = info ? doc.sliceString(info.from, info.to) : ''
            const lineEnd = doc.lineAt(open.from).to
            out.push(Decoration.replace({ widget: new CodeCopyWidget(lang) }).range(open.from, lineEnd))
          }
          const close = marks.length > 1 ? marks[marks.length - 1] : null
          if (close && open && doc.lineAt(close.from).number !== doc.lineAt(open.from).number) {
            hide(close.from, close.to)
          }
          break
        }

        case 'CodeBlock':
          eachLine(from, to, (lineFrom, first, last) => {
            let cls = 'cm-codeblock'
            if (first) cls += ' cm-codeblock-begin'
            if (last) cls += ' cm-codeblock-end'
            out.push(codeLine(cls).range(lineFrom))
          })
          break

        case 'InlineMath': {
          if (touches(from, to)) {
            out.push(mathSourceMark.range(from, to))
          } else {
            const display = doc.sliceString(from, from + 2) === '$$'
            const widget = new MathWidget(mathSource(state, ref.node), display, display ? 2 : 1, false)
            out.push(Decoration.replace({ widget }).range(from, to))
          }
          return false
        }

        case 'BlockMath': {
          if (linesTouched(from, to)) {
            eachLine(from, to, (lineFrom) => out.push(mathLine.range(lineFrom)))
            return false
          }
          // A block widget must cover whole lines; inside a quote or list item the first line
          // also holds markers, so fall back to an inline widget that spans the line breaks.
          const block = doc.lineAt(from).from === from && doc.lineAt(to).to === to
          const widget = new MathWidget(mathSource(state, ref.node), true, 2, block)
          out.push(Decoration.replace({ widget, block }).range(from, to))
          return false
        }

        case 'Escape':
          if (!touches(from, to)) hide(from, from + 1)
          break
      }
      return undefined
    }
  })

  return Decoration.set(out, true)
}

const livePreviewField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(decorations, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.state.field(rawTableField, false) !== tr.startState.field(rawTableField, false)
    ) {
      return buildDecorations(tr.state)
    }
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field)
})

export const livePreview: Extension = [tableEditing, livePreviewField]
