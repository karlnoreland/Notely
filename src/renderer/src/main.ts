import 'katex/dist/katex.min.css'
import './styles.css'

import { redo, undo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { MenuCommand, TreeNode } from '../../shared/types'
import { insertLink, setHeading, toggleInline, toggleTask } from './editor/commands'
import type { NoteContext } from './editor/context'
import { createEditorState, externalChange, setLivePreview } from './editor/setup'
import { insertTable } from './editor/table'
import { basename, dirname, isInside, NOTE_EXT, relativePath, resolvePath, stripNoteExt, vaultUrl } from './paths'
import { FileTree } from './sidebar'
import { showTablePicker } from './tablePicker'

const api = window.notely

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const ui = {
  app: byId('app'),
  welcome: byId('welcome'),
  vaultName: byId('vault-name'),
  tree: byId('file-tree'),
  editor: byId('editor'),
  empty: byId('empty-state'),
  title: byId('note-title'),
  saveState: byId('save-state'),
  wordCount: byId('word-count'),
  modeToggle: byId<HTMLButtonElement>('mode-toggle'),
  toast: byId('toast'),
  sidebar: byId('sidebar'),
  resizer: byId('sidebar-resizer')
}

document.body.classList.add(`platform-${api.platform}`)

// ---- Preferences (per machine, UI only) ------------------------------------------------------

function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`notely.${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`notely.${key}`, JSON.stringify(value))
  } catch {
    // Not persisted; harmless.
  }
}

// ---- State ------------------------------------------------------------------------------------

let vaultTree: TreeNode | null = null
let current: string | null = null
let dirty = false
let saveTimer: number | undefined
let livePreview = readPref('livePreview', true)
/** Editor states of recently opened notes, so switching back keeps undo history and cursor. */
const stateCache = new Map<string, EditorState>()
const STATE_CACHE_LIMIT = 20

const context: NoteContext = {
  resolveImage(src) {
    if (/^(https?:|data:|vault:)/i.test(src)) return src
    let target = src.trim().replace(/^<|>$/g, '')
    try {
      target = decodeURI(target)
    } catch {
      // Keep as written.
    }
    const rel = resolvePath(current ? dirname(current) : '', target)
    return rel === null ? '' : vaultUrl(rel)
  },
  openLink(href) {
    void followLink(href)
  },
  async saveImage(file) {
    if (!current) return null
    const ext = IMAGE_TYPES[file.type] ?? /\.([a-z0-9]+)$/i.exec(file.name)?.[1]
    if (!ext) {
      toast(`Unsupported image type: ${file.type || file.name}`)
      return null
    }
    try {
      const saved = await api.saveAttachment(ext, new Uint8Array(await file.arrayBuffer()))
      return relativePath(dirname(current), saved)
        .split('/')
        .map(encodeURIComponent)
        .join('/')
    } catch (err) {
      toast(`Could not save image: ${errorMessage(err)}`)
      return null
    }
  }
}

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif'
}

const view = new EditorView({ parent: ui.editor })

function newEditorState(doc: string): EditorState {
  return createEditorState(doc, { context, livePreview, onChange: handleDocChanged })
}

// ---- Feedback ---------------------------------------------------------------------------------

let toastTimer: number | undefined
function toast(message: string): void {
  ui.toast.textContent = message
  ui.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (ui.toast.hidden = true), 4000)
}

/** IPC errors arrive as "Error invoking remote method 'x': Error: message". */
function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

function setSaveState(state: 'saved' | 'editing' | 'error' | ''): void {
  ui.saveState.textContent = { saved: 'Saved', editing: 'Editing…', error: 'Save failed', '': '' }[state]
  ui.saveState.classList.toggle('error', state === 'error')
}

let wordTimer: number | undefined
function updateWordCount(): void {
  clearTimeout(wordTimer)
  wordTimer = window.setTimeout(() => {
    if (!current) {
      ui.wordCount.textContent = ''
      return
    }
    const text = view.state.doc.toString()
    const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0
    ui.wordCount.textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${text.length.toLocaleString()} characters`
  }, 150)
}

function updateModeToggle(): void {
  ui.modeToggle.textContent = livePreview ? 'Live preview' : 'Source mode'
}

