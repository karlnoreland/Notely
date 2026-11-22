// Vault-relative paths always use forward slashes.

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export const NOTE_EXT = /\.(md|markdown)$/i

export function stripNoteExt(name: string): string {
  return name.replace(NOTE_EXT, '')
}

/** Resolves `target` against folder `base`. A leading "/" means the vault root. Null if it escapes. */
export function resolvePath(base: string, target: string): string | null {
  const parts = target.startsWith('/') || !base ? [] : base.split('/')
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!parts.length) return null
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return parts.join('/')
}

export function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

export function vaultUrl(path: string): string {
  return `vault://local/${path.split('/').map(encodeURIComponent).join('/')}`
}
