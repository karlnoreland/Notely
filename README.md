# Notely

A Markdown note-taking app for Linux and macOS with Obsidian-style live preview.

- **Live preview.** Markdown renders as you type. The element under the cursor is
  *semi-rendered*: its syntax (`#`, `**`, ```` ``` ````, `$$`) becomes visible but keeps its
  styling, so a heading stays large and bold stays bold while you edit it.
- **Syntax highlighting** in fenced code blocks for 100+ languages (loaded on demand). The
  language label in a code block's corner is a **copy button**.
- **Autocomplete** inside math (LaTeX commands, symbols, environments, with snippet
  placeholders you fill in using Tab) and inside code blocks: keywords, built-ins and snippets for
  Python, JavaScript/TypeScript, HTML, Swift and Bash, plus identifiers already used in the block
  for any language. Prose never shows a popup.
- **Tables** stay rendered while you edit them. Click a cell to edit it: that cell shows its
  raw Markdown, the rest stay rendered. Tab / Shift+Tab and Enter move between cells (Tab in
  the last cell adds a row), the arrow keys move in and out of the table, and the + buttons
  add a row or column. Right-click a cell to insert/delete rows and columns, align a column,
  or *Edit Table as Markdown*. The Markdown is kept neatly column-aligned. Insert a new table
  with right-click › *Insert Table…* (or `Ctrl+Shift+T`).
- **Single files:** *File › Open File…* (`Ctrl+Shift+O`), the welcome screen, `notely file.md`
  or *Open With* in your file manager opens just that file in its own window, with no
  sidebar, for quick edits. Pasted images go next to the file.
- **Images:** paste or drop an image into a note. It is saved to the vault's `attachments/`
  folder, linked, and displayed.
- **LaTeX math** with KaTeX: `$inline$`, `$$display$$` and multi-line `$$ … $$` blocks.
  Math renders when the cursor is elsewhere and shows as highlighted LaTeX source while
  you edit it.
- **Spell checking in several languages at once** (Edit › Spelling), with suggestions on
  right-click. Code blocks, inline code, math and URLs are not checked.
- Notes are plain `.md` files in a folder you choose (a "vault"). The app saves
  automatically and picks up changes made by other programs.
- File tree with create, rename, move to trash and reveal in file manager. Drag its edge
  to resize it (double-click the edge to reset).
- **Dark mode:** *View › Appearance* (Match System / Light / Dark) or the sun/moon button.
- Task lists with clickable checkboxes, links and block quotes.

## Development

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev        # run with hot reload
npm run typecheck
npm run build      # typecheck + production build into out/
npm start          # run the production build
```

Packaging (output in `dist/`):

```sh
npm run dist:linux   # AppImage + .deb
npm run dist:mac     # .dmg + .zip — must be run on macOS
```

macOS builds are unsigned unless signing credentials are configured. For local builds, set
`CSC_IDENTITY_AUTO_DISCOVERY=false`. There is no app icon yet: put `build/icon.png` (1024×1024)
in place and electron-builder will pick it up.

> If Electron starts as plain Node (`Cannot read properties of undefined (reading
> 'registerSchemesAsPrivileged')`), the environment has `ELECTRON_RUN_AS_NODE=1` set,
> as tools launched from VS Code extensions do. Run with `env -u ELECTRON_RUN_AS_NODE npm run dev`.

## Keyboard shortcuts

`Ctrl` is `Cmd` on macOS.

| Action | Shortcut |
| --- | --- |
| New note / new folder | `Ctrl+N` / `Ctrl+Shift+N` |
| Open vault / open single file | `Ctrl+O` / `Ctrl+Shift+O` |
| Bold / italic / strikethrough | `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` |
| Inline code / inline math / link | `Ctrl+E` / `Ctrl+Shift+M` / `Ctrl+K` |
| Toggle task checkbox | `Ctrl+L` |
| Insert table | `Ctrl+Shift+T` (or right-click) |
| Accept suggestion / next snippet field | `Enter` or `Tab` / `Tab` |
| Heading 1–6 | `Ctrl+1` … `Ctrl+6` |
| Find and replace | `Ctrl+F` |
| Toggle sidebar | `Ctrl+\` |
| Live preview ⇄ source mode | `Ctrl+Shift+E` |
| Follow link | `Ctrl+Click` |

## Architecture

```
src/
  main/            Electron main process
    index.ts         windows (one session each: vault or single file), IPC, vault:// protocol
    vault.ts         file system access, sandboxed to the vault folder; atomic writes; watcher
    spellcheck.ts    Chromium spellchecker: languages, context menu with suggestions
    menu.ts          application menu (formatting shortcuts live here)
    settings.ts      settings.json in the user data folder
  preload/         contextBridge API (window.notely); the renderer has no Node access
  shared/types.ts  types shared by all three processes
  renderer/
    src/main.ts      app shell: opening/saving notes, file operations, menu commands
    src/sidebar.ts   file tree with inline rename
    src/tablePicker.ts  grid popup for choosing a table size
    src/editor/
      setup.ts         CodeMirror configuration
      math.ts          Lezer Markdown extension for $…$ and $$…$$ with nested LaTeX parsing
      livePreview.ts   the live-preview decorations (what is hidden or rendered, and when)
      widgets.ts       rendered math (KaTeX), images, checkboxes, bullets, rules, copy button
      table.ts         tables: parsing, the editable table widget, insert command
      completion.ts    LaTeX and code-block autocomplete
      paste.ts         pasting/dropping images
      commands.ts      formatting commands
      theme.ts         syntax colors; styles.css holds the rest of the look
```

The editor is [CodeMirror 6](https://codemirror.net), which Obsidian also uses. Live preview
is a single `StateField` that walks the Markdown syntax tree whenever the document or the
selection changes, and decides for each construct whether to hide its markers or replace it
with a rendered widget. Reveal rules:

- line-level syntax (headings, quotes, bullets, horizontal rules) is revealed when the cursor
  is on that line
- inline syntax (bold, italic, links, inline code and math) is revealed when the cursor
  touches that element
- fenced code and display math are revealed when the cursor is on any line of the block

### Spell checking per platform

- **Linux:** choose languages under *Edit › Spelling › Languages*; several can be active.
  Dictionaries are downloaded once on first use and cached.
- **macOS:** Electron uses the system spellchecker, which detects the language automatically
  from the languages enabled in *System Settings › Keyboard › Text Input*. The app's language
  list is hidden on macOS because Electron cannot override that choice.