function updateTitle(): void {
  ui.title.textContent = current ? stripNoteExt(basename(current)) : ''
  document.title = current ? `${stripNoteExt(basename(current))} — Notely` : 'Notely'
}

// ---- Saving -----------------------------------------------------------------------------------

function handleDocChanged(): void {
  dirty = true
  setSaveState('editing')
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void save(), 500)
  updateWordCount()
}

async function save(): Promise<void> {
  clearTimeout(saveTimer)
  if (!current || !dirty) return
  const path = current
  const text = view.state.doc.toString()
  dirty = false
  try {
    await api.writeFile(path, text)
    if (!dirty) setSaveState('saved')
  } catch (err) {
    dirty = true
    setSaveState('error')
    toast(`Could not save ${basename(path)}: ${errorMessage(err)}`)
  }
}

// Flush unsaved edits synchronously when the window closes or reloads.
window.addEventListener('beforeunload', () => {
  if (current && dirty) api.writeFileSync(current, view.state.doc.toString())
})

// ---- Tree helpers -----------------------------------------------------------------------------

function findNode(node: TreeNode | null, path: string): TreeNode | null {
  if (!node) return null
  if (node.path === path) return node
  for (const child of node.children ?? []) {
    if (isInside(path, child.path)) {
      const found = findNode(child, path)
      if (found) return found
    }
  }
  return null
}

async function refreshTree(): Promise<void> {
  vaultTree = await api.listTree()
  fileTree.setTree(vaultTree)
}

