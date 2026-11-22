// Types shared between the main process, the preload script and the renderer.
// Must not reference Node or DOM types.

export type NodeKind = 'file' | 'folder'

export interface TreeNode {
  name: string
  /** Path relative to the vault root using forward slashes; '' for the root. */
  path: string
  kind: NodeKind
  children?: TreeNode[]
}

export interface SpellcheckSettings {
  enabled: boolean
  /** Chromium language codes, e.g. "en-US", "fr", "de-DE". Ignored on macOS. */
  languages: string[]
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface Settings {
  vaultPath: string | null
  lastOpenFile: string | null
  spellcheck: SpellcheckSettings
  theme: ThemeSetting
  window?: WindowState
}

export interface VaultInfo {
  path: string
  name: string
}

export type ItemAction = 'new-note' | 'new-folder' | 'rename' | 'delete'

/** Commands sent from the application menu to the renderer. */
export type MenuCommand =
  | 'new-note'
  | 'new-folder'
  | 'open-vault'
  | 'save'
  | 'undo'
  | 'redo'
  | 'find'
  | 'toggle-sidebar'
  | 'toggle-live-preview'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'math'
  | 'link'
  | 'task'
  | 'insert-table'
  | 'heading-0'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'

export interface NotelyApi {
  platform: string
  getSettings(): Promise<Settings>
  getVault(): Promise<VaultInfo | null>
  openVaultDialog(): Promise<VaultInfo | null>
  listTree(): Promise<TreeNode | null>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  /** Blocking write, only for flushing unsaved changes while the window unloads. */
  writeFileSync(path: string, content: string): boolean
  createNote(dir: string): Promise<string>
  createFolder(dir: string): Promise<string>
  rename(path: string, newName: string): Promise<string>
  /** Asks for confirmation, then moves the item to the system trash. */
  trash(path: string): Promise<boolean>
  setLastOpenFile(path: string | null): Promise<void>
  openExternal(url: string): Promise<void>
  showItemMenu(path: string, kind: NodeKind): Promise<ItemAction | null>
  /** Saves image bytes into the vault's attachments folder; returns the new vault-relative path. */
  saveAttachment(extension: string, data: Uint8Array): Promise<string>
  setTheme(theme: ThemeSetting): Promise<void>
  /** Paths are vault-relative; null means "something changed, unknown what". */
  onVaultChanged(cb: (paths: string[] | null) => void): () => void
  onMenuCommand(cb: (cmd: MenuCommand) => void): () => void
}
