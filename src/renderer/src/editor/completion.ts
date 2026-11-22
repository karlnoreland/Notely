// Autocomplete inside math ($…$, $$…$$) and fenced code blocks. Prose never gets a popup.
//
// Code blocks get keywords, common built-ins and snippets for Python, JavaScript/TypeScript,
// HTML, Swift and Bash, plus identifiers already used in the same block (for any language).

import {
  autocompletion,
  snippetCompletion as snip,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

// ---- Where is the cursor? --------------------------------------------------------------------

type Where = { kind: 'math' } | { kind: 'code'; lang: string; from: number; to: number } | null

/** An odd number of unescaped $ before the cursor on this line: math that isn't closed yet. */
function inUnclosedInlineMath(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  return (before.match(/(?<!\\)\$/g)?.length ?? 0) % 2 === 1
}

function locate(state: EditorState, pos: number): Where {
  for (let node = syntaxTree(state).resolve(pos, -1); node; node = node.parent!) {
    if (node.name === 'InlineMath' || node.name === 'BlockMath') return { kind: 'math' }
    if (node.name === 'FencedCode') {
      const first = state.doc.lineAt(node.from)
      const last = state.doc.lineAt(node.to)
      const closed = node.getChildren('CodeMark').length > 1 && last.number > first.number
      if (pos <= first.to || (closed && pos >= last.from)) return null // on a fence line
      const info = node.getChild('CodeInfo')
      const lang = info ? state.doc.sliceString(info.from, info.to).toLowerCase() : ''
      return { kind: 'code', lang, from: first.to + 1, to: closed ? last.from : node.to }
    }
    if (node.name === 'InlineCode' || node.name === 'CodeBlock') return null
    if (!node.parent) break
  }
  return inUnclosedInlineMath(state, pos) ? { kind: 'math' } : null
}

// ---- LaTeX -----------------------------------------------------------------------------------

const cmd = (name: string, detail?: string): Completion => ({ label: `\\${name}`, type: 'keyword', detail })
const sym = (name: string, detail?: string): Completion => ({ label: `\\${name}`, type: 'constant', detail })
const tex = (template: string, label: string, detail: string): Completion =>
  snip(template, { label, detail, type: 'function' })
const env = (name: string, detail: string): Completion =>
  snip(`\\begin{${name}}\n\t\${}\n\\end{${name}}`, { label: `\\begin{${name}}`, detail, type: 'class' })

const GREEK = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'
const SYMBOLS: [string, string][] = [
  ['infty', '∞'], ['partial', '∂'], ['nabla', '∇'], ['pm', '±'], ['mp', '∓'], ['times', '×'],
  ['cdot', '·'], ['div', '÷'], ['leq', '≤'], ['geq', '≥'], ['neq', '≠'], ['approx', '≈'],
  ['equiv', '≡'], ['sim', '∼'], ['propto', '∝'], ['in', '∈'], ['notin', '∉'], ['subset', '⊂'],
  ['subseteq', '⊆'], ['supset', '⊃'], ['cup', '∪'], ['cap', '∩'], ['emptyset', '∅'],
  ['forall', '∀'], ['exists', '∃'], ['neg', '¬'], ['land', '∧'], ['lor', '∨'], ['to', '→'],
  ['rightarrow', '→'], ['leftarrow', '←'], ['Rightarrow', '⇒'], ['Leftarrow', '⇐'],
  ['Leftrightarrow', '⇔'], ['iff', '⟺'], ['implies', '⟹'], ['mapsto', '↦'], ['ldots', '…'],
  ['cdots', '⋯'], ['vdots', '⋮'], ['ddots', '⋱'], ['quad', 'space'], ['qquad', 'wide space'],
  ['langle', '⟨'], ['rangle', '⟩'], ['circ', '∘'], ['star', '⋆'], ['dagger', '†'], ['ell', 'ℓ'],
  ['hbar', 'ℏ'], ['Re', 'ℜ'], ['Im', 'ℑ'], ['aleph', 'ℵ'], ['perp', '⊥'], ['parallel', '∥'],
  ['angle', '∠'], ['degree', '°'], ['prime', '′']
]
const FUNCTIONS = 'sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp lim max min sup inf det gcd deg dim ker arg'

const LATEX: Completion[] = [
  tex('\\frac{${num}}{${den}}', '\\frac', 'fraction'),
  tex('\\dfrac{${num}}{${den}}', '\\dfrac', 'display fraction'),
  tex('\\sqrt{${x}}', '\\sqrt', 'square root'),
  tex('\\sqrt[${n}]{${x}}', '\\sqrt[n]', 'n-th root'),
  tex('\\sum_{${i=1}}^{${n}}', '\\sum', 'sum'),
  tex('\\prod_{${i=1}}^{${n}}', '\\prod', 'product'),
  tex('\\int_{${a}}^{${b}}', '\\int', 'integral'),
  tex('\\iint_{${D}}', '\\iint', 'double integral'),
  tex('\\oint_{${C}}', '\\oint', 'contour integral'),
  tex('\\lim_{${x} \\to ${\\infty}}', '\\lim', 'limit'),
  tex('\\binom{${n}}{${k}}', '\\binom', 'binomial'),
  tex('\\text{${text}}', '\\text', 'upright text'),
  tex('\\mathbb{${R}}', '\\mathbb', 'blackboard bold'),
  tex('\\mathcal{${A}}', '\\mathcal', 'calligraphic'),
  tex('\\mathbf{${x}}', '\\mathbf', 'bold'),
  tex('\\mathrm{${x}}', '\\mathrm', 'roman'),
  tex('\\operatorname{${name}}', '\\operatorname', 'operator name'),
  tex('\\vec{${v}}', '\\vec', 'vector arrow'),
  tex('\\hat{${x}}', '\\hat', 'hat'),
  tex('\\bar{${x}}', '\\bar', 'bar'),
  tex('\\dot{${x}}', '\\dot', 'dot'),
  tex('\\ddot{${x}}', '\\ddot', 'double dot'),
  tex('\\tilde{${x}}', '\\tilde', 'tilde'),
  tex('\\overline{${x}}', '\\overline', 'overline'),
  tex('\\underline{${x}}', '\\underline', 'underline'),
  tex('\\overbrace{${x}}^{${label}}', '\\overbrace', 'brace above'),
  tex('\\underbrace{${x}}_{${label}}', '\\underbrace', 'brace below'),
  tex('\\left( ${} \\right)', '\\left(', 'scaled parentheses'),
  tex('\\left[ ${} \\right]', '\\left[', 'scaled brackets'),
  tex('\\left| ${} \\right|', '\\left|', 'scaled bars'),
  env('pmatrix', '( matrix )'),
  env('bmatrix', '[ matrix ]'),
  env('vmatrix', '| determinant |'),
  env('matrix', 'matrix'),
  env('cases', 'piecewise'),
  env('aligned', 'aligned equations'),
  ...GREEK.split(' ').map((g) => sym(g, 'greek')),
  ...SYMBOLS.map(([name, detail]) => sym(name, detail)),
  ...FUNCTIONS.split(' ').map((f) => cmd(f, 'function'))
]

function latexCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\\[a-zA-Z]*/)
  if (!word) return null
  return { from: word.from, options: LATEX, validFor: /^\\[a-zA-Z]*$/ }
}

