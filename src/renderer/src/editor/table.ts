// GFM tables: parsing the syntax tree into cells, rendering a read-only HTML table for live
// preview, and the "insert table" command.

import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { renderTex } from './widgets'

type Align = 'left' | 'center' | 'right' | null

interface Cell {
  text: string
  /** Offset of the cell's content from the start of the table, for click-to-edit. */
  offset: number
}

interface ParsedTable {
  header: Cell[]
  rows: Cell[][]
  align: Align[]
}

function rowCells(state: EditorState, row: SyntaxNode, tableFrom: number): Cell[] {
  const pipes = row.getChildren('TableDelimiter')
  const segments: [number, number][] = []
  let start = row.from
  for (const pipe of pipes) {
    segments.push([start, pipe.from])
    start = pipe.to
  }
  segments.push([start, row.to])
  // Leading and trailing pipes are optional in GFM; drop the empty segments they create.
  if (pipes.length && pipes[0].from === row.from) segments.shift()
  if (pipes.length && pipes[pipes.length - 1].to === row.to) segments.pop()
  return segments.map(([from, to]) => {
    const raw = state.doc.sliceString(from, to)
    const lead = raw.length - raw.trimStart().length
    return { text: raw.trim(), offset: from + lead - tableFrom }
  })
}

function parseAlign(line: string): Align[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((spec) => {
      const s = spec.trim()
      const left = s.startsWith(':')
      const right = s.endsWith(':')
      return left && right ? 'center' : right ? 'right' : left ? 'left' : null
    })
}

export function parseTable(state: EditorState, table: SyntaxNode): ParsedTable | null {
  const header = table.getChild('TableHeader')
  if (!header) return null
  const delimiterLine = state.doc.lineAt(header.to + 1)
  return {
    header: rowCells(state, header, table.from),
    rows: table.getChildren('TableRow').map((row) => rowCells(state, row, table.from)),
    align: parseAlign(delimiterLine.text)
  }
}

// ---- Minimal inline Markdown for cells ---------------------------------------------------------

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Bold, italic, strikethrough, code, math and link text — enough for table cells. */
export function renderInline(src: string): string {
  const protectedHtml: string[] = []
  const protect = (html: string): string => `\u0000${protectedHtml.push(html) - 1}\u0000`
  let s = src.replace(/\\\|/g, '|')
  s = s.replace(/`([^`]+)`/g, (_, code: string) => protect(`<code>${escapeHtml(code)}</code>`))
  s = s.replace(/\$([^\s$](?:[^$]*[^\s$])?)\$/g, (_, tex: string) => protect(renderTex(tex, false)))
  s = escapeHtml(s)
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
  s = s.replace(/\*(.+?)\*|\b_(.+?)_\b/g, (_, a?: string, b?: string) => `<em>${a ?? b}</em>`)
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<span class="cm-table-link" title="$2">$1</span>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => protectedHtml[Number(i)])
}

export class TableWidget extends WidgetType {
  constructor(
    /** Raw table source: two widgets with the same source render identically. */
    readonly source: string,
    readonly table: ParsedTable
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    const table = document.createElement('table')
    table.className = 'cm-table'
    const columns = Math.max(this.table.header.length, ...this.table.rows.map((r) => r.length))

    const addRow = (parent: HTMLElement, cells: Cell[], tag: 'th' | 'td'): void => {
      const tr = document.createElement('tr')
      for (let i = 0; i < columns; i++) {
        const cell = cells[i]
        const el = document.createElement(tag)
        const align = this.table.align[i]
        if (align) el.style.textAlign = align
        // Empty cells get a non-breaking space so rows keep their normal height.
        el.innerHTML = cell?.text ? renderInline(cell.text) : '&nbsp;'
        if (cell) el.dataset.offset = String(cell.offset)
        tr.append(el)
      }
      parent.append(tr)
    }
    const thead = document.createElement('thead')
    addRow(thead, this.table.header, 'th')
    const tbody = document.createElement('tbody')
    for (const row of this.table.rows) addRow(tbody, row, 'td')
    table.append(thead, tbody)
    wrap.append(table)

    // Clicking a cell moves the cursor to that cell's text in the source.
    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const cell = (event.target as HTMLElement).closest<HTMLElement>('th, td')
      const offset = Number(cell?.dataset.offset ?? 0)
      const pos = Math.min(view.posAtDOM(wrap) + offset, view.state.doc.length)
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
    })
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---- Insert command --------------------------------------------------------------------------

/** Inserts an empty table with `columns` columns and `rows` body rows, selecting the first header. */
export function insertTable(columns: number, rows: number): StateCommand {
  return ({ state, dispatch }) => {
    const titles = Array.from({ length: columns }, (_, i) => `Column ${i + 1}`)
    const line = (cells: string[]): string => `| ${cells.join(' | ')} |`
    const text = [
      line(titles),
      line(titles.map((t) => '-'.repeat(t.length))),
      ...Array.from({ length: rows }, () => line(titles.map((t) => ' '.repeat(t.length))))
    ].join('\n')

    const range = state.selection.main
    const current = state.doc.lineAt(range.head)
    const blank = current.text.trim() === ''
    // A table needs its own lines, separated from surrounding paragraphs by blank lines.
    const from = blank ? current.from : current.to
    const to = blank ? current.to : current.to
    let prefix = ''
    if (!blank) prefix = '\n\n'
    else if (current.number > 1 && state.doc.line(current.number - 1).text.trim() !== '') prefix = '\n'
    const next = current.number < state.doc.lines ? state.doc.line(current.number + 1) : null
    const suffix = next && next.text.trim() !== '' ? '\n' : ''

    const start = from + prefix.length + 2 // just inside "| "
    dispatch(
      state.update({
        changes: { from, to, insert: prefix + text + suffix },
        selection: EditorSelection.range(start, start + titles[0].length),
        scrollIntoView: true,
        userEvent: 'input.table'
      })
    )
    return true
  }
}
