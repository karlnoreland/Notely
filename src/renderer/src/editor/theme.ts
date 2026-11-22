import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// Colors come from CSS variables in styles.css so light/dark follow the system theme.
export const notelyHighlight = HighlightStyle.define([
  // Markdown
  { tag: t.heading, fontWeight: '700', color: 'var(--heading)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.url, color: 'var(--text-muted)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: t.quote, color: 'var(--text-muted)' },
  { tag: t.labelName, color: 'var(--text-muted)' },
  // Syntax markers (#, **, `, >, -, $$) — defined after heading so they win inside headings
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--formatting)', fontWeight: 'normal' },

  // Code and LaTeX
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.definition(t.variableName), t.special(t.variableName)], color: 'var(--syn-variable)' },
  { tag: [t.operator, t.escape], color: 'var(--syn-operator)' },
  { tag: [t.meta, t.annotation], color: 'var(--syn-meta)' },
  { tag: [t.bracket, t.brace, t.paren, t.squareBracket], color: 'var(--syn-bracket)' },
  { tag: t.invalid, color: 'var(--syn-invalid)' }
])

/** Only what must beat CodeMirror's own base theme; the rest lives in styles.css. */
export const notelyTheme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection)'
  },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-selected)' }
})
