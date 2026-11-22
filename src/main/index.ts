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
  type MenuItemConstructorOptions
} from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ItemAction, MenuCommand, NodeKind, ThemeSetting, VaultInfo } from '../shared/types'
import { buildMenu } from './menu'
import { SettingsStore } from './settings'
import { Spellcheck } from './spellcheck'
import { Vault } from './vault'

// vault://local/<vault-relative path> serves files (images) from the open vault to the renderer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let mainWindow: BrowserWindow | null = null
let vault: Vault | null = null
let settings: SettingsStore
let spellcheck: Spellcheck

function requireVault(): Vault {
  if (!vault) throw new Error('No vault is open')
  return vault
}

function vaultInfo(): VaultInfo | null {
  return vault ? { path: vault.root, name: vault.name } : null
}

async function setVault(dir: string | null): Promise<void> {
  vault?.unwatch()
  vault = dir ? await Vault.open(dir) : null
  vault?.watch((paths) => mainWindow?.webContents.send('vault:changed', paths))
  settings.update({ vaultPath: vault?.root ?? null })
}

function openExternalSafely(url: string): void {
  try {
    if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    // Not a URL.
  }
}

function sendCommand(cmd: MenuCommand): void {
  mainWindow?.webContents.send('menu:command', cmd)
}

function refreshMenu(): void {
  Menu.setApplicationMenu(
    buildMenu({ send: sendCommand, spellcheck, theme: settings.get().theme, setTheme })
  )
}

const backgroundColor = (): string => (nativeTheme.shouldUseDarkColors ? '#1e1e21' : '#ffffff')

/** themeSource also drives prefers-color-scheme in the renderer and the native menus/dialogs. */
function applyTheme(theme: ThemeSetting): void {
  nativeTheme.themeSource = theme
  mainWindow?.setBackgroundColor(backgroundColor())
}

function setTheme(theme: ThemeSetting): void {
  settings.update({ theme })
  applyTheme(theme)
  refreshMenu()
}

function createWindow(): void {
  const saved = settings.get().window
  const win = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 560,
    minHeight: 400,
    show: false,
    title: 'Notely',
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
  mainWindow = win
  if (saved?.maximized) win.maximize()

  win.once('ready-to-show', () => win.show())
  win.on('close', () => {
    settings.update({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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

  spellcheck.attach(win.webContents, (params) =>
    // formControlType is 'none' for the contenteditable editor, but not for text inputs.
    params.isEditable && params.formControlType === 'none'
      ? [{ label: 'Insert Table…', click: () => sendCommand('insert-table') }]
      : []
  )

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function showItemMenu(sender: Electron.WebContents, rel: string, kind: NodeKind): Promise<ItemAction | null> {
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
        const abs = requireVault().resolve(rel)
        if (isRoot) void shell.openPath(abs)
        else shell.showItemInFolder(abs)
        pick(null)
      }
    })
    if (!isRoot) template.push({ type: 'separator' }, { label: 'Delete', click: () => pick('delete') })
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(sender) ?? undefined,
      // The close callback can fire before the click handler; give the click a moment to win.
      callback: () => setTimeout(() => pick(null), 100)
    })
  })
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set-last-file', (_e, rel: string | null) => settings.update({ lastOpenFile: rel }))

  ipcMain.handle('vault:info', () => vaultInfo())
  ipcMain.handle('vault:open-dialog', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Open folder as vault',
      buttonLabel: 'Open Vault',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    const dir = result.filePaths[0]
    if (result.canceled || !dir) return null
    await setVault(dir)
    settings.update({ lastOpenFile: null })
    return vaultInfo()
  })
  ipcMain.handle('vault:tree', () => (vault ? vault.tree() : null))
  ipcMain.handle('vault:read', (_e, rel: string) => requireVault().read(rel))
  ipcMain.handle('vault:write', (_e, rel: string, content: string) => requireVault().write(rel, content))
  ipcMain.on('vault:write-sync', (event, rel: string, content: string) => {
    try {
      requireVault().writeSync(rel, content)
      event.returnValue = true
    } catch (err) {
      console.error('Failed to save on close', err)
      event.returnValue = false
    }
  })
  ipcMain.handle('vault:create-note', (_e, dir: string) => requireVault().createNote(dir))
  ipcMain.handle('vault:create-folder', (_e, dir: string) => requireVault().createFolder(dir))
  ipcMain.handle('vault:save-attachment', (_e, ext: string, data: Uint8Array) =>
    requireVault().saveAttachment(ext, data)
  )
  ipcMain.handle('theme:set', (_e, theme: ThemeSetting) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') setTheme(theme)
  })
  ipcMain.handle('vault:rename', (_e, rel: string, name: string) => requireVault().rename(rel, name))
  ipcMain.handle('vault:trash', async (_e, rel: string) => {
    const v = requireVault()
    const abs = v.resolve(rel)
    if (abs === v.root) throw new Error('The vault folder itself cannot be deleted here')
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Move “${path.basename(abs)}” to the trash?`,
      detail: 'You can restore it from your system trash.'
    }
    const { response } = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    if (response !== 0) return false
    await shell.trashItem(abs)
    return true
  })

  ipcMain.handle('shell:open-external', (_e, url: string) => openExternalSafely(url))
  ipcMain.handle('menu:item', (e, rel: string, kind: NodeKind) => showItemMenu(e.sender, rel, kind))
}

app.setName('Notely')

void app.whenReady().then(async () => {
  settings = new SettingsStore()
  applyTheme(settings.get().theme)

  const savedVault = settings.get().vaultPath
  if (savedVault && existsSync(savedVault)) {
    await setVault(savedVault).catch((err) => {
      console.error('Could not reopen vault', err)
      return setVault(null)
    })
  }

  protocol.handle('vault', async (request) => {
    try {
      const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
      return await net.fetch(pathToFileURL(requireVault().resolve(rel)).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  spellcheck = new Spellcheck(session.defaultSession, settings, refreshMenu)
  spellcheck.apply()
  refreshMenu()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
