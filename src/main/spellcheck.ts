import { app, Menu, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'
import type { SettingsStore } from './settings'

/**
 * Wraps Chromium's built-in spellchecker.
 *
 * Linux: Hunspell dictionaries, any number of languages at once, chosen by the user
 *        (dictionaries are downloaded on first use and cached).
 * macOS: the native NSSpellChecker, which detects the language automatically from the
 *        languages enabled in System Settings > Keyboard > Text Input. Electron ignores
 *        setSpellCheckerLanguages there, so the language list is not shown.
 */
export class Spellcheck {
  private readonly displayNames = new Intl.DisplayNames(['en'], { type: 'language' })

  constructor(
    private readonly session: Session,
    private readonly settings: SettingsStore,
    private readonly onChange: () => void
  ) {}

  get languagesConfigurable(): boolean {
    return process.platform !== 'darwin'
  }

  apply(): void {
    const { enabled, languages } = this.settings.get().spellcheck
    this.session.setSpellCheckerEnabled(enabled)
    if (!this.languagesConfigurable) return
    const available = this.session.availableSpellCheckerLanguages
    let active = languages.filter((l) => available.includes(l))
    if (active.length === 0) active = this.defaultLanguages(available)
    this.session.setSpellCheckerLanguages(active)
  }

  private defaultLanguages(available: string[]): string[] {
    for (const pref of app.getPreferredSystemLanguages()) {
      if (available.includes(pref)) return [pref]
      const base = pref.split('-')[0]
      const match = available.find((a) => a === base || a.startsWith(`${base}-`))
      if (match) return [match]
    }
    if (available.includes('en-US')) return ['en-US']
    return available.slice(0, 1)
  }

  private label(code: string): string {
    let name = code
    try {
      name = this.displayNames.of(code) ?? code
    } catch {
      // Unknown code: show it raw.
    }
    return name === code ? code : `${name} (${code})`
  }

  private setEnabled(enabled: boolean): void {
    this.settings.update({ spellcheck: { ...this.settings.get().spellcheck, enabled } })
    this.session.setSpellCheckerEnabled(enabled)
    this.onChange()
  }

  private toggleLanguage(code: string): void {
    const active = this.session.getSpellCheckerLanguages()
    const next = active.includes(code) ? active.filter((l) => l !== code) : [...active, code]
    if (next.length === 0) return // keep at least one; use the checkbox above to turn it off
    this.session.setSpellCheckerLanguages(next)
    this.settings.update({ spellcheck: { ...this.settings.get().spellcheck, languages: next } })
    this.onChange()
  }

  menuItems(): MenuItemConstructorOptions[] {
    const enabled = this.settings.get().spellcheck.enabled
    const items: MenuItemConstructorOptions[] = [
      {
        label: 'Check Spelling While Typing',
        type: 'checkbox',
        checked: enabled,
        click: () => this.setEnabled(!enabled)
      }
    ]
    if (!this.languagesConfigurable) {
      items.push({ label: 'Languages follow System Settings › Keyboard', enabled: false })
      return items
    }
    const active = this.session.getSpellCheckerLanguages()
    const languages = this.session.availableSpellCheckerLanguages
      .map((code) => ({ code, label: this.label(code) }))
      .sort((a, b) => a.label.localeCompare(b.label))
    const activeLabels = languages.filter((l) => active.includes(l.code)).map((l) => l.label)
    items.push({
      label: 'Languages',
      submenu: languages.map(({ code, label }) => ({
        label,
        type: 'checkbox' as const,
        checked: active.includes(code),
        click: () => this.toggleLanguage(code)
      }))
    })
    if (activeLabels.length) {
      items.push({ label: `Active: ${activeLabels.join(', ')}`, enabled: false })
    }
    return items
  }

  /** Right-click menu with spelling suggestions plus the usual clipboard actions. */
  attach(contents: WebContents): void {
    contents.on('context-menu', (_event, params) => {
      const items: MenuItemConstructorOptions[] = []
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
          items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
        }
        if (params.dictionarySuggestions.length === 0) {
          items.push({ label: 'No suggestions', enabled: false })
        }
        items.push(
          {
            label: `Add “${params.misspelledWord}” to Dictionary`,
            click: () => this.session.addWordToSpellCheckerDictionary(params.misspelledWord)
          },
          { type: 'separator' }
        )
      }
      if (params.isEditable) {
        items.push(
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll' }
        )
      } else if (params.selectionText) {
        items.push({ role: 'copy' })
      }
      if (items.length) Menu.buildFromTemplate(items).popup()
    })
  }
}