// ---- Code languages --------------------------------------------------------------------------

interface LanguageSpec {
  keywords: string
  builtins: string
  snippets: Completion[]
  /** Characters that make up a completable word. */
  word: RegExp
}

const s = (template: string, label: string, detail: string): Completion =>
  snip(template, { label, detail, type: 'text' })

const PYTHON: LanguageSpec = {
  word: /[\w.]+/,
  keywords: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self',
  builtins: 'print len range enumerate zip map filter sorted reversed sum min max abs round open input int float str bool list dict set tuple frozenset bytes type isinstance issubclass hasattr getattr setattr delattr super property staticmethod classmethod any all iter next repr format id hash dir vars help callable Exception ValueError TypeError KeyError IndexError RuntimeError __init__ __name__ __main__ os.path sys.argv json.loads json.dumps',
  snippets: [
    s('def ${name}(${args}):\n\t${pass}', 'def', 'function'),
    s('class ${Name}:\n\tdef __init__(self${, args}):\n\t\t${pass}', 'class', 'class'),
    s('for ${item} in ${items}:\n\t${pass}', 'for', 'loop'),
    s('while ${condition}:\n\t${pass}', 'while', 'loop'),
    s('if ${condition}:\n\t${pass}', 'if', 'conditional'),
    s('if ${condition}:\n\t${pass}\nelse:\n\t${pass}', 'ifelse', 'if / else'),
    s('try:\n\t${pass}\nexcept ${Exception} as ${e}:\n\t${raise}', 'try', 'try / except'),
    s('with open(${path}, "${r}") as ${f}:\n\t${pass}', 'with', 'open a file'),
    s('if __name__ == "__main__":\n\t${main()}', 'main', 'entry point'),
    s('[${x} for ${x} in ${items}]', 'listcomp', 'list comprehension'),
    s('lambda ${x}: ${x}', 'lambda', 'anonymous function'),
    s('print(f"${}")', 'printf', 'print f-string')
  ]
}

