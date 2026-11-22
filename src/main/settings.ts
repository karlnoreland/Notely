import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = {
  vaultPath: null,
  lastOpenFile: null,
  spellcheck: { enabled: true, languages: [] }
}

export class SettingsStore {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private data: Settings

  constructor() {
    this.data = structuredClone(DEFAULTS)
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      this.data = {
        ...this.data,
        ...raw,
        spellcheck: { ...DEFAULTS.spellcheck, ...raw.spellcheck }
      }
    } catch {
      // First run or unreadable file: keep defaults.
    }
  }

  get(): Settings {
    return this.data
  }

  update(patch: Partial<Settings>): void {
    this.data = { ...this.data, ...patch }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    } catch (err) {
      console.error('Failed to save settings', err)
    }
  }
}
