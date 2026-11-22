import { EditorView } from '@codemirror/view'
import { noteContext } from './context'

function imageFiles(data: DataTransfer | null): File[] {
  return data ? [...data.files].filter((file) => file.type.startsWith('image/')) : []
}

async function insertImages(view: EditorView, files: File[], pos: number): Promise<void> {
  const context = view.state.facet(noteContext)
  const links: string[] = []
  for (const file of files) {
    const path = await context.saveImage(file)
    if (path) links.push(`![](${path})`)
  }
  if (!links.length) return
  const at = Math.min(pos, view.state.doc.length)
  const text = links.join('\n')
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    scrollIntoView: true,
    userEvent: 'input.paste'
  })
  view.focus()
}

/** Pasting or dropping image files saves them into the vault and inserts Markdown image links. */
export const imagePaste = EditorView.domEventHandlers({
  paste(event, view) {
    const files = imageFiles(event.clipboardData)
    if (!files.length) return false
    event.preventDefault()
    void insertImages(view, files, view.state.selection.main.head)
    return true
  },
  drop(event, view) {
    const files = imageFiles(event.dataTransfer)
    if (!files.length) return false
    event.preventDefault()
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
    void insertImages(view, files, pos)
    return true
  }
})
