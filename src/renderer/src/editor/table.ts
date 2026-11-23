// GFM tables that stay rendered while you edit them.
//
// A table is shown as an HTML table. Clicking a cell turns just that cell into a text input
// with its raw Markdown ("semi-rendered", like the rest of the editor); every keystroke is
// written back to the document, which is kept as a neatly padded Markdown table. Tab/Enter/
// arrow keys move between cells, and "Edit Table as Markdown" falls back to plain source.

import { redo, undo } from '@codemirror/commands'
import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { TableAction } from '../../../shared/types'
import { noteContext } from './context'
import { renderTex } from './widgets'

export type Align = 'left' | 'center' | 'right' | null

export interface TableModel {
  align: Align[]
  header: string[]
  /** Every row has exactly header.length cells. Cell text is raw Markdown (pipes escaped). */
  rows: string[][]
}

// ---- Parsing and serializing -----------------------------------------------------------------

function rowCells(state: EditorState, row: SyntaxNode): string[] {
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
  return segments.map(([from, to]) => state.doc.sliceString(from, to).trim())
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

export function parseTable(state: EditorState, table: SyntaxNode): TableModel | null {
  const headerNode = table.getChild('TableHeader')
  if (!headerNode) return null
  const header = rowCells(state, headerNode)
  const width = header.length
  const fit = <T>(cells: T[], fill: T): T[] =>
    cells.length >= width ? cells.slice(0, width) : [...cells, ...Array<T>(width - cells.length).fill(fill)]
  return {
    header,
    align: fit(parseAlign(state.doc.lineAt(headerNode.to + 1).text), null),
    rows: table.getChildren('TableRow').map((row) => fit(rowCells(state, row), ''))
  }
}

/** Markdown for a table, with columns padded to equal width. */
export function serializeTable(m: TableModel): string {
  const widths = m.header.map((h, c) => Math.max(3, h.length, ...m.rows.map((r) => r[c].length)))
  const line = (cells: string[]): string => `| ${cells.map((t, c) => t.padEnd(widths[c])).join(' | ')} |`
  const rule = widths.map((w, c) => {
    const a = m.align[c]
    if (a === 'center') return `:${'-'.repeat(w - 2)}:`
    if (a === 'right') return `${'-'.repeat(w - 1)}:`
    if (a === 'left') return `:${'-'.repeat(w - 1)}`
    return '-'.repeat(w)
  })
  return [line(m.header), `| ${rule.join(' | ')} |`, ...m.rows.map(line)].join('\n')
}

const escapeCell = (text: string): string => text.replace(/(?<!\\)\|/g, '\\|')
const unescapeCell = (text: string): string => text.replace(/\\\|/g, '|')
const cloneModel = (m: TableModel): TableModel => ({
  align: [...m.align],
  header: [...m.header],
  rows: m.rows.map((r) => [...r])
})

// ---- Minimal inline Markdown for cells ---------------------------------------------------------

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Bold, italic, strikethrough, code, math and link text — enough for table cells. */
export function renderInline(src: string): string {
  const protectedHtml: string[] = []
  const protect = (html: string): string => `\u0000${protectedHtml.push(html) - 1}\u0000`
  let s = unescapeCell(src)
  s = s.replace(/`([^`]+)`/g, (_, code: string) => protect(`<code>${escapeHtml(code)}</code>`))
  s = s.replace(/\$([^\s$](?:[^$]*[^\s$])?)\$/g, (_, tex: string) => protect(renderTex(tex, false)))
  s = escapeHtml(s)
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
  s = s.replace(/\*(.+?)\*|\b_(.+?)_\b/g, (_, a?: string, b?: string) => `<em>${a ?? b}</em>`)
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<span class="cm-table-link" title="$2">$1</span>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => protectedHtml[Number(i)])
}

// ---- "Edit Table as Markdown" ------------------------------------------------------------------

interface Range {
  from: number
  to: number
}

const setRawTable = StateEffect.define<Range | null>()

/** The table currently shown as source; cleared once the cursor leaves it. */
export const rawTableField = StateField.define<Range | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setRawTable)) value = effect.value
    if (value && tr.docChanged) {
      value = { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) }
    }
    if (value && tr.selection) {
      const head = tr.state.selection.main.head
      if (head < value.from || head > value.to) value = null
    }
    return value
  }
})

export function isRawTable(state: EditorState, from: number, to: number): boolean {
  const raw = state.field(rawTableField, false)
  return !!raw && raw.from <= to && raw.to >= from
}

// ---- The widget ------------------------------------------------------------------------------

type Caret = 'all' | 'start' | 'end'

interface PendingFocus {
  from: number
  row: number
  col: number
  caret: Caret
}

/** A cell to focus once the table at `from` has been (re)rendered. */
const pendingFocus = new WeakMap<EditorView, PendingFocus>()
const tableViews = new WeakMap<HTMLElement, TableView>()
/** The cell that was right-clicked, for actions chosen from the native context menu. */
let contextCell: { view: TableView; row: number; col: number } | null = null

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly model: TableModel
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    new TableView(wrap, view, this)
    return wrap
  }

  /** Keep the DOM (and the focused cell input) when only the table's text changed. */
  updateDOM(dom: HTMLElement): boolean {
    const tableView = tableViews.get(dom)
    if (!tableView) return false
    tableView.update(this)
    return true
  }

  get estimatedHeight(): number {
    return (this.model.rows.length + 1) * 37 + 30
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Row 0 is the header; rows 1…n are the body. */
class TableView {
  private active: { row: number; col: number; input: HTMLInputElement } | null = null

  constructor(
    readonly wrap: HTMLElement,
    readonly view: EditorView,
    private widget: TableWidget
  ) {
    tableViews.set(wrap, this)
    this.build()
    this.listen()
    this.applyPendingFocus()
  }

  get model(): TableModel {
    return this.widget.model
  }

  get rowCount(): number {
    return this.model.rows.length + 1
  }

  get colCount(): number {
    return this.model.header.length
  }

  private text(row: number, col: number): string {
    return row === 0 ? this.model.header[col] : this.model.rows[row - 1][col]
  }

  /** The table's current range in the document, or null if the DOM is stale. */
  range(): Range | null {
    let from: number
    try {
      from = this.view.posAtDOM(this.wrap)
    } catch {
      return null
    }
    const to = from + this.widget.source.length
    return this.view.state.sliceDoc(from, to) === this.widget.source ? { from, to } : null
  }

  // -- Rendering

  private cell(row: number, col: number): HTMLElement | null {
    return this.wrap.querySelector(`[data-row="${row}"][data-col="${col}"]`)
  }

  private renderCell(el: HTMLElement, text: string, align: Align): void {
    el.style.textAlign = align ?? ''
    el.innerHTML = text ? renderInline(text) : '&nbsp;'
  }

  private build(): void {
    const table = document.createElement('table')
    table.className = 'cm-table'
    const thead = document.createElement('thead')
    const tbody = document.createElement('tbody')
    for (let row = 0; row < this.rowCount; row++) {
      const tr = document.createElement('tr')
      for (let col = 0; col < this.colCount; col++) {
        const el = document.createElement(row === 0 ? 'th' : 'td')
        el.dataset.row = String(row)
        el.dataset.col = String(col)
        this.renderCell(el, this.text(row, col), this.model.align[col])
        tr.append(el)
      }
      ;(row === 0 ? thead : tbody).append(tr)
    }
    table.append(thead, tbody)

    const button = (cls: string, title: string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.title = title
      b.textContent = '+'
      return b
    }
    const inner = document.createElement('div')
    inner.className = 'cm-table-inner'
    // Grid: table | add-column button, with the add-row button under the table.
    inner.append(table, button('cm-table-add-col', 'Add column'), button('cm-table-add-row', 'Add row'))
    this.wrap.replaceChildren(inner)
    this.active = null
  }

  update(widget: TableWidget): void {
    const before = this.model
    this.widget = widget
    const active = this.active
    if (before.header.length !== this.colCount || before.rows.length !== this.model.rows.length) {
      // Rows or columns changed: rebuild, keeping the edited cell if it still exists.
      const caret = active?.input.selectionStart ?? null
      const hadFocus = !!active && document.activeElement === active.input
      this.build()
      if (active && hadFocus && active.row < this.rowCount && active.col < this.colCount) {
        this.activate(active.row, active.col, 'end')
        if (caret !== null) this.active?.input.setSelectionRange(caret, caret)
      }
    } else {
      for (let row = 0; row < this.rowCount; row++) {
        for (let col = 0; col < this.colCount; col++) {
          const text = this.text(row, col)
          const old = row === 0 ? before.header[col] : before.rows[row - 1][col]
          const el = this.cell(row, col)
          if (!el) continue
          if (active && active.row === row && active.col === col) {
            // Undo/redo can change the cell being edited.
            if (active.input.value !== unescapeCell(text)) active.input.value = unescapeCell(text)
            el.style.textAlign = this.model.align[col] ?? ''
          } else if (text !== old || this.model.align[col] !== before.align[col]) {
            this.renderCell(el, text, this.model.align[col])
          }
        }
      }
    }
    this.applyPendingFocus()
  }

  private applyPendingFocus(): void {
    if (!pendingFocus.has(this.view)) return
    // CodeMirror has updated the DOM by the time the dispatch returns, so a microtask is enough.
    // (Not requestAnimationFrame: it never fires while the window is hidden or covered.)
    queueMicrotask(() => {
      const pending = pendingFocus.get(this.view)
      if (pending && this.wrap.isConnected && this.range()?.from === pending.from) {
        pendingFocus.delete(this.view)
        this.activate(pending.row, pending.col, pending.caret)
      }
    })
  }

  // -- Editing a cell

  activate(row: number, col: number, caret: Caret): void {
    if (this.active?.row === row && this.active.col === col) {
      this.active.input.focus()
      return
    }
    this.deactivate()
    const el = this.cell(row, col)
    if (!el) return
    const input = document.createElement('input')
    input.className = 'cm-cell-input'
    input.spellcheck = true
    input.value = unescapeCell(this.text(row, col))
    el.replaceChildren(input)
    el.classList.add('cm-cell-active')
    this.active = { row, col, input }
    input.focus()
    if (caret === 'all') input.select()
    else {
      const at = caret === 'start' ? 0 : input.value.length
      input.setSelectionRange(at, at)
    }
    input.addEventListener('input', () => this.editCell(row, col, input.value))
    input.addEventListener('keydown', (event) => this.onKey(event, row, col, input))
    input.addEventListener('blur', () => {
      // Switching to another app keeps the cell open; it regains focus when we come back.
      if (document.hasFocus() && this.active?.input === input) this.deactivate()
    })
  }

  private deactivate(): void {
    const active = this.active
    if (!active) return
    this.active = null
    const el = this.cell(active.row, active.col)
    if (el) {
      el.classList.remove('cm-cell-active')
      this.renderCell(el, this.text(active.row, active.col), this.model.align[active.col])
    }
  }

  private editCell(row: number, col: number, value: string): void {
    const next = cloneModel(this.model)
    if (row === 0) next.header[col] = escapeCell(value)
    else next.rows[row - 1][col] = escapeCell(value)
    this.commit(next)
  }

  /** Writes `next` to the document as a minimal change, optionally focusing a cell afterwards. */
  commit(next: TableModel, focus?: { row: number; col: number; caret: Caret }): void {
    const range = this.range()
    if (!range) return
    const text = serializeTable(next)
    const old = this.widget.source
    let start = 0
    while (start < old.length && start < text.length && old[start] === text[start]) start++
    let endOld = old.length
    let endNew = text.length
    while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) {
      endOld--
      endNew--
    }
    if (focus) pendingFocus.set(this.view, { from: range.from, ...focus })
    if (start === endOld && start === endNew) {
      if (focus) this.applyPendingFocus()
      return
    }
    this.view.dispatch({
      changes: { from: range.from + start, to: range.from + endOld, insert: text.slice(start, endNew) },
      userEvent: 'input.table'
    })
  }

  private move(row: number, col: number, caret: Caret): void {
    this.activate(row, col, caret)
  }

  /** Leaves the table, putting the editor cursor on the line above or below it. */
  exit(direction: 'above' | 'below'): void {
    const range = this.range()
    this.deactivate()
    if (!range) return
    const { state } = this.view
    if (direction === 'above') {
      if (range.from === 0) this.view.dispatch({ changes: { from: 0, insert: '\n' }, selection: { anchor: 0 } })
      else this.view.dispatch({ selection: { anchor: range.from - 1 } })
    } else if (range.to >= state.doc.length) {
      this.view.dispatch({
        changes: { from: state.doc.length, insert: '\n' },
        selection: { anchor: state.doc.length + 1 }
      })
    } else {
      this.view.dispatch({ selection: { anchor: range.to + 1 } })
    }
    this.view.focus()
  }

  private onKey(event: KeyboardEvent, row: number, col: number, input: HTMLInputElement): void {
    const mod = event.ctrlKey || event.metaKey
    const lastRow = this.rowCount - 1
    const lastCol = this.colCount - 1
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length
    // Ctrl+Tab belongs to the app (switching tabs).
    if (event.key === 'Tab' && event.ctrlKey) return
    let handled = true
    switch (event.key) {
      case 'Tab':
        if (event.shiftKey) {
          if (col > 0) this.move(row, col - 1, 'all')
          else if (row > 0) this.move(row - 1, lastCol, 'all')
          else this.exit('above')
        } else if (col < lastCol) this.move(row, col + 1, 'all')
        else if (row < lastRow) this.move(row + 1, 0, 'all')
        else this.insertRow(this.rowCount, 0)
        break
      case 'Enter':
        if (event.shiftKey) {
          if (row > 0) this.move(row - 1, col, 'end')
        } else if (row < lastRow) this.move(row + 1, col, 'end')
        else this.insertRow(this.rowCount, col)
        break
      case 'ArrowUp':
        if (row > 0) this.move(row - 1, col, 'end')
        else this.exit('above')
        break
      case 'ArrowDown':
        if (row < lastRow) this.move(row + 1, col, 'end')
        else this.exit('below')
        break
      case 'ArrowLeft':
        if (!atStart || event.shiftKey) handled = false
        else if (col > 0) this.move(row, col - 1, 'end')
        else if (row > 0) this.move(row - 1, lastCol, 'end')
        break
      case 'ArrowRight':
        if (!atEnd || event.shiftKey) handled = false
        else if (col < lastCol) this.move(row, col + 1, 'start')
        else if (row < lastRow) this.move(row + 1, 0, 'start')
        break
      case 'Escape':
        this.exit('below')
        break
      default:
        // Undo/redo go through the editor's history so they stay in sync with the document.
        if (mod && event.key.toLowerCase() === 'z') (event.shiftKey ? redo : undo)(this.view)
        else if (mod && event.key.toLowerCase() === 'y') redo(this.view)
        else handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // -- Structure

  insertRow(at: number, focusCol: number): void {
    const next = cloneModel(this.model)
    next.rows.splice(Math.max(0, at - 1), 0, Array<string>(this.colCount).fill(''))
    this.commit(next, { row: Math.max(1, at), col: focusCol, caret: 'start' })
  }

  insertColumn(at: number, focusRow: number): void {
    const next = cloneModel(this.model)
    next.header.splice(at, 0, '')
    next.align.splice(at, 0, null)
    for (const row of next.rows) row.splice(at, 0, '')
    this.commit(next, { row: focusRow, col: at, caret: 'start' })
  }

  run(action: TableAction, row: number, col: number): void {
    const next = cloneModel(this.model)
    switch (action) {
      case 'row-above':
        return row === 0 ? this.insertRow(1, col) : this.insertRow(row, col)
      case 'row-below':
        return this.insertRow(row + 1, col)
      case 'col-left':
        return this.insertColumn(col, row)
      case 'col-right':
        return this.insertColumn(col + 1, row)
      case 'delete-row':
        if (row === 0) {
          // The header can't be empty: promote the first body row, or drop the whole table.
          if (!next.rows.length) return this.deleteTable()
          next.header = next.rows.shift()!
        } else next.rows.splice(row - 1, 1)
        return this.commit(next, { row: Math.min(row, next.rows.length), col, caret: 'end' })
      case 'delete-col':
        if (this.colCount === 1) return this.deleteTable()
        next.header.splice(col, 1)
        next.align.splice(col, 1)
        for (const r of next.rows) r.splice(col, 1)
        return this.commit(next, { row, col: Math.min(col, next.header.length - 1), caret: 'end' })
      case 'align-left':
      case 'align-center':
      case 'align-right':
      case 'align-none':
        next.align[col] = action === 'align-none' ? null : (action.slice(6) as Align)
        return this.commit(next)
      case 'edit-source':
        return this.editSource()
      case 'delete-table':
        return this.deleteTable()
    }
  }

  private editSource(): void {
    const range = this.range()
    if (!range) return
    this.deactivate()
    this.view.dispatch({ effects: setRawTable.of(range), selection: { anchor: range.from + 2 } })
    this.view.focus()
  }

  private deleteTable(): void {
    const range = this.range()
    if (!range) return
    const to = Math.min(range.to + 1, this.view.state.doc.length)
    this.view.dispatch({ changes: { from: range.from, to }, selection: { anchor: range.from }, userEvent: 'delete' })
    this.view.focus()
  }

  // -- Events

  private listen(): void {
    this.wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest('.cm-table-add-row, .cm-table-add-col')) {
        event.preventDefault()
        return
      }
      if (target.closest('input')) return // let the browser place the caret
      event.preventDefault()
      const cell = target.closest<HTMLElement>('th, td')
      if (cell) this.activate(Number(cell.dataset.row), Number(cell.dataset.col), 'end')
      else this.exit('below')
    })
    this.wrap.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('.cm-table-add-row')) this.insertRow(this.rowCount, this.active?.col ?? 0)
      else if (target.closest('.cm-table-add-col')) this.insertColumn(this.colCount, this.active?.row ?? 0)
    })
    // Don't prevent the event: the main process shows spelling suggestions plus table actions.
    this.wrap.addEventListener('contextmenu', (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>('th, td')
      if (!cell) return
      contextCell = { view: this, row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
      this.view.state.facet(noteContext).markTableContextMenu()
    })
  }
}

/** Runs an action chosen from the table context menu on the right-clicked cell. */
export function runTableAction(action: TableAction): void {
  const target = contextCell
  contextCell = null
  if (target && target.view.wrap.isConnected) target.view.run(action, target.row, target.col)
}

/** Applies inline formatting (e.g. "**") to the selection in the focused cell, if any. */
export function formatActiveCell(marker: string): boolean {
  const input = document.activeElement
  if (!(input instanceof HTMLInputElement) || !input.classList.contains('cm-cell-input')) return false
  const { selectionStart: from = 0, selectionEnd: to = 0, value } = input
  const start = from ?? 0
  const end = to ?? 0
  const selected = value.slice(start, end)
  const wrapped = selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= 2 * marker.length
  const replacement = wrapped ? selected.slice(marker.length, -marker.length) : marker + selected + marker
  input.setRangeText(replacement, start, end, 'select')
  if (!selected) input.setSelectionRange(start + marker.length, start + marker.length)
  input.dispatchEvent(new Event('input'))
  return true
}

export function isEditingTableCell(): boolean {
  const el = document.activeElement
  return el instanceof HTMLInputElement && el.classList.contains('cm-cell-input')
}

// ---- Entering a table from the editor ----------------------------------------------------------

function tableViewAt(view: EditorView, pos: number): TableView | null {
  for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>('.cm-table-wrap')) {
    const tableView = tableViews.get(wrap)
    const range = tableView?.range()
    if (tableView && range && pos >= range.from && pos <= range.to) return tableView
  }
  return null
}

/** Arrow up/down into a table: CodeMirror's vertical motion would jump right over it. */
function enterVertically(view: EditorView, forward: boolean): boolean {
  const range = view.state.selection.main
  if (!range.empty) return false
  const head = range.head
  const target = view.moveVertically(range, forward).head
  for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>('.cm-table-wrap')) {
    const tableView = tableViews.get(wrap)
    const table = tableView?.range()
    if (!tableView || !table) continue
    const crossed = forward
      ? head < table.from && target >= table.from
      : head > table.to && target <= table.to
    if (crossed) {
      tableView.activate(forward ? 0 : tableView.rowCount - 1, 0, 'end')
      return true
    }
  }
  return false
}

const enterKeys = Prec.high(
  keymap.of([
    { key: 'ArrowDown', run: (view) => enterVertically(view, true) },
    { key: 'ArrowUp', run: (view) => enterVertically(view, false) }
  ])
)

/**
 * The cursor must never sit inside a rendered table's source (typing there would break it),
 * so a cursor that lands there — e.g. with the left/right arrow keys — moves into a cell.
 */
const redirectCursor = EditorView.updateListener.of((update) => {
  if (!update.selectionSet || update.docChanged) return
  const sel = update.state.selection.main
  if (!sel.empty) return
  const tableView = tableViewAt(update.view, sel.head)
  if (!tableView) return
  const before = update.startState.selection.main.head
  const fromBelow = before > sel.head
  queueMicrotask(() =>
    tableView.activate(fromBelow ? tableView.rowCount - 1 : 0, fromBelow ? tableView.colCount - 1 : 0, 'end')
  )
})

export const tableEditing: Extension = [rawTableField, enterKeys, redirectCursor]

// ---- Insert command --------------------------------------------------------------------------

/** Inserts an empty table with `columns` columns and `rows` body rows and focuses its first cell. */
export function insertTable(columns: number, rows: number): (view: EditorView) => boolean {
  return (view) => {
    const { state } = view
    const model: TableModel = {
      align: Array<Align>(columns).fill(null),
      header: Array.from({ length: columns }, (_, i) => `Column ${i + 1}`),
      rows: Array.from({ length: rows }, () => Array<string>(columns).fill(''))
    }
    const text = serializeTable(model)
    const current = state.doc.lineAt(state.selection.main.head)
    const blank = current.text.trim() === ''
    // A table needs its own lines, separated from surrounding paragraphs by blank lines.
    const from = blank ? current.from : current.to
    let prefix = ''
    if (!blank) prefix = '\n\n'
    else if (current.number > 1 && state.doc.line(current.number - 1).text.trim() !== '') prefix = '\n'
    const next = current.number < state.doc.lines ? state.doc.line(current.number + 1) : null
    const suffix = next && next.text.trim() !== '' ? '\n' : ''
    const tableFrom = from + prefix.length
    pendingFocus.set(view, { from: tableFrom, row: 0, col: 0, caret: 'all' })
    view.dispatch({
      changes: { from, to: current.to, insert: prefix + text + suffix },
      selection: { anchor: tableFrom + text.length },
      scrollIntoView: true,
      userEvent: 'input.table'
    })
    return true
  }
}
