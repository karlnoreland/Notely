import { acceptCompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view'
import { completions } from './completion'
import { noteContext, type NoteContext } from './context'
import { linkClickHandler } from './links'
import { livePreview } from './livePreview'
import { mathExtension } from './math'
import { imagePaste } from './paste'
import { notelyHighlight, notelyTheme } from './theme'

/** Marks transactions that load content from disk, so they don't trigger a save. */
export const externalChange = Annotation.define<boolean>()

const previewMode = new Compartment()

// Ctrl/Cmd+I (italic) and Ctrl/Cmd+L (task) belong to the app menu, not CodeMirror's defaults.
const MENU_KEYS = new Set(['Mod-i', 'Mod-l'])
const editorKeymap = defaultKeymap.filter((binding) => !binding.key || !MENU_KEYS.has(binding.key))

export interface EditorOptions {
  context: NoteContext
  livePreview: boolean
  onChange: () => void
}

export function createEditorState(doc: string, options: EditorOptions): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [mathExtension] }),
      syntaxHighlighting(notelyHighlight),
      search({ top: true }),
      completions,
      // Tab accepts a suggestion when the popup is open, otherwise indents.
      keymap.of([{ key: 'Tab', run: acceptCompletion }, ...searchKeymap, ...historyKeymap, ...editorKeymap, indentWithTab]),
      // CodeMirror turns the browser spellchecker off by default; Notely relies on it.
      EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
      noteContext.of(options.context),
      linkClickHandler,
      imagePaste,
      previewMode.of(options.livePreview ? livePreview : []),
      notelyTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(externalChange))) {
          options.onChange()
        }
      })
    ]
  })
}

export function setLivePreview(view: EditorView, enabled: boolean): void {
  view.dispatch({ effects: previewMode.reconfigure(enabled ? livePreview : []) })
}
