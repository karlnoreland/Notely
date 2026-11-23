import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ItemAction, MenuCommand, NodeKind, PopupItem, TableAction, ThemeSetting, VaultInfo } from '../shared/types'
import { buildMenu } from './menu'
import { SettingsStore } from './settings'
import { Spellcheck } from './spellcheck'
import { Vault } from './vault'

// vault://<window host>/<vault-relative path> serves files (images) from a window's folder.
protocol.registerSchemesAsPrivileged([
  { scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const NOTE_EXT = /\.(md|markdown)$/i

/**
 * Each window is either a vault window (folder + file tree) or a single-file window, which
 * treats the file's folder as a small vault limited to that one file.
 */
interface WindowSession {
  win: BrowserWindow
  vault: Vault | null
  /** Vault-relative path of the file in a single-file window, otherwise null. */
  singleFile: string | null
  /** Set just before a right-click inside a table cell. */
  tableContextMenu: boolean
}

const sessions = new Map<number, WindowSession>()
let settings: SettingsStore
let spellcheck: Spellcheck
/** Files the OS asked us to open before the app was ready (macOS open-file). */
const pendingFiles: string[] = []

const assetHost = (contents: WebContents): string => `s${contents.id}`

function sessionOf(event: IpcMainInvokeEvent | IpcMainEvent): WindowSession {
  const s = sessions.get(event.sender.id)
  if (!s) throw new Error('Unknown window')
  return s
}

function vaultOf(event: IpcMainInvokeEvent | IpcMainEvent): Vault {
  const v = sessionOf(event).vault
  if (!v) throw new Error('No vault is open')
  return v
}

function infoOf(s: WindowSession): VaultInfo | null {
  return s.vault
    ? { path: s.vault.root, name: s.vault.name, assetHost: assetHost(s.win.webContents), singleFile: s.singleFile }
    : null
}

/** The window that most recently showed the vault: it is the one whose state we remember. */
const isVaultWindow = (s: WindowSession): boolean => s.singleFile === null

async function setVault(s: WindowSession, dir: string | null): Promise<void> {
  s.vault?.unwatch()
  s.singleFile = null
  s.vault = dir ? await Vault.open(dir) : null
  s.vault?.watch((paths) => s.win.webContents.send('vault:changed', paths))
  settings.update({ vaultPath: s.vault?.root ?? null })
}

async function setSingleFile(s: WindowSession, file: string): Promise<void> {
  s.vault?.unwatch()
  s.vault = await Vault.open(path.dirname(file))
  s.singleFile = path.basename(file)
  s.vault.watch((paths) => s.win.webContents.send('vault:changed', paths), false)
}

function openExternalSafely(url: string): void {
  try {
    if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    // Not a URL.
  }
}

function sendCommand(cmd: MenuCommand, target?: WebContents): void {
  const contents = target ?? BrowserWindow.getFocusedWindow()?.webContents ?? [...sessions.values()][0]?.win.webContents
  contents?.send('menu:command', cmd)
}

function refreshMenu(): void {
  Menu.setApplicationMenu(
    buildMenu({ send: (cmd) => sendCommand(cmd), spellcheck, theme: settings.get().theme, setTheme })
  )
}

const backgroundColor = (): string => (nativeTheme.shouldUseDarkColors ? '#1e1e21' : '#ffffff')

/** themeSource also drives prefers-color-scheme in the renderer and the native menus/dialogs. */
function applyTheme(theme: ThemeSetting): void {
  nativeTheme.themeSource = theme
  for (const s of sessions.values()) s.win.setBackgroundColor(backgroundColor())
}

function setTheme(theme: ThemeSetting): void {
  settings.update({ theme })
  applyTheme(theme)
  refreshMenu()
}

function tableMenuItems(contents: WebContents): MenuItemConstructorOptions[] {
  const item = (label: string, action: TableAction): MenuItemConstructorOptions => ({
    label,
    click: () => sendCommand(`table:${action}`, contents)
  })
  return [
    item('Insert Row Above', 'row-above'),
    item('Insert Row Below', 'row-below'),
    item('Insert Column Left', 'col-left'),
    item('Insert Column Right', 'col-right'),
    { type: 'separator' },
    item('Delete Row', 'delete-row'),
    item('Delete Column', 'delete-col'),
    {
      label: 'Align Column',
      submenu: [
        item('Left', 'align-left'),
        item('Center', 'align-center'),
        item('Right', 'align-right'),
        item('Default', 'align-none')
      ]
    },
    { type: 'separator' },
    item('Edit Table as Markdown', 'edit-source'),
    item('Delete Table', 'delete-table')
  ]
}

function createWindow(file?: string): WindowSession {
  const saved = file ? undefined : settings.get().window
  const win = new BrowserWindow({
    width: saved?.width ?? (file ? 900 : 1200),
    height: saved?.height ?? (file ? 760 : 800),
    x: saved?.x,
    y: saved?.y,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: file ? path.basename(file) : 'Notely',
    backgroundColor: backgroundColor(),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })
  const s: WindowSession = { win, vault: null, singleFile: null, tableContextMenu: false }
  const id = win.webContents.id
  sessions.set(id, s)
  if (saved?.maximized) win.maximize()

  win.once('ready-to-show', () => win.show())
  win.on('close', () => {
    if (isVaultWindow(s)) {
      settings.update({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
    }
  })
  win.on('closed', () => {
    s.vault?.unwatch()
    sessions.delete(id)
  })

  // Never navigate the app window away; open web links in the browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      openExternalSafely(url)
    }
  })

  spellcheck.attach(win.webContents, (params) => {
    if (s.tableContextMenu) {
      s.tableContextMenu = false
      return tableMenuItems(win.webContents)
    }
    // formControlType is 'none' for the contenteditable editor, but not for text inputs.
    return params.isEditable && params.formControlType === 'none'
      ? [{ label: 'Insert Table…', click: () => sendCommand('insert-table', win.webContents) }]
      : []
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return s
}

async function createVaultWindow(): Promise<void> {
  const s = createWindow()
  const savedVault = settings.get().vaultPath
  if (savedVault && existsSync(savedVault)) {
    await setVault(s, savedVault).catch((err) => {
      console.error('Could not reopen vault', err)
      return setVault(s, null)
    })
  }
}

/** Opens `file` in its own window, or focuses the window that already has it. */
async function openFileWindow(file: string): Promise<void> {
  const abs = path.resolve(file)
  for (const s of sessions.values()) {
    if (s.vault && s.singleFile && path.join(s.vault.root, s.singleFile) === abs) {
      if (s.win.isMinimized()) s.win.restore()
      s.win.focus()
      return
    }
  }
  const s = createWindow(abs)
  try {
    await setSingleFile(s, abs)
  } catch (err) {
    s.win.destroy()
    dialog.showErrorBox('Could not open file', String(err))
  }
}

function filesFromArgs(args: string[], cwd: string): string[] {
  return args
    .filter((a) => !a.startsWith('-') && NOTE_EXT.test(a))
    .map((a) => path.resolve(cwd, a))
    .filter((p) => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    })
}

function showItemMenu(event: IpcMainInvokeEvent, rel: string, kind: NodeKind): Promise<ItemAction | null> {
  const vault = vaultOf(event)
  return new Promise((resolve) => {
    let settled = false
    const pick = (action: ItemAction | null): void => {
      if (!settled) {
        settled = true
        resolve(action)
      }
    }
    const isRoot = rel === ''
    const template: MenuItemConstructorOptions[] = []
    if (kind === 'file') {
      template.push(
        { label: 'Open in New Tab', click: () => pick('open-tab') },
        { label: 'Open to the Right', click: () => pick('open-right') },
        { type: 'separator' }
      )
    }
    if (kind === 'folder') {
      template.push(
        { label: 'New Note', click: () => pick('new-note') },
        { label: 'New Folder', click: () => pick('new-folder') },
        { type: 'separator' }
      )
    }
    if (!isRoot) template.push({ label: 'Rename', click: () => pick('rename') })
    template.push({
      label: process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in File Manager',
      click: () => {
        const abs = vault.resolve(rel)
        if (isRoot) void shell.openPath(abs)
        else shell.showItemInFolder(abs)
        pick(null)
      }
    })
    if (!isRoot) template.push({ type: 'separator' }, { label: 'Delete', click: () => pick('delete') })
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      // The close callback can fire before the click handler; give the click a moment to win.
      callback: () => setTimeout(() => pick(null), 100)
    })
  })
}

function popupMenu(event: IpcMainInvokeEvent, items: PopupItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const pick = (id: string | null): void => {
      if (!settled) {
        settled = true
        resolve(id)
      }
    }
    const template: MenuItemConstructorOptions[] = items.map((item) =>
      item.separator
        ? { type: 'separator' }
        : { label: item.label ?? '', enabled: item.enabled ?? true, click: () => pick(item.id ?? null) }
    )
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      callback: () => setTimeout(() => pick(null), 100)
    })
  })
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set-last-file', (e, rel: string | null) => {
    if (isVaultWindow(sessionOf(e))) settings.update({ lastOpenFile: rel })
  })

  ipcMain.handle('vault:info', (e) => infoOf(sessionOf(e)))
  ipcMain.handle('vault:open-dialog', async (e) => {
    const s = sessionOf(e)
    const result = await dialog.showOpenDialog(s.win, {
      title: 'Open folder as vault',
      buttonLabel: 'Open Vault',
      properties: ['openDirectory', 'createDirectory']
    })
    const dir = result.filePaths[0]
    if (result.canceled || !dir) return null
    await setVault(s, dir)
    settings.update({ lastOpenFile: null })
    return infoOf(s)
  })
  ipcMain.handle('file:open-dialog', async (e) => {
    const s = sessionOf(e)
    const result = await dialog.showOpenDialog(s.win, {
      title: 'Open Markdown file',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const file = result.filePaths[0]
    if (result.canceled || !file) return null
    if (!s.vault) {
      // The welcome screen: use this window instead of opening another one.
      await setSingleFile(s, file)
      return infoOf(s)
    }
    await openFileWindow(file)
    return null
  })
  ipcMain.handle('file:open-window', async (e, rel: string) => {
    const abs = vaultOf(e).resolve(rel)
    if (!existsSync(abs)) return false
    await openFileWindow(abs)
    return true
  })
  ipcMain.on('menu:mark-table', (e) => {
    sessionOf(e).tableContextMenu = true
    e.returnValue = true
  })

  ipcMain.handle('vault:tree', (e) => {
    const s = sessionOf(e)
    return s.vault && isVaultWindow(s) ? s.vault.tree() : null
  })
  ipcMain.handle('vault:read', (e, rel: string) => vaultOf(e).read(rel))
  ipcMain.handle('vault:write', (e, rel: string, content: string) => vaultOf(e).write(rel, content))
  ipcMain.on('vault:write-sync', (e, rel: string, content: string) => {
    try {
      vaultOf(e).writeSync(rel, content)
      e.returnValue = true
    } catch (err) {
      console.error('Failed to save on close', err)
      e.returnValue = false
    }
  })
  ipcMain.handle('vault:create-note', (e, dir: string) => vaultOf(e).createNote(dir))
  ipcMain.handle('vault:create-folder', (e, dir: string) => vaultOf(e).createFolder(dir))
  ipcMain.handle('vault:save-attachment', (e, ext: string, data: Uint8Array) => {
    // Single-file windows put images next to the file rather than creating attachments/.
    const s = sessionOf(e)
    return vaultOf(e).saveAttachment(ext, data, s.singleFile ? '' : undefined)
  })
  ipcMain.handle('theme:set', (_e, theme: ThemeSetting) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') setTheme(theme)
  })
  ipcMain.handle('vault:rename', (e, rel: string, name: string) => vaultOf(e).rename(rel, name))
  ipcMain.handle('vault:trash', async (e, rel: string) => {
    const s = sessionOf(e)
    const v = vaultOf(e)
    const abs = v.resolve(rel)
    if (abs === v.root) throw new Error('The vault folder itself cannot be deleted here')
    const { response } = await dialog.showMessageBox(s.win, {
      type: 'warning',
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Move “${path.basename(abs)}” to the trash?`,
      detail: 'You can restore it from your system trash.'
    })
    if (response !== 0) return false
    await shell.trashItem(abs)
    return true
  })

  ipcMain.handle('shell:open-external', (_e, url: string) => openExternalSafely(url))
  ipcMain.handle('menu:item', (e, rel: string, kind: NodeKind) => showItemMenu(e, rel, kind))
  ipcMain.handle('menu:popup', (e, items: PopupItem[]) => popupMenu(e, items))
}

app.setName('Notely')

// One app instance: opening a file while Notely runs gives it a window in the running app.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    const files = filesFromArgs(argv.slice(1), cwd)
    if (files.length) for (const f of files) void openFileWindow(f)
    else if (sessions.size === 0) void createVaultWindow()
    else {
      const win = [...sessions.values()][0].win
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  // macOS: files opened from Finder or dropped on the Dock icon.
  app.on('open-file', (event, file) => {
    event.preventDefault()
    if (app.isReady()) void openFileWindow(file)
    else pendingFiles.push(file)
  })

  void app.whenReady().then(async () => {
    settings = new SettingsStore()
    applyTheme(settings.get().theme)

    protocol.handle('vault', async (request) => {
      try {
        const url = new URL(request.url)
        const s = [...sessions.values()].find((x) => assetHost(x.win.webContents) === url.hostname)
        if (!s?.vault) throw new Error('No vault')
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
        return await net.fetch(pathToFileURL(s.vault.resolve(rel)).toString())
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })

    spellcheck = new Spellcheck(session.defaultSession, settings, refreshMenu)
    spellcheck.apply()
    refreshMenu()
    registerIpc()

    // `notely notes.md` (or Open With… from a file manager) opens just that file.
    const files = [...pendingFiles, ...filesFromArgs(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd())]
    if (files.length) for (const f of files) await openFileWindow(f)
    else await createVaultWindow()

    app.on('activate', () => {
      if (sessions.size === 0) void createVaultWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