function remapPath(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`
}

// ---- Opening and closing notes ----------------------------------------------------------------

function cacheCurrentState(): void {
  if (!current) return
  stateCache.delete(current)
  stateCache.set(current, view.state)
  while (stateCache.size > STATE_CACHE_LIMIT) {
    const oldest = stateCache.keys().next().value
    if (oldest === undefined) break
    stateCache.delete(oldest)
  }
}

async function openFile(path: string): Promise<void> {
  if (path === current) {
    view.focus()
    return
  }
  await save()
  let text: string
  try {
    text = await api.readFile(path)
  } catch (err) {
    toast(`Could not open ${basename(path)}: ${errorMessage(err)}`)
    return
  }
  cacheCurrentState()
  const cached = stateCache.get(path)
  current = path
  dirty = false
  view.setState(cached && cached.doc.toString() === text ? cached : newEditorState(text))
  setLivePreview(view, livePreview) // a cached state may predate a mode switch
  ui.editor.hidden = false
  ui.empty.hidden = true
  setSaveState('')
  updateTitle()
  updateWordCount()
  fileTree.setActive(path)
  void api.setLastOpenFile(path)
  view.focus()
}

/** Closes the editor without saving (callers save first when that's wanted). */
function closeFile(): void {
  clearTimeout(saveTimer)
  dirty = false
  current = null
  view.setState(newEditorState(''))
  ui.editor.hidden = true
  ui.empty.hidden = false
  setSaveState('')
  updateTitle()
  updateWordCount()
  fileTree.setActive(null)
  void api.setLastOpenFile(null)
}

async function followLink(href: string): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    await api.openExternal(href)
    return
  }
  let target = href.split('#')[0]
  if (!target) return
  try {
    target = decodeURI(target)
  } catch {
    // Keep as written.
  }
  let rel = resolvePath(current ? dirname(current) : '', target)
  if (rel === null) return
  if (!NOTE_EXT.test(rel)) rel += '.md'
  if (findNode(vaultTree, rel)) await openFile(rel)
  else toast(`Note not found: ${rel}`)
}

// ---- File operations --------------------------------------------------------------------------

async function createNote(folder = ''): Promise<void> {
  try {
    const path = await api.createNote(folder)
    await refreshTree()
    fileTree.expand(folder)
    await openFile(path)
    fileTree.startRename(path)
  } catch (err) {
    toast(`Could not create note: ${errorMessage(err)}`)
  }
}

async function createFolder(parent = ''): Promise<void> {
  try {
    const path = await api.createFolder(parent)
    await refreshTree()
    fileTree.expand(parent)
    fileTree.startRename(path)
  } catch (err) {
    toast(`Could not create folder: ${errorMessage(err)}`)
  }
}

async function renameItem(path: string, newName: string): Promise<void> {
  if (current && isInside(current, path)) await save()
  try {
    const newPath = await api.rename(path, newName)
    for (const key of [...stateCache.keys()]) {
      if (isInside(key, path)) {
        const state = stateCache.get(key)!
        stateCache.delete(key)
        stateCache.set(remapPath(key, path, newPath), state)
      }
    }
    if (current && isInside(current, path)) {
      current = remapPath(current, path, newPath)
      updateTitle()
      void api.setLastOpenFile(current)
    }
    await refreshTree()
    fileTree.setActive(current)
  } catch (err) {
    toast(errorMessage(err))
  }
}

async function deleteItem(path: string): Promise<void> {
  const affectsCurrent = current !== null && isInside(current, path)
  if (affectsCurrent) await save()
  try {
    if (!(await api.trash(path))) return
    for (const key of [...stateCache.keys()]) if (isInside(key, path)) stateCache.delete(key)
    if (affectsCurrent) closeFile()
    await refreshTree()
  } catch (err) {
    toast(`Could not delete: ${errorMessage(err)}`)
  }
}

async function showContextMenu(node: TreeNode | null): Promise<void> {
  const path = node?.path ?? ''
  const kind = node?.kind ?? 'folder'
  const action = await api.showItemMenu(path, kind)
  switch (action) {
    case 'new-note':
      return createNote(path)
    case 'new-folder':
      return createFolder(path)
    case 'rename':
      return fileTree.startRename(path)
    case 'delete':
      return deleteItem(path)
  }
}

const fileTree = new FileTree(ui.tree, {
  open: (path) => void openFile(path),
  contextMenu: (node) => void showContextMenu(node),
  rename: renameItem,
  renameEnded: () => {
    if (current) view.focus()
  }
})

// ---- Vault ------------------------------------------------------------------------------------

async function loadVault(name: string): Promise<void> {
  stateCache.clear()
  closeFile()
  ui.vaultName.textContent = name
  ui.welcome.hidden = true
  ui.app.hidden = false
  await refreshTree()
}

async function openVault(): Promise<void> {
  await save() // the main process switches folders as soon as one is picked
  try {
    const info = await api.openVaultDialog()
    if (info) await loadVault(info.name)
  } catch (err) {
    toast(`Could not open vault: ${errorMessage(err)}`)
  }
}

/** Keep the tree and the open note in sync with changes made outside Notely. */
async function handleVaultChanged(paths: string[] | null): Promise<void> {
  await refreshTree()
  if (!current) return
  if (!findNode(vaultTree, current)) {
    closeFile()
    return
  }
  if (dirty || (paths && !paths.includes(current))) return
  try {
    const text = await api.readFile(current)
    if (!dirty && text !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: externalChange.of(true)
      })
      updateWordCount()
    }
  } catch {
    // Mid-rename or deleted; the next change event will sort it out.
  }
}

// ---- Commands ---------------------------------------------------------------------------------

function toggleSidebar(): void {
  const hidden = document.body.classList.toggle('sidebar-hidden')
  writePref('sidebarHidden', hidden)
}

function toggleLivePreview(): void {
  livePreview = !livePreview
  writePref('livePreview', livePreview)
  setLivePreview(view, livePreview)
  updateModeToggle()
}

function openTablePicker(): void {
  if (!current) return
  const coords = view.coordsAtPos(view.state.selection.main.head)
  const rect = ui.editor.getBoundingClientRect()
  const anchor = coords ?? { left: rect.left + rect.width / 2 - 120, top: rect.top + 80, bottom: rect.top + 80 }
  showTablePicker(anchor, (columns, rows) => runEditorCommand(insertTable(columns, rows)))
}

// ---- Theme ------------------------------------------------------------------------------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
function updateThemeButton(): void {
  document.body.classList.toggle('dark', darkQuery.matches)
}
darkQuery.addEventListener('change', updateThemeButton)

// ---- Sidebar width ----------------------------------------------------------------------------

const DEFAULT_SIDEBAR_WIDTH = 260
function setSidebarWidth(px: number): number {
  const max = Math.max(200, Math.min(600, window.innerWidth - 360))
  const width = Math.round(Math.min(Math.max(px, 180), max))
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
  return width
}

ui.resizer.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  ui.resizer.setPointerCapture(event.pointerId)
  document.body.classList.add('resizing-sidebar')
  const startX = event.clientX
  const startWidth = ui.sidebar.getBoundingClientRect().width
  let width = startWidth
  const onMove = (e: PointerEvent): void => {
    width = setSidebarWidth(startWidth + e.clientX - startX)
  }
  const onUp = (): void => {
    ui.resizer.removeEventListener('pointermove', onMove)
    ui.resizer.removeEventListener('pointerup', onUp)
    ui.resizer.removeEventListener('pointercancel', onUp)
    document.body.classList.remove('resizing-sidebar')
    writePref('sidebarWidth', width)
  }
  ui.resizer.addEventListener('pointermove', onMove)
  ui.resizer.addEventListener('pointerup', onUp)
  ui.resizer.addEventListener('pointercancel', onUp)
})
ui.resizer.addEventListener('dblclick', () => writePref('sidebarWidth', setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)))

function runEditorCommand(command: (view: EditorView) => boolean): void {
  if (!current) return
  command(view)
  view.focus()
}

function handleMenuCommand(cmd: MenuCommand): void {
  switch (cmd) {
    case 'new-note':
      return void createNote()
    case 'new-folder':
      return void createFolder()
    case 'open-vault':
      return void openVault()
    case 'save':
      return void save()
    case 'toggle-sidebar':
      return toggleSidebar()
    case 'toggle-live-preview':
      return toggleLivePreview()
    case 'undo':
    case 'redo':
      // Outside the editor (e.g. the rename box) fall back to the browser's own undo.
      if (view.hasFocus) (cmd === 'undo' ? undo : redo)(view)
      else document.execCommand(cmd)
      return
    case 'find':
      return runEditorCommand(openSearchPanel)
    case 'bold':
      return runEditorCommand(toggleInline('**'))
    case 'italic':
      return runEditorCommand(toggleInline('*'))
    case 'strikethrough':
      return runEditorCommand(toggleInline('~~'))
    case 'code':
      return runEditorCommand(toggleInline('`'))
    case 'math':
      return runEditorCommand(toggleInline('$'))
    case 'link':
      return runEditorCommand(insertLink)
    case 'task':
      return runEditorCommand(toggleTask)
    case 'insert-table':
      return openTablePicker()
    default:
      if (cmd.startsWith('heading-')) runEditorCommand(setHeading(Number(cmd.slice(8))))
  }
}

