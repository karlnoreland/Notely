import { EditorSelection, type ChangeSpec, type EditorState, type StateCommand } from '@codemirror/state'

/** Each line touched by the selection, once. */
function selectedLines(state: EditorState) {
  const seen = new Set<number>()
  const lines = []
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos)
      if (!seen.has(line.number)) {
        seen.add(line.number)
        lines.push(line)
      }
      pos = line.to + 1
    }
  }
  return lines
}

/** Wraps the selection (or the word at the cursor) in `marker`, or unwraps it if already wrapped. */
export function toggleInline(marker: string): StateCommand {
  const len = marker.length
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - len, range.from)
      const after = state.sliceDoc(range.to, range.to + len)
      // For italic "*", text inside "**bold**" is not italic-wrapped.
      const insideBold =
        marker === '*' &&
        state.sliceDoc(range.from - 2, range.from) === '**' &&
        state.sliceDoc(range.from - 3, range.from) !== '***'
      if (before === marker && after === marker && !insideBold) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len }
          ],
          range: EditorSelection.range(range.from - len, range.to - len)
        }
      }
      const text = state.sliceDoc(range.from, range.to)
      if (text.length >= 2 * len && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: [
            { from: range.from, to: range.from + len },
            { from: range.to - len, to: range.to }
          ],
          range: EditorSelection.range(range.from, range.to - 2 * len)
        }
      }
      if (range.empty) {
        const word = state.wordAt(range.head)
        if (word) {
          return {
            changes: [
              { from: word.from, insert: marker },
              { from: word.to, insert: marker }
            ],
            range: EditorSelection.cursor(range.head + len)
          }
        }
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker }
        ],
        range: EditorSelection.range(range.from + len, range.to + len)
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

/** Sets the heading level of the selected lines; the same level again turns it back into text. */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = []
    for (const line of selectedLines(state)) {
      const match = /^\s{0,3}(#{1,6})[ \t]+/.exec(line.text) ?? /^\s{0,3}(#{1,6})$/.exec(line.text)
      const current = match ? match[1].length : 0
      const insert = level === 0 || current === level ? '' : `${'#'.repeat(level)} `
      changes.push({ from: line.from, to: line.from + (match ? match[0].length : 0), insert })
    }
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

/** Plain line -> "- [ ] ", list item -> task, unchecked <-> checked. */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  const changes: ChangeSpec[] = []
  for (const line of selectedLines(state)) {
    const task = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(line.text)
    if (task) {
      const at = line.from + task[1].length + 1
      changes.push({ from: at, to: at + 1, insert: task[2] === ' ' ? 'x' : ' ' })
      continue
    }
    const list = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line.text)
    if (list) {
      changes.push({ from: line.from + list[1].length, insert: '[ ] ' })
    } else {
      const indent = /^\s*/.exec(line.text)![0].length
      changes.push({ from: line.from + indent, insert: '- [ ] ' })
    }
  }
  dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.format' }))
  return true
}

/** [selection](|) — or [|]() when nothing is selected. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to)
    const insert = `[${text}]()`
    const cursor = text ? range.from + text.length + 3 : range.from + 1
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(cursor) }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  return true
}
