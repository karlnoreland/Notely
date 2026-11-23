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
  /** Folder on disk (for a single-file window: the file's folder). */
  path: string
  name: string
  /** Host part of vault:// URLs for this window, e.g. "s3". */
  assetHost: string
  /** Set when the window edits one file instead of a vault (vault-relative, i.e. just the name). */
  singleFile: string | null
}

export type TableAction =
  | 'row-above'
  | 'row-below'
  | 'col-left'
  | 'col-right'
  | 'delete-row'
  | 'delete-col'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-none'
  | 'edit-source'
  | 'delete-table'

export type ItemAction = 'new-note' | 'new-folder' | 'rename' | 'delete' | 'open-tab' | 'open-right'

/** One entry of a renderer-defined native popup menu. */
export interface PopupItem {
  id?: string
  label?: string
  enabled?: boolean
  separator?: boolean
}

/** Commands sent from the application menu to the renderer. */
export type MenuCommand =
  | 'new-note'
  | 'new-folder'
  | 'open-vault'
  | 'open-file'
  | 'save'
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'split-right'
  | 'close-split'
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
  | `table:${TableAction}`

export interface NotelyApi {
  platform: string
  getSettings(): Promise<Settings>
  getVault(): Promise<VaultInfo | null>
  openVaultDialog(): Promise<VaultInfo | null>
  /**
   * Picks a Markdown file. An empty window (welcome screen) loads it itself and gets its info
   * back; otherwise the file opens in a new window and this resolves to null.
   */
  openFileDialog(): Promise<VaultInfo | null>
  /** Opens a vault-relative note in its own single-file window. */
  openNoteWindow(path: string): Promise<boolean>
  /** Called synchronously from a table cell's contextmenu event so the native menu adds table actions. */
  markTableContextMenu(): void
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
  /** Shows a native menu at the mouse position; resolves to the chosen item's id. */
  popupMenu(items: PopupItem[]): Promise<string | null>
  /** Saves image bytes into the vault's attachments folder; returns the new vault-relative path. */
  saveAttachment(extension: string, data: Uint8Array): Promise<string>
  setTheme(theme: ThemeSetting): Promise<void>
  /** Paths are vault-relative; null means "something changed, unknown what". */
  onVaultChanged(cb: (paths: string[] | null) => void): () => void
  onMenuCommand(cb: (cmd: MenuCommand) => void): () => void
}
