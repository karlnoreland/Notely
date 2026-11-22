import { Facet } from '@codemirror/state'

/** What the editor needs from the app around it. */
export interface NoteContext {
  /** Turns an image path written in the note into a URL the renderer can load. */
  resolveImage(src: string): string
  /** Follows a link (web URL or relative note path). */
  openLink(href: string): void
  /** Stores a pasted image in the vault; returns the path to write in the note, or null. */
  saveImage(file: File): Promise<string | null>
}

const fallback: NoteContext = {
  resolveImage: (src) => src,
  openLink: () => {},
  saveImage: async () => null
}

export const noteContext = Facet.define<NoteContext, NoteContext>({
  combine: (values) => values[0] ?? fallback
})
