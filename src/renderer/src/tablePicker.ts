// A small grid popup for choosing a table size: hover (or use the arrow keys) and click/Enter.

const MAX_COLUMNS = 8
const MAX_ROWS = 8

export interface Anchor {
  left: number
  top: number
  bottom: number
}

let close: (() => void) | null = null

export function showTablePicker(anchor: Anchor, onPick: (columns: number, rows: number) => void): void {
  close?.()

  let columns = 3
  let rows = 2
  const popup = document.createElement('div')
  popup.className = 'table-picker'
  popup.tabIndex = -1
  const label = document.createElement('div')
  label.className = 'table-picker-label'
  const grid = document.createElement('div')
  grid.className = 'table-picker-grid'
  grid.style.gridTemplateColumns = `repeat(${MAX_COLUMNS}, 1fr)`

  const cells: HTMLElement[] = []
  // Grid row 0 is the header row; the chosen row count excludes it.
  for (let r = 0; r <= MAX_ROWS; r++) {
    for (let c = 1; c <= MAX_COLUMNS; c++) {
      const cell = document.createElement('div')
      cell.className = r === 0 ? 'table-picker-cell header' : 'table-picker-cell'
      cell.addEventListener('mouseenter', () => {
        columns = c
        rows = Math.max(1, r)
        update()
      })
      cell.addEventListener('mousedown', (event) => event.preventDefault())
      cell.addEventListener('click', () => pick())
      cells.push(cell)
      grid.append(cell)
    }
  }

  function update(): void {
    cells.forEach((cell, i) => {
      const r = Math.floor(i / MAX_COLUMNS)
      const c = (i % MAX_COLUMNS) + 1
      cell.classList.toggle('selected', c <= columns && r <= rows)
    })
    label.textContent = `${columns} × ${rows} table (${columns} ${columns === 1 ? 'column' : 'columns'}, ${rows} ${rows === 1 ? 'row' : 'rows'} + header)`
  }

  function pick(): void {
    const [c, r] = [columns, rows]
    close?.()
    onPick(c, r)
  }

  const onKey = (event: KeyboardEvent): void => {
    const moves: Record<string, [number, number]> = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1]
    }
    if (event.key in moves) {
      const [dc, dr] = moves[event.key]
      columns = Math.min(MAX_COLUMNS, Math.max(1, columns + dc))
      rows = Math.min(MAX_ROWS, Math.max(1, rows + dr))
      update()
    } else if (event.key === 'Enter') {
      pick()
    } else if (event.key === 'Escape') {
      close?.()
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }
  const onOutside = (event: MouseEvent): void => {
    if (!popup.contains(event.target as Node)) close?.()
  }

  popup.append(label, grid)
  document.body.append(popup)
  update()

  // Below the cursor, flipped above it when there is no room; kept inside the window.
  const { width, height } = popup.getBoundingClientRect()
  const top = anchor.bottom + 6 + height > window.innerHeight ? anchor.top - height - 6 : anchor.bottom + 6
  popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`
  popup.style.top = `${Math.max(8, top)}px`

  document.addEventListener('keydown', onKey, true)
  document.addEventListener('mousedown', onOutside, true)
  close = () => {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('mousedown', onOutside, true)
    popup.remove()
    close = null
  }
  popup.focus()
}
