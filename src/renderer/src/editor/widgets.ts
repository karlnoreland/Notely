import { syntaxTree } from '@codemirror/language'
import { EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import { noteContext } from './context'

// ---- KaTeX ---------------------------------------------------------------------------------

const texCache = new Map<string, string>()
const TEX_CACHE_LIMIT = 500

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

export function renderTex(tex: string, display: boolean): string {
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
    readonly alt: string,
    /**
     * Where a click puts the cursor, relative to the widget position: 2 (inside "![") when the
     * widget replaces the source, 0 when it is shown after the visible source while editing.
     */
    readonly offset: number
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.offset === this.offset
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
    editOnMouseDown(wrap, view, this.offset)
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

/** The code inside the fenced block that contains `pos`, without its fences. */
function fencedCodeAt(view: EditorView, pos: number): string {
  const { doc } = view.state
  for (let node = syntaxTree(view.state).resolve(pos, 1); ; node = node.parent!) {
    if (node.name === 'FencedCode') {
      const first = doc.lineAt(node.from).number + 1
      const marks = node.getChildren('CodeMark')
      const closing = marks.length > 1 ? doc.lineAt(marks[marks.length - 1].from).number : 0
      const last = closing > first - 1 ? closing - 1 : doc.lineAt(node.to).number
      const lines: string[] = []
      for (let n = first; n <= last; n++) lines.push(doc.line(n).text)
      return lines.join('\n')
    }
    if (!node.parent) return ''
  }
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>'

/** Language label in the top-right corner of a code block; clicking it copies the code. */
export class CodeCopyWidget extends WidgetType {
  constructor(readonly lang: string) {
    super()
  }

  eq(other: CodeCopyWidget): boolean {
    return other.lang === this.lang
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-code-copy'
    button.title = 'Copy code'
    const label = document.createElement('span')
    label.textContent = this.lang || 'Copy'
    button.innerHTML = COPY_ICON
    button.prepend(label)

    let timer: number | undefined
    // Keep the cursor where it is: don't let the click reach the editor.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', async (event) => {
      event.preventDefault()
      try {
        await navigator.clipboard.writeText(fencedCodeAt(view, view.posAtDOM(button)))
        label.textContent = 'Copied!'
        button.classList.add('copied')
      } catch {
        label.textContent = 'Copy failed'
      }
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        label.textContent = this.lang || 'Copy'
        button.classList.remove('copied')
      }, 1500)
    })
    return button
  }

  ignoreEvent(): boolean {
    return true
  }
}
