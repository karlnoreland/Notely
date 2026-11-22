import { promises as fs, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { TreeNode } from '../shared/types'

const NOTE_EXT = /\.(md|markdown)$/i

/** Dotfiles (.git, .obsidian, temp files) and node_modules are never shown or watched. */
export function isHidden(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

function validateName(name: string): void {
  if (!name || name === '.' || name === '..') throw new Error('Please enter a name')
  if (/[/\\\0]/.test(name)) throw new Error('Names cannot contain slashes')
  if (name.startsWith('.')) throw new Error('Names cannot start with a dot')
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code
}

/** A folder on disk whose Markdown files are the notes. All paths given to it are vault-relative. */
export class Vault {
  private watcher: FSWatcher | null = null

  private constructor(readonly root: string) {}

  static async open(dir: string): Promise<Vault> {
    const root = await fs.realpath(dir)
    if (!(await fs.stat(root)).isDirectory()) throw new Error(`${dir} is not a folder`)
    return new Vault(root)
  }

  get name(): string {
    return path.basename(this.root)
  }

  /** Resolves a vault-relative path and refuses anything that escapes the vault. */
  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel)
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error('Path is outside the vault')
    }
    return abs
  }

  toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/')
  }

  async tree(): Promise<TreeNode> {
    const walk = async (abs: string, rel: string, name: string): Promise<TreeNode> => {
      const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
      const children: TreeNode[] = []
      for (const entry of entries) {
        if (isHidden(entry.name)) continue
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          children.push(await walk(path.join(abs, entry.name), childRel, entry.name))
        } else if (entry.isFile() && NOTE_EXT.test(entry.name)) {
          children.push({ name: entry.name, path: childRel, kind: 'file' })
        }
      }
      children.sort((a, b) =>
        a.kind !== b.kind
          ? a.kind === 'folder'
            ? -1
            : 1
          : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      )
      return { name, path: rel, kind: 'folder', children }
    }
    return walk(this.root, '', this.name)
  }

  read(rel: string): Promise<string> {
    return fs.readFile(this.resolve(rel), 'utf8')
  }

  private tempPath(abs: string): string {
    return path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`)
  }

  /** Atomic write: a crash mid-save never leaves a truncated note behind. */
  async write(rel: string, content: string): Promise<void> {
    const abs = this.resolve(rel)
    const tmp = this.tempPath(abs)
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, abs)
  }

  writeSync(rel: string, content: string): void {
    const abs = this.resolve(rel)
    const tmp = this.tempPath(abs)
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, abs)
  }

  async createNote(dirRel: string): Promise<string> {
    const dir = this.resolve(dirRel)
    for (let i = 0; ; i++) {
      const abs = path.join(dir, i === 0 ? 'Untitled.md' : `Untitled ${i}.md`)
      try {
        await fs.writeFile(abs, '', { flag: 'wx' })
        return this.toRel(abs)
      } catch (err) {
        if (!isErrno(err, 'EEXIST')) throw err
      }
    }
  }

  async createFolder(dirRel: string): Promise<string> {
    const dir = this.resolve(dirRel)
    for (let i = 0; ; i++) {
      const abs = path.join(dir, i === 0 ? 'Untitled folder' : `Untitled folder ${i}`)
      try {
        await fs.mkdir(abs)
        return this.toRel(abs)
      } catch (err) {
        if (!isErrno(err, 'EEXIST')) throw err
      }
    }
  }

  async rename(rel: string, newName: string): Promise<string> {
    newName = newName.trim()
    validateName(newName)
    const abs = this.resolve(rel)
    if (abs === this.root) throw new Error('The vault folder itself cannot be renamed here')
    const target = path.join(path.dirname(abs), newName)
    if (target === abs) return rel
    const [src, dst] = await Promise.all([fs.stat(abs), fs.stat(target).catch(() => null)])
    // On case-insensitive filesystems "Note" -> "note" points at the same inode: allowed.
    if (dst && !(dst.ino === src.ino && dst.dev === src.dev)) {
      throw new Error(`"${newName}" already exists`)
    }
    await fs.rename(abs, target)
    return this.toRel(target)
  }

  watch(onChange: (paths: string[] | null) => void): void {
    this.unwatch()
    let pending = new Set<string>()
    let unknown = false
    let timer: NodeJS.Timeout | undefined
    const flush = (): void => {
      onChange(unknown ? null : [...pending])
      pending = new Set()
      unknown = false
    }
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename) {
          const rel = filename.toString().split(path.sep).join('/')
          if (rel.split('/').some(isHidden)) return
          pending.add(rel)
        } else {
          unknown = true
        }
        clearTimeout(timer)
        timer = setTimeout(flush, 150)
      })
      this.watcher.on('error', (err) => {
        console.warn('Vault watcher stopped:', err)
        this.unwatch()
      })
    } catch (err) {
      // The renderer also refreshes on window focus, so this is not fatal.
      console.warn('File watching unavailable:', err)
    }
  }

  unwatch(): void {
    this.watcher?.close()
    this.watcher = null
  }
}
