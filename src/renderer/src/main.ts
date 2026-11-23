import 'katex/dist/katex.min.css'
import './styles.css'

import { redo, undo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import type { MenuCommand, TableAction, TreeNode, VaultInfo } from '../../shared/types'
import { insertLink, setHeading, toggleInline, toggleTask } from './editor/commands'
import type { NoteContext } from './editor/context'
import { formatActiveCell, insertTable, isEditingTableCell, runTableAction } from './editor/table'
import { basename, dirname, isInside, NOTE_EXT, relativePath, resolvePath, stripNoteExt, vaultUrl } from './paths'
import { FileTree } from './sidebar'
import { showTablePicker } from './tablePicker'
import { Workspace, type OpenMode, type Session } from './workspace'

const api = window.notely

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const ui = {
  app: byId('app'),
  welcome: byId('welcome'),
  vaultName: byId('vault-name'),
  tree: byId('file-tree'),
  panes: byId('panes'),
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
let vaultPath: string | null = null
/** Host of vault:// URLs for this window. */
let assetHost = 'local'
/** True when this window edits a single file instead of a vault. */
let singleFileMode = false
let livePreview = readPref('livePreview', true)
const saveStates = new Map<string, 'saved' | 'editing' | 'error'>()

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif'
}

/** Per-tab context for the editor: image paths and links resolve relative to that tab's note. */
function contextFor(notePath: () => string | null): NoteContext {
  const dir = (): string => {
    const path = notePath()
    return path ? dirname(path) : ''
  }
  return {
    resolveImage(src) {
      if (/^(https?:|data:|vault:)/i.test(src)) return src
      let target = src.trim().replace(/^<|>$/g, '')
      try {
        target = decodeURI(target)
      } catch {
        // Keep as written.
      }
      const rel = resolvePath(dir(), target)
      return rel === null ? '' : vaultUrl(assetHost, rel)
    },
    openLink(href) {
      void followLink(href, dir())
    },
    async saveImage(file) {
      if (!notePath()) return null
      const ext = IMAGE_TYPES[file.type] ?? /\.([a-z0-9]+)$/i.exec(file.name)?.[1]
      if (!ext) {
        toast(`Unsupported image type: ${file.type || file.name}`)
        return null
      }
      try {
        const saved = await api.saveAttachment(ext, new Uint8Array(await file.arrayBuffer()))
        return relativePath(dir(), saved).split('/').map(encodeURIComponent).join('/')
      } catch (err) {
        toast(`Could not save image: ${errorMessage(err)}`)
        return null
      }
    },
    markTableContextMenu() {
      api.markTableContextMenu()
    }
  }
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
    const view = ws.focusedView()
    if (!view) {
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

/** Title, save state, word count and sidebar highlight follow the focused tab. */
function updateChrome(): void {
  const current = ws.currentPath()
  const name = current ? stripNoteExt(basename(current)) : ''
  ui.title.textContent = name
  ui.title.title = current && vaultPath ? `${vaultPath}/${current}` : ''
  document.title = current ? `${name} — Notely` : 'Notely'
  setSaveState(current ? (ws.isDirty(current) ? 'editing' : (saveStates.get(current) ?? '')) : '')
  updateWordCount()
  fileTree.setActive(current)
  void api.setLastOpenFile(current)
}

// ---- Workspace (panes and tabs) ---------------------------------------------------------------

let sessionTimer: number | undefined
function persistSession(): void {
  if (singleFileMode || !vaultPath) return
  clearTimeout(sessionTimer)
  const key = `session:${vaultPath}`
  sessionTimer = window.setTimeout(() => writePref(key, ws.session()), 300)
}

const ws = new Workspace(ui.panes, {
  readFile: (path) => api.readFile(path),
  writeFile: (path, text) => api.writeFile(path, text),
  writeFileSync: (path, text) => api.writeFileSync(path, text),
  contextFor,
  livePreview: () => livePreview,
  popupMenu: (items) => api.popupMenu(items),
  onActiveChange: updateChrome,
  onDocChange: (path) => {
    if (path === ws.currentPath()) updateWordCount()
  },
  onSaveState: (path, state) => {
    saveStates.set(path, state)
    if (path === ws.currentPath()) setSaveState(state)
  },
  onError: toast,
  onLayoutChange: persistSession
})

// Flush unsaved edits synchronously when the window closes or reloads.
window.addEventListener('beforeunload', () => ws.flushSync())

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
  if (singleFileMode) return
  vaultTree = await api.listTree()
  fileTree.setTree(vaultTree)
}

// ---- Opening notes ----------------------------------------------------------------------------

function openFile(path: string, mode: OpenMode = 'replace'): Promise<void> {
  return ws.openFile(path, singleFileMode ? 'replace' : mode)
}

async function followLink(href: string, fromDir: string): Promise<void> {
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
  let rel = resolvePath(fromDir, target)
  if (rel === null) return
  if (!NOTE_EXT.test(rel)) rel += '.md'
  if (singleFileMode) {
    // No vault here: open the linked note in a window of its own.
    if (!(await api.openNoteWindow(rel))) toast(`Note not found: ${rel}`)
  } else if (findNode(vaultTree, rel)) await openFile(rel)
  else toast(`Note not found: ${rel}`)
}

// ---- File operations --------------------------------------------------------------------------

async function createNote(folder = ''): Promise<void> {
  try {
    const path = await api.createNote(folder)
    await refreshTree()
    fileTree.expand(folder)
    await openFile(path, ws.currentPath() ? 'tab' : 'replace')
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
  await ws.saveMatching((p) => isInside(p, path))
  try {
    const newPath = await api.rename(path, newName)
    for (const [p, state] of [...saveStates]) {
      if (isInside(p, path)) {
        saveStates.delete(p)
        saveStates.set(p === path ? newPath : `${newPath}${p.slice(path.length)}`, state)
      }
    }
    ws.renamePath(path, newPath)
    await refreshTree()
    fileTree.setActive(ws.currentPath())
  } catch (err) {
    toast(errorMessage(err))
  }
}

async function deleteItem(path: string): Promise<void> {
  await ws.saveMatching((p) => isInside(p, path))
  try {
    if (!(await api.trash(path))) return
    await ws.closeMatching((p) => isInside(p, path))
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
    case 'open-tab':
      return openFile(path, 'tab')
    case 'open-right':
      return openFile(path, 'split')
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
  open: (path, mode) => void openFile(path, mode),
  contextMenu: (node) => void showContextMenu(node),
  rename: renameItem,
  renameEnded: () => ws.focusedView()?.focus()
})

// ---- Vault ------------------------------------------------------------------------------------

function enterWindowMode(info: VaultInfo): void {
  assetHost = info.assetHost
  vaultPath = info.path
  singleFileMode = info.singleFile !== null
  document.body.classList.toggle('single-file', singleFileMode)
  ui.welcome.hidden = true
  ui.app.hidden = false
}

async function loadVault(info: VaultInfo, lastOpenFile: string | null = null): Promise<void> {
  enterWindowMode(info)
  ws.reset()
  saveStates.clear()
  ui.vaultName.textContent = info.name
  await refreshTree()
  const session = readPref<Session | null>(`session:${info.path}`, null)
  const restored = session ? await ws.restore(session, (p) => !!findNode(vaultTree, p)) : false
  if (!restored && lastOpenFile && findNode(vaultTree, lastOpenFile)) await openFile(lastOpenFile)
  updateChrome()
}

async function openVault(): Promise<void> {
  await ws.saveAll() // the main process switches folders as soon as one is picked
  try {
    const info = await api.openVaultDialog()
    if (info) await loadVault(info)
  } catch (err) {
    toast(`Could not open vault: ${errorMessage(err)}`)
  }
}

/** Single-file window: just this note, no sidebar or tabs. */
async function loadSingleFile(info: VaultInfo): Promise<void> {
  enterWindowMode(info)
  ws.reset()
  vaultTree = null
  fileTree.setTree(null)
  await openFile(info.singleFile!)
}

/** Picks a file: an empty window opens it itself, otherwise it gets a window of its own. */
async function openSingleFile(): Promise<void> {
  try {
    const info = await api.openFileDialog()
    if (info) await loadSingleFile(info)
  } catch (err) {
    toast(`Could not open file: ${errorMessage(err)}`)
  }
}

/** Keep the tree and the open notes in sync with changes made outside Notely. */
async function handleVaultChanged(paths: string[] | null): Promise<void> {
  await refreshTree()
  for (const path of ws.openPaths()) {
    if (!singleFileMode && !findNode(vaultTree, path)) {
      await ws.closeMatching((p) => p === path) // deleted or moved outside Notely
      continue
    }
    if (ws.isDirty(path) || (paths && !paths.includes(path))) continue
    try {
      const text = await api.readFile(path)
      if (!ws.isDirty(path)) ws.applyExternal(path, text)
    } catch {
      // Mid-rename or deleted; the next change event will sort it out.
    }
  }
  updateWordCount()
}

// ---- Commands ---------------------------------------------------------------------------------

function toggleSidebar(): void {
  const hidden = document.body.classList.toggle('sidebar-hidden')
  writePref('sidebarHidden', hidden)
}

function toggleLivePreview(): void {
  livePreview = !livePreview
  writePref('livePreview', livePreview)
  ws.setLivePreview(livePreview)
  updateModeToggle()
}

function openTablePicker(): void {
  const view = ws.focusedView()
  if (!view) return
  const coords = view.coordsAtPos(view.state.selection.main.head)
  const rect = view.dom.getBoundingClientRect()
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

/** Inline formatting applies to the focused table cell when one is being edited. */
function formatCommand(marker: string): void {
  if (!formatActiveCell(marker)) runEditorCommand(toggleInline(marker))
}

function vaultOnly(action: () => void): void {
  if (singleFileMode) toast('This window shows a single file. Open a vault (Ctrl+O) to manage notes.')
  else action()
}

function runEditorCommand(command: (view: EditorView) => boolean): void {
  const view = ws.focusedView()
  if (!view) return
  command(view)
  view.focus()
}

function handleMenuCommand(cmd: MenuCommand): void {
  switch (cmd) {
    case 'new-note':
      return vaultOnly(() => void createNote())
    case 'new-folder':
      return vaultOnly(() => void createFolder())
    case 'new-tab':
      return vaultOnly(() => ws.newTab())
    case 'close-tab':
      return vaultOnly(() => ws.closeActiveTab())
    case 'next-tab':
      return ws.cycleTab(1)
    case 'prev-tab':
      return ws.cycleTab(-1)
    case 'split-right':
      return vaultOnly(() => void ws.splitRight())
    case 'close-split':
      return void ws.closeSplit()
    case 'open-vault':
      return void openVault()
    case 'open-file':
      return void openSingleFile()
    case 'save':
      return void ws.saveAll()
    case 'toggle-sidebar':
      return singleFileMode ? undefined : toggleSidebar()
    case 'toggle-live-preview':
      return toggleLivePreview()
    case 'undo':
    case 'redo': {
      // Table cells share their editor's history. Elsewhere outside an editor (e.g. the
      // rename box) fall back to the browser's own undo.
      const view = ws.activeView()
      if (view && (view.hasFocus || isEditingTableCell())) (cmd === 'undo' ? undo : redo)(view)
      else document.execCommand(cmd)
      return
    }
    case 'find':
      return runEditorCommand(openSearchPanel)
    case 'bold':
      return formatCommand('**')
    case 'italic':
      return formatCommand('*')
    case 'strikethrough':
      return formatCommand('~~')
    case 'code':
      return formatCommand('`')
    case 'math':
      return formatCommand('$')
    case 'link':
      return runEditorCommand(insertLink)
    case 'task':
      return runEditorCommand(toggleTask)
    case 'insert-table':
      return openTablePicker()
    default:
      if (cmd.startsWith('heading-')) runEditorCommand(setHeading(Number(cmd.slice(8))))
      else if (cmd.startsWith('table:')) runTableAction(cmd.slice(6) as TableAction)
  }
}

// ---- Wiring -----------------------------------------------------------------------------------

byId('btn-new-note').addEventListener('click', () => void createNote())
byId('btn-new-folder').addEventListener('click', () => void createFolder())
byId('btn-open-vault').addEventListener('click', () => void openVault())
byId('btn-open-file').addEventListener('click', () => void openSingleFile())
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
  if (vault.singleFile !== null) return loadSingleFile(vault)
  await loadVault(vault, settings.lastOpenFile)
}

void init()
