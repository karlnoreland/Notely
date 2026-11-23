// Panes, tabs and open documents.
//
// The editor area holds one or two panes side by side (split view). Each pane has a tab bar and
// one CodeMirror view; inactive tabs keep their EditorState (cursor, scroll, undo history) and
// are swapped into the view when selected. Tabs restored from a previous session are loaded
// lazily, when first shown.
//
// The same note may be open in several tabs (typically one per pane). Every edit is mirrored to
// the other copies right away, and the file is saved once per note, not once per tab.

import type { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import type { PopupItem } from '../../shared/types'
import type { NoteContext } from './editor/context'
import { createEditorState, externalChange, setLivePreview } from './editor/setup'
import { basename, isInside, stripNoteExt } from './paths'

export interface WorkspaceHost {
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  writeFileSync(path: string, text: string): boolean
  contextFor(path: () => string | null): NoteContext
  livePreview(): boolean
  popupMenu(items: PopupItem[]): Promise<string | null>
  /** The focused tab or pane changed (title, word count, tree highlight need updating). */
  onActiveChange(): void
  /** A note's text changed (word count). */
  onDocChange(path: string): void
  onSaveState(path: string, state: 'editing' | 'saved' | 'error'): void
  onError(message: string): void
  /** Tabs or panes changed; the session should be persisted. */
  onLayoutChange(): void
}

export type OpenMode = 'replace' | 'tab' | 'split'

export interface SessionPane {
  tabs: string[]
  active: number
}

export interface Session {
  panes: SessionPane[]
  focused: number
  ratio: number
}

const TAB_MIME = 'application/x-notely-tab'
export const PATH_MIME = 'application/x-notely-path'

let nextId = 1

class Tab {
  readonly id = nextId++
  /** Inactive tabs hold their state here; null until first loaded (or for an empty tab). */
  state: EditorState | null = null

  constructor(public path: string | null) {}

  get title(): string {
    return this.path ? stripNoteExt(basename(this.path)) : 'New tab'
  }
}

class Pane {
  readonly id = nextId++
  readonly el: HTMLElement
  readonly tabsEl: HTMLElement
  readonly host: HTMLElement
  readonly empty: HTMLElement
  readonly dropHint: HTMLElement
  readonly view: EditorView
  tabs: Tab[] = []
  active: Tab | null = null

  constructor() {
    this.el = document.createElement('section')
    this.el.className = 'pane'
    this.el.innerHTML = `
      <div class="tab-bar">
        <div class="tabs" role="tablist"></div>
        <button class="tab-bar-btn tab-new" title="New tab (Ctrl+T)" aria-label="New tab">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="tab-bar-btn tab-split" title="Split right (Ctrl+Shift+\\)" aria-label="Split right">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>
        </button>
      </div>
      <div class="editor-host"></div>
      <div class="pane-empty">
        <p>No note open</p>
        <p class="hint">Pick a note in the sidebar, or press <kbd>Ctrl</kbd>+<kbd>N</kbd> to create one.</p>
      </div>
      <div class="pane-drop-hint"></div>`
    this.tabsEl = this.el.querySelector('.tabs')!
    this.host = this.el.querySelector('.editor-host')!
    this.empty = this.el.querySelector('.pane-empty')!
    this.dropHint = this.el.querySelector('.pane-drop-hint')!
    this.view = new EditorView({ parent: this.host })
  }

  get editorState(): EditorState | null {
    return this.active?.path ? this.view.state : null
  }

  stateOf(tab: Tab): EditorState | null {
    return this.active === tab && tab.path ? this.view.state : tab.state
  }
}

interface DocStatus {
  dirty: boolean
  timer?: number
}

export class Workspace {
  readonly panes: Pane[] = []
  private focusedPane: Pane
  private readonly docs = new Map<string, DocStatus>()
  private divider: HTMLElement | null = null
  private ratio = 0.5

  constructor(
    private readonly root: HTMLElement,
    private readonly host: WorkspaceHost
  ) {
    this.focusedPane = this.addPane()
  }

  // ---- Queries -------------------------------------------------------------------------------

  get focused(): Pane {
    return this.focusedPane
  }

  /** The note shown in the focused pane. */
  currentPath(): string | null {
    return this.focusedPane.active?.path ?? null
  }

  /** The focused pane's editor, if it shows a note. */
  focusedView(): EditorView | null {
    return this.focusedPane.editorState ? this.focusedPane.view : null
  }

  /** The editor that holds keyboard focus (including a table cell inside it), else the focused one. */
  activeView(): EditorView | null {
    const el = document.activeElement
    const pane = this.panes.find((p) => el && p.host.contains(el))
    return pane?.editorState ? pane.view : this.focusedView()
  }

  isDirty(path: string): boolean {
    return this.docs.get(path)?.dirty ?? false
  }

  openPaths(): Set<string> {
    const paths = new Set<string>()
    for (const pane of this.panes) for (const tab of pane.tabs) if (tab.path) paths.add(tab.path)
    return paths
  }

  private tabsFor(path: string): { pane: Pane; tab: Tab }[] {
    const found: { pane: Pane; tab: Tab }[] = []
    for (const pane of this.panes) for (const tab of pane.tabs) if (tab.path === path) found.push({ pane, tab })
    return found
  }

  /** The in-memory text of a note, if any loaded tab shows it. */
  textOf(path: string): string | null {
    for (const { pane, tab } of this.tabsFor(path)) {
      const state = pane.stateOf(tab)
      if (state) return state.doc.toString()
    }
    return null
  }

  // ---- Panes ---------------------------------------------------------------------------------

  private addPane(): Pane {
    const pane = new Pane()
    if (this.panes.length) {
      this.divider = document.createElement('div')
      this.divider.className = 'pane-divider'
      this.divider.title = 'Drag to resize'
      this.listenDivider(this.divider)
      this.root.append(this.divider)
    }
    this.root.append(pane.el)
    this.panes.push(pane)
    this.listenPane(pane)
    this.applyRatio()
    this.renderPane(pane)
    return pane
  }

  private removePane(pane: Pane): void {
    if (this.panes.length < 2) return
    pane.view.destroy()
    pane.el.remove()
    this.divider?.remove()
    this.divider = null
    this.panes.splice(this.panes.indexOf(pane), 1)
    for (const p of this.panes) p.el.style.flex = ''
    if (this.focusedPane === pane) this.setFocus(this.panes[0])
    this.host.onLayoutChange()
  }

  private otherPane(create: boolean): Pane | null {
    const other = this.panes.find((p) => p !== this.focusedPane)
    return other ?? (create ? this.addPane() : null)
  }

  private setFocus(pane: Pane): void {
    if (this.focusedPane === pane) return
    this.focusedPane = pane
    for (const p of this.panes) p.el.classList.toggle('focused', p === pane && this.panes.length > 1)
    this.host.onActiveChange()
  }

  private applyRatio(): void {
    const [left, right] = this.panes
    for (const p of this.panes) p.el.classList.toggle('focused', p === this.focusedPane && this.panes.length > 1)
    if (!right) {
      left.el.style.flex = ''
      return
    }
    left.el.style.flex = `${this.ratio} 1 0`
    right.el.style.flex = `${1 - this.ratio} 1 0`
  }

  // ---- Opening, activating and closing tabs --------------------------------------------------

  private createState(tab: Tab, text: string): EditorState {
    return createEditorState(text, {
      context: this.host.contextFor(() => tab.path),
      livePreview: this.host.livePreview(),
      onChange: (update) => this.mirror(tab, update)
    })
  }

  /**
   * Opens a note: 'replace' reuses the focused tab, 'tab' adds a tab, 'split' opens it in the
   * other pane (creating it). A note already open in the target pane is just selected.
   */
  async openFile(path: string, mode: OpenMode = 'replace', target?: Pane): Promise<void> {
    const pane = target ?? (mode === 'split' ? this.otherPane(true)! : this.focusedPane)
    const existing = pane.tabs.find((t) => t.path === path)
    if (existing) return this.activate(pane, existing)

    let text = this.textOf(path)
    if (text === null) {
      try {
        text = await this.host.readFile(path)
      } catch (err) {
        this.host.onError(`Could not open ${basename(path)}: ${err instanceof Error ? err.message : err}`)
        return
      }
    }
    let tab: Tab
    if (mode === 'replace' && pane.active) {
      tab = pane.active
      const previous = tab.path
      if (previous && this.isDirty(previous) && this.tabsFor(previous).length === 1) await this.save(previous)
      tab.path = path
    } else {
      tab = new Tab(path)
      const at = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length
      pane.tabs.splice(at, 0, tab)
    }
    tab.state = this.createState(tab, text)
    if (pane.active === tab) pane.active = null // force the view to take the new state
    await this.activate(pane, tab)
  }

  /** Opens an empty tab in the focused pane. */
  newTab(target?: Pane): void {
    const pane = target ?? this.focusedPane
    const tab = new Tab(null)
    const at = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length
    pane.tabs.splice(at, 0, tab)
    void this.activate(pane, tab)
  }

  async activate(pane: Pane, tab: Tab, focus = true): Promise<void> {
    if (pane.active && pane.active !== tab && pane.active.path) pane.active.state = pane.view.state
    if (tab.path && !tab.state) {
      // Restored tab shown for the first time.
      const path = tab.path
      let text = this.textOf(path)
      if (text === null) {
        try {
          text = await this.host.readFile(path)
        } catch {
          this.closeTab(pane, tab, false)
          return
        }
      }
      if (tab.path !== path || !pane.tabs.includes(tab)) return
      tab.state = this.createState(tab, text)
    }
    pane.active = tab
    if (tab.path && tab.state) {
      pane.view.setState(tab.state)
      setLivePreview(pane.view, this.host.livePreview())
    }
    this.renderPane(pane)
    if (focus || !this.panes.includes(this.focusedPane)) this.focusedPane = pane
    this.applyRatio()
    if (focus && tab.path) pane.view.focus()
    this.host.onActiveChange()
    this.host.onLayoutChange()
  }

  /** Closes a tab; the pane closes when its last tab goes (unless it is the only pane). */
  async closeTab(pane: Pane, tab: Tab, saveFirst = true): Promise<void> {
    const path = tab.path
    if (saveFirst && path && this.isDirty(path) && this.tabsFor(path).length === 1) await this.save(path)
    const index = pane.tabs.indexOf(tab)
    if (index < 0) return
    if (pane.active === tab && tab.path) tab.state = pane.view.state
    pane.tabs.splice(index, 1)
    if (path && !this.tabsFor(path).length && !this.isDirty(path)) this.docs.delete(path)
    if (pane.active !== tab) {
      this.renderPane(pane)
      this.host.onLayoutChange()
      return
    }
    pane.active = null
    const next = pane.tabs[index] ?? pane.tabs[index - 1]
    if (next) await this.activate(pane, next)
    else if (this.panes.length > 1) this.removePane(pane)
    else {
      this.renderPane(pane)
      this.host.onActiveChange()
      this.host.onLayoutChange()
    }
  }

  closeActiveTab(): void {
    const pane = this.focusedPane
    if (pane.active) void this.closeTab(pane, pane.active)
  }

  cycleTab(step: number): void {
    const pane = this.focusedPane
    if (pane.tabs.length < 2 || !pane.active) return
    const i = pane.tabs.indexOf(pane.active)
    void this.activate(pane, pane.tabs[(i + step + pane.tabs.length) % pane.tabs.length])
  }

  /** Opens the focused note in the other pane (creating the split if needed). */
  async splitRight(): Promise<void> {
    const path = this.currentPath()
    const target = this.otherPane(true)!
    if (path) await this.openFile(path, 'tab', target)
    else this.newTab(target)
  }

  /** Merges the right pane's tabs into the left one and removes the split. */
  async closeSplit(): Promise<void> {
    if (this.panes.length < 2) return
    const [left, right] = this.panes
    for (const tab of [...right.tabs]) {
      if (right.active === tab && tab.path) tab.state = right.view.state
      if (!tab.path || left.tabs.some((t) => t.path === tab.path)) continue
      left.tabs.push(tab)
    }
    right.tabs = []
    right.active = null
    this.removePane(right)
    this.renderPane(left)
    if (left.active) await this.activate(left, left.active)
  }

  private async moveTab(from: Pane, tab: Tab, to: Pane, index: number): Promise<void> {
    if (from === to) {
      const old = from.tabs.indexOf(tab)
      from.tabs.splice(old, 1)
      from.tabs.splice(index > old ? index - 1 : index, 0, tab)
      this.renderPane(from)
      this.host.onLayoutChange()
      return
    }
    const duplicate = to.tabs.find((t) => t.path && t.path === tab.path)
    if (from.active === tab && tab.path) tab.state = from.view.state
    // Detach from the source pane without saving or dropping its document.
    const old = from.tabs.indexOf(tab)
    from.tabs.splice(old, 1)
    if (from.active === tab) {
      from.active = null
      const next = from.tabs[old] ?? from.tabs[old - 1]
      if (next) await this.activate(from, next, false)
      else if (this.panes.length > 1) this.removePane(from)
      else this.renderPane(from)
    }
    if (duplicate) return this.activate(to, duplicate)
    to.tabs.splice(Math.min(index, to.tabs.length), 0, tab)
    to.active = null
    await this.activate(to, tab)
  }

  // ---- Documents: mirroring, saving, external changes ----------------------------------------

  /** Applies an edit made in one tab to every other tab showing the same note. */
  private mirror(source: Tab, update: ViewUpdate): void {
    const path = source.path
    if (!path) return
    for (const { pane, tab } of this.tabsFor(path)) {
      if (tab === source) continue
      const spec = { changes: update.changes, annotations: externalChange.of(true) }
      if (pane.active === tab) pane.view.dispatch(spec)
      else if (tab.state) tab.state = tab.state.update(spec).state
    }
    this.markDirty(path)
  }

  private markDirty(path: string): void {
    let doc = this.docs.get(path)
    if (!doc) this.docs.set(path, (doc = { dirty: false }))
    doc.dirty = true
    clearTimeout(doc.timer)
    doc.timer = window.setTimeout(() => void this.save(path), 500)
    this.updateDirtyMarkers()
    this.host.onSaveState(path, 'editing')
    this.host.onDocChange(path)
  }

  async save(path: string): Promise<void> {
    const doc = this.docs.get(path)
    if (!doc) return
    clearTimeout(doc.timer)
    if (!doc.dirty) return
    const text = this.textOf(path)
    if (text === null) return
    doc.dirty = false
    try {
      await this.host.writeFile(path, text)
      if (!doc.dirty) this.host.onSaveState(path, 'saved')
    } catch (err) {
      doc.dirty = true
      this.host.onSaveState(path, 'error')
      this.host.onError(`Could not save ${basename(path)}: ${err instanceof Error ? err.message : err}`)
    }
    if (!doc.dirty && !this.tabsFor(path).length) this.docs.delete(path)
    this.updateDirtyMarkers()
  }

  async saveMatching(match: (path: string) => boolean): Promise<void> {
    await Promise.all([...this.docs.keys()].filter(match).map((p) => this.save(p)))
  }

  saveAll(): Promise<void> {
    return this.saveMatching(() => true)
  }

  /** Blocking save of everything unsaved, for when the window is closing. */
  flushSync(): void {
    for (const [path, doc] of this.docs) {
      const text = doc.dirty ? this.textOf(path) : null
      if (text !== null && this.host.writeFileSync(path, text)) doc.dirty = false
    }
  }

  /** Replaces a note's text in every tab after it changed on disk. */
  applyExternal(path: string, text: string): void {
    for (const { pane, tab } of this.tabsFor(path)) {
      const state = pane.stateOf(tab)
      if (!state || state.doc.toString() === text) continue
      const spec = { changes: { from: 0, to: state.doc.length, insert: text }, annotations: externalChange.of(true) }
      if (pane.active === tab) pane.view.dispatch(spec)
      else tab.state = state.update(spec).state
    }
  }

  /** Updates tabs after a file or folder was renamed. */
  renamePath(from: string, to: string): void {
    const remap = (p: string): string => (p === from ? to : `${to}${p.slice(from.length)}`)
    for (const pane of this.panes) for (const tab of pane.tabs) if (tab.path && isInside(tab.path, from)) tab.path = remap(tab.path)
    for (const [path, doc] of [...this.docs]) {
      if (isInside(path, from)) {
        this.docs.delete(path)
        this.docs.set(remap(path), doc)
      }
    }
    for (const pane of this.panes) this.renderPane(pane)
    this.host.onActiveChange()
    this.host.onLayoutChange()
  }

  /** Closes, without saving, every tab whose note matches (e.g. after it was deleted). */
  async closeMatching(match: (path: string) => boolean): Promise<void> {
    for (const path of [...this.docs.keys()]) {
      if (match(path)) {
        clearTimeout(this.docs.get(path)?.timer)
        this.docs.delete(path)
      }
    }
    for (const pane of [...this.panes]) {
      for (const tab of [...pane.tabs]) if (tab.path && match(tab.path)) await this.closeTab(pane, tab, false)
    }
  }

  /** Closes everything (when switching vaults). Callers save first. */
  reset(): void {
    for (const doc of this.docs.values()) clearTimeout(doc.timer)
    this.docs.clear()
    while (this.panes.length > 1) {
      const last = this.panes[this.panes.length - 1]
      last.tabs = []
      this.removePane(last)
    }
    const pane = this.panes[0]
    pane.tabs = []
    pane.active = null
    this.focusedPane = pane
    this.renderPane(pane)
    this.host.onActiveChange()
  }

  setLivePreview(enabled: boolean): void {
    for (const pane of this.panes) if (pane.editorState) setLivePreview(pane.view, enabled)
  }

  // ---- Session -------------------------------------------------------------------------------

  session(): Session {
    return {
      panes: this.panes.map((pane) => {
        const tabs = pane.tabs.filter((t) => t.path)
        return { tabs: tabs.map((t) => t.path!), active: Math.max(0, tabs.indexOf(pane.active!)) }
      }),
      focused: Math.max(0, this.panes.indexOf(this.focusedPane)),
      ratio: this.ratio
    }
  }

  /** Reopens a saved session; only `exists` paths are restored, and only active tabs load now. */
  async restore(session: Session, exists: (path: string) => boolean): Promise<boolean> {
    const specs = session.panes
      .map((p) => ({ tabs: p.tabs.filter(exists), active: p.active }))
      .filter((p) => p.tabs.length)
      .slice(0, 2)
    if (!specs.length) return false
    this.ratio = Math.min(0.85, Math.max(0.15, session.ratio || 0.5))
    if (specs.length > 1 && this.panes.length < 2) this.addPane()
    for (let i = 0; i < specs.length; i++) {
      const pane = this.panes[i]
      pane.tabs = specs[i].tabs.map((p) => new Tab(p))
      pane.active = null
    }
    const focusIndex = Math.min(session.focused, specs.length - 1)
    for (let i = 0; i < specs.length; i++) {
      if (i === focusIndex) continue
      const pane = this.panes[i]
      await this.activate(pane, pane.tabs[Math.min(specs[i].active, pane.tabs.length - 1)], false)
    }
    const pane = this.panes[focusIndex]
    await this.activate(pane, pane.tabs[Math.min(specs[focusIndex].active, pane.tabs.length - 1)])
    return true
  }

  // ---- Rendering -----------------------------------------------------------------------------

  private renderPane(pane: Pane): void {
    const showing = !!pane.active?.path
    pane.host.hidden = !showing
    pane.empty.hidden = showing
    pane.tabsEl.replaceChildren(
      ...pane.tabs.map((tab) => {
        const el = document.createElement('div')
        el.className = `tab${tab === pane.active ? ' active' : ''}${tab.path && this.isDirty(tab.path) ? ' dirty' : ''}`
        el.setAttribute('role', 'tab')
        el.draggable = true
        el.title = tab.path ?? 'New tab'
        el.dataset.tab = String(tab.id)
        const title = document.createElement('span')
        title.className = 'tab-title'
        title.textContent = tab.title
        const close = document.createElement('button')
        close.className = 'tab-close'
        close.title = 'Close (Ctrl+W)'
        close.setAttribute('aria-label', 'Close tab')
        close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
        el.append(title, close)
        return el
      })
    )
  }

  private updateDirtyMarkers(): void {
    for (const pane of this.panes) {
      for (const el of pane.tabsEl.querySelectorAll<HTMLElement>('.tab')) {
        const tab = pane.tabs.find((t) => String(t.id) === el.dataset.tab)
        el.classList.toggle('dirty', !!tab?.path && this.isDirty(tab.path))
      }
    }
  }

  // ---- Events --------------------------------------------------------------------------------

  private tabFromEvent(pane: Pane, event: Event): Tab | null {
    const el = (event.target as HTMLElement).closest<HTMLElement>('.tab')
    return el ? (pane.tabs.find((t) => String(t.id) === el.dataset.tab) ?? null) : null
  }

  private listenPane(pane: Pane): void {
    pane.el.addEventListener('focusin', () => this.setFocus(pane))
    pane.el.addEventListener('mousedown', () => this.setFocus(pane), true)

    pane.tabsEl.addEventListener('mousedown', (event) => {
      const tab = this.tabFromEvent(pane, event)
      if (!tab) return
      if (event.button === 1) event.preventDefault() // no autoscroll
      if (event.button === 0 && !(event.target as HTMLElement).closest('.tab-close')) void this.activate(pane, tab)
    })
    pane.tabsEl.addEventListener('click', (event) => {
      const tab = this.tabFromEvent(pane, event)
      if (tab && (event.target as HTMLElement).closest('.tab-close')) void this.closeTab(pane, tab)
    })
    pane.tabsEl.addEventListener('auxclick', (event) => {
      const tab = this.tabFromEvent(pane, event)
      if (tab && event.button === 1) void this.closeTab(pane, tab)
    })
    pane.tabsEl.addEventListener('contextmenu', (event) => {
      const tab = this.tabFromEvent(pane, event)
      if (tab) {
        event.preventDefault()
        void this.tabMenu(pane, tab)
      }
    })
    pane.tabsEl.addEventListener('dblclick', (event) => {
      if (event.target === pane.tabsEl) this.newTab(pane)
    })
    pane.el.querySelector('.tab-new')!.addEventListener('click', () => this.newTab(pane))
    pane.el.querySelector('.tab-split')!.addEventListener('click', () => {
      this.setFocus(pane)
      void this.splitRight()
    })

    // Drag tabs to reorder or move them; drag tabs or sidebar notes onto a pane to open them.
    pane.tabsEl.addEventListener('dragstart', (event) => {
      const tab = this.tabFromEvent(pane, event)
      if (!tab || !event.dataTransfer) return
      event.dataTransfer.setData(TAB_MIME, `${pane.id}:${tab.id}`)
      if (tab.path) event.dataTransfer.setData(PATH_MIME, tab.path)
      event.dataTransfer.effectAllowed = 'move'
    })
    const dropIndex = (event: DragEvent): number => {
      const tabs = [...pane.tabsEl.querySelectorAll<HTMLElement>('.tab')]
      const i = tabs.findIndex((el) => {
        const r = el.getBoundingClientRect()
        return event.clientX < r.left + r.width / 2
      })
      return i < 0 ? tabs.length : i
    }
    const clearMarkers = (): void => {
      for (const el of pane.tabsEl.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after')
    }
    const bar = pane.el.querySelector<HTMLElement>('.tab-bar')!
    bar.addEventListener('dragover', (event) => {
      if (!this.acceptsDrag(event)) return
      event.preventDefault()
      clearMarkers()
      const tabs = pane.tabsEl.querySelectorAll<HTMLElement>('.tab')
      const i = dropIndex(event)
      if (tabs[i]) tabs[i].classList.add('drop-before')
      else tabs[tabs.length - 1]?.classList.add('drop-after')
    })
    bar.addEventListener('dragleave', clearMarkers)
    bar.addEventListener('drop', (event) => {
      clearMarkers()
      if (!this.acceptsDrag(event)) return
      event.preventDefault()
      void this.handleDrop(event, pane, dropIndex(event), false)
    })

    // On the editor area: the right edge of a single pane creates a split.
    const splitZone = (event: DragEvent): boolean => {
      const r = pane.el.getBoundingClientRect()
      return this.panes.length === 1 && event.clientX > r.left + r.width * 0.65
    }
    const onAreaDragOver = (event: DragEvent): void => {
      if (!this.acceptsDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      pane.dropHint.className = `pane-drop-hint ${splitZone(event) ? 'split' : 'whole'}`
    }
    const hideHint = (): void => {
      pane.dropHint.className = 'pane-drop-hint'
    }
    for (const area of [pane.host, pane.empty, pane.dropHint]) {
      // Capture phase, so CodeMirror never treats a tab or note as dropped text.
      area.addEventListener('dragover', onAreaDragOver, true)
      area.addEventListener(
        'drop',
        (event) => {
          if (!this.acceptsDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          const split = splitZone(event)
          hideHint()
          void this.handleDrop(event, pane, pane.tabs.length, split)
        },
        true
      )
    }
    pane.el.addEventListener('dragleave', (event) => {
      if (!pane.el.contains(event.relatedTarget as Node | null)) hideHint()
    })
    pane.el.addEventListener('dragend', hideHint)
  }

  private acceptsDrag(event: DragEvent): boolean {
    const types = event.dataTransfer?.types ?? []
    return types.includes(TAB_MIME) || types.includes(PATH_MIME)
  }

  private async handleDrop(event: DragEvent, pane: Pane, index: number, split: boolean): Promise<void> {
    const data = event.dataTransfer
    if (!data) return
    const target = split ? this.addPane() : pane
    const tabRef = data.getData(TAB_MIME)
    if (tabRef) {
      const [paneId, tabId] = tabRef.split(':').map(Number)
      const from = this.panes.find((p) => p.id === paneId)
      const tab = from?.tabs.find((t) => t.id === tabId)
      if (from && tab) return this.moveTab(from, tab, target, index)
    }
    const path = data.getData(PATH_MIME)
    if (path) {
      this.setFocus(target)
      await this.openFile(path, 'tab', target)
    }
  }

  private async tabMenu(pane: Pane, tab: Tab): Promise<void> {
    const index = pane.tabs.indexOf(tab)
    const two = this.panes.length > 1
    const choice = await this.host.popupMenu([
      { id: 'close', label: 'Close' },
      { id: 'others', label: 'Close Others', enabled: pane.tabs.length > 1 },
      { id: 'right', label: 'Close Tabs to the Right', enabled: index < pane.tabs.length - 1 },
      { separator: true },
      { id: 'move', label: two ? 'Move to Other Pane' : 'Move to New Split', enabled: !!tab.path || two },
      { id: 'split', label: 'Open in Split', enabled: !!tab.path }
    ])
    switch (choice) {
      case 'close':
        return this.closeTab(pane, tab)
      case 'others':
        for (const t of pane.tabs.filter((t) => t !== tab)) await this.closeTab(pane, t)
        return
      case 'right':
        for (const t of pane.tabs.slice(index + 1)) await this.closeTab(pane, t)
        return
      case 'move': {
        const other = this.panes.find((p) => p !== pane) ?? this.addPane()
        return this.moveTab(pane, tab, other, other.tabs.length)
      }
      case 'split':
        this.setFocus(pane)
        if (pane.active !== tab) await this.activate(pane, tab)
        return this.splitRight()
    }
  }

  private listenDivider(divider: HTMLElement): void {
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      divider.setPointerCapture(event.pointerId)
      document.body.classList.add('resizing-panes')
      const box = this.root.getBoundingClientRect()
      const onMove = (e: PointerEvent): void => {
        this.ratio = Math.min(0.85, Math.max(0.15, (e.clientX - box.left) / box.width))
        this.applyRatio()
      }
      const onUp = (): void => {
        divider.removeEventListener('pointermove', onMove)
        divider.removeEventListener('pointerup', onUp)
        document.body.classList.remove('resizing-panes')
        this.host.onLayoutChange()
      }
      divider.addEventListener('pointermove', onMove)
      divider.addEventListener('pointerup', onUp)
    })
    divider.addEventListener('dblclick', () => {
      this.ratio = 0.5
      this.applyRatio()
      this.host.onLayoutChange()
    })
  }
}