const JAVASCRIPT: LanguageSpec = {
  word: /[\w$.]+/,
  keywords: 'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while yield async await of null undefined true false static get set from',
  builtins: 'console.log console.error console.warn console.table document.querySelector document.querySelectorAll document.getElementById document.createElement window addEventListener removeEventListener Array.isArray Array.from Object.keys Object.values Object.entries Object.assign JSON.stringify JSON.parse Math.max Math.min Math.floor Math.round Math.random Promise.all Promise.resolve Number String Boolean Map Set Date RegExp Error Symbol fetch setTimeout setInterval clearTimeout clearInterval parseInt parseFloat require module.exports localStorage structuredClone',
  snippets: [
    s('function ${name}(${params}) {\n\t${}\n}', 'function', 'function'),
    s('const ${name} = (${params}) => {\n\t${}\n}', 'arrow', 'arrow function'),
    s('async function ${name}(${params}) {\n\t${}\n}', 'async', 'async function'),
    s('if (${condition}) {\n\t${}\n}', 'if', 'conditional'),
    s('if (${condition}) {\n\t${}\n} else {\n\t${}\n}', 'ifelse', 'if / else'),
    s('for (let ${i} = 0; ${i} < ${array}.length; ${i}++) {\n\t${}\n}', 'for', 'loop'),
    s('for (const ${item} of ${items}) {\n\t${}\n}', 'forof', 'for…of loop'),
    s('${array}.forEach((${item}) => {\n\t${}\n})', 'foreach', 'forEach'),
    s('class ${Name} {\n\tconstructor(${params}) {\n\t\t${}\n\t}\n}', 'class', 'class'),
    s('try {\n\t${}\n} catch (${error}) {\n\t${}\n}', 'try', 'try / catch'),
    s("import { ${names} } from '${module}'", 'import', 'import'),
    s('const response = await fetch(${url})\nconst data = await response.json()', 'fetchjson', 'fetch JSON'),
    s('console.log(${})', 'log', 'console.log')
  ]
}