// ---- Wiring -----------------------------------------------------------------------------------

byId('btn-new-note').addEventListener('click', () => void createNote())
byId('btn-new-folder').addEventListener('click', () => void createFolder())
byId('btn-open-vault').addEventListener('click', () => void openVault())
byId('btn-switch-vault').addEventListener('click', () => void openVault())
byId('btn-toggle-sidebar').addEventListener('click', toggleSidebar)
ui.modeToggle.addEventListener('click', toggleLivePreview)
byId('btn-theme').addEventListener('click', () => void api.setTheme(darkQuery.matches ? 'light' : 'dark'))

api.onMenuCommand(handleMenuCommand)
api.onVaultChanged((paths) => void handleVaultChanged(paths))
// Fallback for systems where recursive file watching is unavailable.
window.addEventListener('focus', () => {
  if (vaultTree) void refreshTree()
})

async function init(): Promise<void> {
  document.body.classList.toggle('sidebar-hidden', readPref('sidebarHidden', false))
  setSidebarWidth(readPref('sidebarWidth', DEFAULT_SIDEBAR_WIDTH))
  updateThemeButton()
  updateModeToggle()
  const [settings, vault] = await Promise.all([api.getSettings(), api.getVault()])
  if (!vault) {
    ui.welcome.hidden = false
    return
  }
  await loadVault(vault.name)
  if (settings.lastOpenFile && findNode(vaultTree, settings.lastOpenFile)) {
    await openFile(settings.lastOpenFile)
  }
}

void init()
