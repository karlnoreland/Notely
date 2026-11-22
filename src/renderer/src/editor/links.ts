import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { noteContext } from './context'

function hrefAt(view: EditorView, pos: number): string | null {
  const { doc } = view.state
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolve(pos, 1); node; node = node.parent) {
    if (node.name === 'URL') return doc.sliceString(node.from, node.to)
    if (node.name === 'Link' || node.name === 'Image' || node.name === 'Autolink') {
      const url = node.getChild('URL')
      return url ? doc.sliceString(url.from, url.to) : null
    }
  }
  return null
}

/** Ctrl+Click (Cmd+Click on macOS) follows a link; a plain click places the cursor to edit it. */
export const linkClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return false
    const href = hrefAt(view, pos)
    if (!href) return false
    event.preventDefault()
    view.state.facet(noteContext).openLink(href.replace(/^<|>$/g, ''))
    return true
  }
})
