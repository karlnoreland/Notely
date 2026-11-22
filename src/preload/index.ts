import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { NotelyApi } from '../shared/types'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: NotelyApi = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getVault: () => ipcRenderer.invoke('vault:info'),
  openVaultDialog: () => ipcRenderer.invoke('vault:open-dialog'),
  listTree: () => ipcRenderer.invoke('vault:tree'),
  readFile: (path) => ipcRenderer.invoke('vault:read', path),
  writeFile: (path, content) => ipcRenderer.invoke('vault:write', path, content),
  writeFileSync: (path, content) => ipcRenderer.sendSync('vault:write-sync', path, content),
  createNote: (dir) => ipcRenderer.invoke('vault:create-note', dir),
  createFolder: (dir) => ipcRenderer.invoke('vault:create-folder', dir),
  rename: (path, newName) => ipcRenderer.invoke('vault:rename', path, newName),
  trash: (path) => ipcRenderer.invoke('vault:trash', path),
  setLastOpenFile: (path) => ipcRenderer.invoke('settings:set-last-file', path),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  showItemMenu: (path, kind) => ipcRenderer.invoke('menu:item', path, kind),
  saveAttachment: (ext, data) => ipcRenderer.invoke('vault:save-attachment', ext, data),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  onVaultChanged: (cb) => subscribe('vault:changed', cb),
  onMenuCommand: (cb) => subscribe('menu:command', cb)
}

contextBridge.exposeInMainWorld('notely', api)
