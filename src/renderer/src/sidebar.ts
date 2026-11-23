import type { TreeNode } from '../../shared/types'
import { basename, NOTE_EXT, stripNoteExt } from './paths'
import { PATH_MIME, type OpenMode } from './workspace'

export interface FileTreeHandlers {
  /** Click: replace the current tab. Ctrl/Cmd+click or middle click: new tab. Alt+click: split. */
  open(path: string, mode: OpenMode): void
  /** node is null for a right-click on empty space (the vault root). */
  contextMenu(node: TreeNode | null): void
  rename(path: string, newName: string): Promise<void>
  renameEnded(): void
}

const EXPANDED_KEY = 'notely.expandedFolders'

function loadExpanded(): string[] {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

export class FileTree {
  private root: TreeNode | null = null
  private active: string | null = null
  private readonly expanded = new Set(loadExpanded())
  private readonly rows = new Map<string, HTMLElement>()
  private renaming = false

  constructor(
    private readonly el: HTMLElement,
    private readonly handlers: FileTreeHandlers
  ) {
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      handlers.contextMenu(null)
    })
  }

  setTree(root: TreeNode | null): void {
    this.root = root
    this.render()
  }

  setActive(path: string | null): void {
    this.active = path
    if (path) this.expandAncestors(path)
    this.render()
    if (path) this.rows.get(path)?.scrollIntoView({ block: 'nearest' })
  }

  expand(folder: string): void {
    if (!folder) return
    this.expandAncestors(folder)
    this.expanded.add(folder)
    this.persist()
    this.render()
  }

  private expandAncestors(path: string): void {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'))
    this.persist()
  }

  private toggle(folder: string): void {
    if (this.expanded.has(folder)) this.expanded.delete(folder)
    else this.expanded.add(folder)
    this.persist()
    this.render()
  }

  private persist(): void {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...this.expanded]))
    } catch {
      // Storage unavailable: folders just won't stay expanded across restarts.
    }
  }

  render(): void {
    if (this.renaming) return // re-rendered when the rename finishes
    this.rows.clear()
    const children = this.root?.children ?? []
    if (this.root && children.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'tree-empty'
      empty.textContent = 'No notes yet. Press Ctrl+N to create one.'
      this.el.replaceChildren(empty)
      return
    }
    this.el.replaceChildren(...children.map((child) => this.renderNode(child, 0)))
  }

  private renderNode(node: TreeNode, depth: number): HTMLElement {
    const wrap = document.createElement('div')
    const row = document.createElement('div')
    const open = node.kind === 'folder' && this.expanded.has(node.path)
    row.className = `tree-row tree-${node.kind}${node.path === this.active ? ' active' : ''}`
    row.style.paddingLeft = `${8 + depth * 14}px`
    row.title = node.path

    const icon = document.createElement('span')
    icon.className = node.kind === 'folder' ? `tree-icon chevron${open ? ' open' : ''}` : 'tree-icon'
    const label = document.createElement('span')
    label.className = 'tree-label'
    label.textContent = node.kind === 'file' ? stripNoteExt(node.name) : node.name
    row.append(icon, label)

    row.addEventListener('click', (event) => {
      if (node.kind === 'folder') this.toggle(node.path)
      else this.handlers.open(node.path, event.altKey ? 'split' : event.ctrlKey || event.metaKey ? 'tab' : 'replace')
    })
    row.addEventListener('auxclick', (event) => {
      if (event.button === 1 && node.kind === 'file') this.handlers.open(node.path, 'tab')
    })
    if (node.kind === 'file') {
      // Drag a note onto a tab bar or editor pane to open it there.
      row.draggable = true
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(PATH_MIME, node.path)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
      })
    }
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.handlers.contextMenu(node)
    })
    this.rows.set(node.path, row)
    wrap.append(row)

    if (open && node.children?.length) {
      const kids = document.createElement('div')
      kids.className = 'tree-children'
      kids.append(...node.children.map((child) => this.renderNode(child, depth + 1)))
      wrap.append(kids)
    }
    return wrap
  }

  /** Inline rename. Enter or clicking away commits, Escape cancels. */
  startRename(path: string): void {
    const row = this.rows.get(path)
    const label = row?.querySelector<HTMLElement>('.tree-label')
    if (!row || !label) return
    const isFile = row.classList.contains('tree-file')
    const fullName = basename(path)
    const ext = isFile ? (NOTE_EXT.exec(fullName)?.[0] ?? '') : ''
    const initial = fullName.slice(0, fullName.length - ext.length)

    const input = document.createElement('input')
    input.className = 'tree-rename'
    input.value = initial
    input.spellcheck = false
    label.replaceWith(input)
    input.focus()
    input.select()
    this.renaming = true

    let finished = false
    const finish = async (commit: boolean): Promise<void> => {
      if (finished) return
      finished = true
      this.renaming = false
      const value = input.value.trim()
      try {
        if (commit && value && value !== initial) {
          await this.handlers.rename(path, isFile && !NOTE_EXT.test(value) ? value + ext : value)
        }
      } finally {
        this.render()
        this.handlers.renameEnded()
      }
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        void finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void finish(false)
      }
    })
    input.addEventListener('blur', () => void finish(true))
    input.addEventListener('click', (event) => event.stopPropagation())
  }
}