const SWIFT: LanguageSpec = {
  word: /[\w.@]+/,
  keywords: 'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil super self Self throw throws true try async await some any mutating override final lazy weak unowned convenience required @State @Binding @Published @ObservedObject @StateObject @Environment @MainActor @Observable',
  builtins: 'print String Int Double Float Bool Array Dictionary Set Optional Character Result Error Codable Identifiable Hashable Equatable ObservableObject View Text Image Button VStack HStack ZStack List ForEach NavigationStack NavigationLink Spacer Divider Toggle TextField ScrollView padding frame foregroundStyle font onAppear task Task DispatchQueue.main.async URLSession.shared JSONDecoder JSONEncoder map filter reduce compactMap sorted append count isEmpty',
  snippets: [
    s('func ${name}(${params}) -> ${Type} {\n\t${}\n}', 'func', 'function'),
    s('struct ${Name} {\n\t${}\n}', 'struct', 'struct'),
    s('class ${Name} {\n\t${}\n}', 'class', 'class'),
    s('enum ${Name} {\n\tcase ${value}\n}', 'enum', 'enum'),
    s('protocol ${Name} {\n\t${}\n}', 'protocol', 'protocol'),
    s('extension ${Type} {\n\t${}\n}', 'extension', 'extension'),
    s('if let ${value} = ${optional} {\n\t${}\n}', 'iflet', 'optional binding'),
    s('guard let ${value} = ${optional} else {\n\t${return}\n}', 'guardlet', 'guard let'),
    s('for ${item} in ${items} {\n\t${}\n}', 'for', 'for…in loop'),
    s('switch ${value} {\ncase ${pattern}:\n\t${}\ndefault:\n\t${break}\n}', 'switch', 'switch'),
    s('do {\n\ttry ${}\n} catch {\n\t${print(error)}\n}', 'do', 'do / catch'),
    s('struct ${ContentView}: View {\n\tvar body: some View {\n\t\t${Text("Hello")}\n\t}\n}', 'view', 'SwiftUI view'),
    s('init(${params}) {\n\t${}\n}', 'init', 'initializer')
  ]
}

const BASH: LanguageSpec = {
  word: /[\w-]+/,
  keywords: 'if then else elif fi for while until do done case esac in function select return exit break continue local export readonly declare source alias unset shift trap set',
  builtins: 'echo printf read cd pwd ls cp mv rm mkdir rmdir touch cat less head tail grep sed awk find xargs sort uniq wc cut tr chmod chown ln tar gzip curl wget ssh scp rsync git sudo kill ps top df du which env test true false sleep date tee diff basename dirname mktemp realpath systemctl journalctl',
  snippets: [
    s('if [[ ${condition} ]]; then\n\t${}\nfi', 'if', 'conditional'),
    s('if [[ ${condition} ]]; then\n\t${}\nelse\n\t${}\nfi', 'ifelse', 'if / else'),
    s('for ${item} in ${items}; do\n\t${}\ndone', 'for', 'loop'),
    s('while ${condition}; do\n\t${}\ndone', 'while', 'loop'),
    s('case ${value} in\n\t${pattern})\n\t\t${}\n\t\t;;\n\t*)\n\t\t${}\n\t\t;;\nesac', 'case', 'case'),
    s('${name}() {\n\t${}\n}', 'function', 'function'),
    s('#!/usr/bin/env bash\nset -euo pipefail\n${}', 'shebang', 'script header'),
    s('"$(${command})"', 'subshell', 'command substitution')
  ]
}

const HTML_TAGS = 'html head body title meta link script style div span p a img ul ol li h1 h2 h3 h4 h5 h6 table thead tbody tr th td form input button label select option textarea nav header footer main section article aside figure figcaption video audio source canvas svg br hr strong em code pre blockquote iframe details summary dialog template'
const HTML_VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source'])
const HTML_ATTRIBUTES = 'class id style href src alt title type name value placeholder rel target width height lang charset content for action method disabled checked required onclick'

const HTML_OPEN: Completion[] = [
  snip('!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<title>${Document}</title>\n</head>\n<body>\n\t${}\n</body>\n</html>', { label: '!DOCTYPE', detail: 'page skeleton', type: 'text' }),
  ...HTML_TAGS.split(' ').map((tag) =>
    HTML_VOID.has(tag)
      ? snip(tag === 'img' ? 'img src="${}" alt="${}">' : `${tag}\${}>`, { label: tag, type: 'type' })
      : snip(`${tag}>\${}</${tag}>`, { label: tag, type: 'type' })
  )
]
const HTML_CLOSE: Completion[] = HTML_TAGS.split(' ')
  .filter((tag) => !HTML_VOID.has(tag))
  .map((tag) => ({ label: tag, apply: `${tag}>`, type: 'type' }))
