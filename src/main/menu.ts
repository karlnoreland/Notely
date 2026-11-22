import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/types'
import type { Spellcheck } from './spellcheck'

/**
 * Formatting shortcuts live here rather than in the CodeMirror keymap so they appear in the
 * menu and behave the same on both platforms. Keys that CodeMirror itself binds (undo, find)
 * are handled by CodeMirror on Linux and by the menu on macOS; both paths run the same command.
 */
export function buildMenu(send: (cmd: MenuCommand) => void, spellcheck: Spellcheck): Menu {
  const isMac = process.platform === 'darwin'
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  const cmd = (label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(command)
  })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        cmd('New Note', 'new-note', 'CmdOrCtrl+N'),
        cmd('New Folder', 'new-folder', 'CmdOrCtrl+Shift+N'),
        sep,
        cmd('Open Vault…', 'open-vault', 'CmdOrCtrl+O'),
        cmd('Save', 'save', 'CmdOrCtrl+S'),
        sep,
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        cmd('Undo', 'undo', 'CmdOrCtrl+Z'),
        cmd('Redo', 'redo', 'Shift+CmdOrCtrl+Z'),
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        sep,
        cmd('Find and Replace', 'find', 'CmdOrCtrl+F'),
        sep,
        { label: 'Spelling', submenu: spellcheck.menuItems() }
      ]
    },
    {
      label: 'Format',
      submenu: [
        cmd('Bold', 'bold', 'CmdOrCtrl+B'),
        cmd('Italic', 'italic', 'CmdOrCtrl+I'),
        cmd('Strikethrough', 'strikethrough', 'CmdOrCtrl+Shift+X'),
        cmd('Inline Code', 'code', 'CmdOrCtrl+E'),
        cmd('Inline Math', 'math', 'CmdOrCtrl+Shift+M'),
        cmd('Link', 'link', 'CmdOrCtrl+K'),
        cmd('Toggle Task', 'task', 'CmdOrCtrl+L'),
        sep,
        cmd('Heading 1', 'heading-1', 'CmdOrCtrl+1'),
        cmd('Heading 2', 'heading-2', 'CmdOrCtrl+2'),
        cmd('Heading 3', 'heading-3', 'CmdOrCtrl+3'),
        cmd('Heading 4', 'heading-4', 'CmdOrCtrl+4'),
        cmd('Heading 5', 'heading-5', 'CmdOrCtrl+5'),
        cmd('Heading 6', 'heading-6', 'CmdOrCtrl+6'),
        cmd('Normal Text', 'heading-0')
      ]
    },
    {
      label: 'View',
      submenu: [
        cmd('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+\\'),
        cmd('Toggle Live Preview / Source', 'toggle-live-preview', 'CmdOrCtrl+Shift+E'),
        sep,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        sep,
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [sep, { role: 'reload' as const }]),
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]

  return Menu.buildFromTemplate(template)
}
