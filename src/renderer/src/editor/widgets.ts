import { EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import { noteContext } from './context'

// ---- KaTeX ---------------------------------------------------------------------------------

const texCache = new Map<string, string>()
const TEX_CACHE_LIMIT = 500

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function renderTex(tex: string, display: boolean): string {
  const key = (display ? 'D' : 'I') + tex
  let html = texCache.get(key)
  if (html !== undefined) return html
  if (!tex.trim()) {
    html = '<span class="cm-math-empty">empty math</span>'
  } else {
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore' })
    } catch (err) {
      html = `<span class="cm-math-error">${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`
    }
  }
  if (texCache.size >= TEX_CACHE_LIMIT) {
    const oldest = texCache.keys().next().value
    if (oldest !== undefined) texCache.delete(oldest)
  }
  texCache.set(key, html)
  return html
}

/** Clicking a rendered element puts the cursor inside its source, which reveals it. */
function editOnMouseDown(el: HTMLElement, view: EditorView, offset: number): void {
  el.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const pos = view.posAtDOM(el)
    view.dispatch({ selection: { anchor: Math.min(pos + offset, view.state.doc.length) } })
    view.focus()
  })
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** Length of the opening delimiter, so a click lands inside the math. */
    readonly offset: number,
    /** Replaces whole lines (a block widget) rather than sitting inside a line. */
    readonly block: boolean
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display && other.block === this.block
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? 'div' : 'span')
    el.className = this.display ? 'cm-math-rendered cm-math-display' : 'cm-math-rendered'
    el.innerHTML = renderTex(this.tex, this.display)
    editOnMouseDown(el, view, this.offset)
    return el
  }

  get estimatedHeight(): number {
    return this.block ? 56 : -1
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---- Images --------------------------------------------------------------------------------

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image-wrap'
    const img = document.createElement('img')
    img.className = 'cm-image'
    img.alt = this.alt
    img.src = view.state.facet(noteContext).resolveImage(this.src)
    img.addEventListener('load', () => view.requestMeasure())
    img.addEventListener('error', () => {
      const fallback = document.createElement('span')
      fallback.className = 'cm-image-error'
      fallback.textContent = `Image not found: ${this.alt || this.src}`
      img.replaceWith(fallback)
      view.requestMeasure()
    })
    wrap.append(img)
    editOnMouseDown(wrap, view, 2)
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---- Lists, rules, code labels -------------------------------------------------------------

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task-checkbox'
    box.checked = this.checked
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const pos = view.posAtDOM(box)
      const marker = view.state.sliceDoc(pos, pos + 3)
      view.dispatch({
        changes: { from: pos, to: pos + 3, insert: /x/i.test(marker) ? '[ ]' : '[x]' },
        userEvent: 'input.toggle'
      })
    })
    // The document change re-renders the checkbox; don't let the browser toggle it as well.
    box.addEventListener('click', (event) => event.preventDefault())
    return box
  }

  ignoreEvent(): boolean {
    return true
  }
}

export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-bullet'
    el.textContent = '•'
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

export class HrWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-hr'
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

export class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super()
  }

  eq(other: CodeLangWidget): boolean {
    return other.lang === this.lang
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-code-lang'
    el.textContent = this.lang
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}