const HTML_ATTRS: Completion[] = HTML_ATTRIBUTES.split(' ').map((attr) =>
  snip(`${attr}="\${}"`, { label: attr, type: 'property' })
)

function htmlCompletions(context: CompletionContext): CompletionResult | null {
  const tag = context.matchBefore(/<\/?[\w!-]*/)
  if (tag) {
    const closing = tag.text.startsWith('</')
    return {
      from: tag.from + (closing ? 2 : 1),
      options: closing ? HTML_CLOSE : HTML_OPEN,
      validFor: /^[\w!-]*$/
    }
  }
  const line = context.state.doc.lineAt(context.pos)
  const before = context.state.doc.sliceString(line.from, context.pos)
  const insideTag = before.lastIndexOf('<') > before.lastIndexOf('>')
  const attr = context.matchBefore(/[\w-]+/)
  if (insideTag && attr && /\s$/.test(before.slice(0, attr.from - line.from))) {
    return { from: attr.from, options: HTML_ATTRS, validFor: /^[\w-]*$/ }
  }
  return null
}

const LANGUAGES: Record<string, LanguageSpec> = {
  python: PYTHON, py: PYTHON, python3: PYTHON,
  javascript: JAVASCRIPT, js: JAVASCRIPT, jsx: JAVASCRIPT, mjs: JAVASCRIPT, node: JAVASCRIPT,
  typescript: JAVASCRIPT, ts: JAVASCRIPT, tsx: JAVASCRIPT,
  swift: SWIFT,
  bash: BASH, sh: BASH, shell: BASH, zsh: BASH, console: BASH
}
const HTML_NAMES = new Set(['html', 'htm', 'xml', 'svg', 'vue'])

/** Turns the space-separated lists into completion options once per language. */
const optionCache = new Map<LanguageSpec, Completion[]>()
function languageOptions(spec: LanguageSpec): Completion[] {
  let options = optionCache.get(spec)
  if (!options) {
    options = [
      ...spec.snippets,
      ...spec.keywords.split(' ').map((label) => ({ label, type: 'keyword' })),
      ...spec.builtins.split(' ').map((label) => ({ label, type: 'function' }))
    ]
    optionCache.set(spec, options)
  }
  return options
}

/** Identifiers already used in this code block. */
function localWords(state: EditorState, from: number, to: number, exclude: string): Completion[] {
  const words = new Set<string>()
  for (const match of state.doc.sliceString(from, to).matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
    if (match[0] !== exclude) words.add(match[0])
    if (words.size > 300) break
  }
  return [...words].map((label) => ({ label, type: 'variable', boost: -1 }))
}

function codeCompletions(context: CompletionContext, where: { lang: string; from: number; to: number }): CompletionResult | null {
  if (HTML_NAMES.has(where.lang)) return htmlCompletions(context)
  const spec = LANGUAGES[where.lang]
  const word = context.matchBefore(spec?.word ?? /[\w$]+/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  const local = localWords(context.state, where.from, where.to, word.text)
  if (!spec) return local.length ? { from: word.from, options: local } : null
  const known = new Set(languageOptions(spec).map((o) => o.label))
  return {
    from: word.from,
    options: [...languageOptions(spec), ...local.filter((o) => !known.has(o.label))]
  }
}

export function notelyCompletions(context: CompletionContext): CompletionResult | null {
  const where = locate(context.state, context.pos)
  if (!where) return null
  return where.kind === 'math' ? latexCompletions(context) : codeCompletions(context, where)
}

export const completions = autocompletion({
  override: [notelyCompletions],
  icons: true,
  maxRenderedOptions: 60
})
