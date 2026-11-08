import type { Register } from 'claude-code'

// Standalone fillers, with the comma or pause that usually trails them.
const FILLER = /(?:,\s*)?\b(?:u+m+|u+h+m*|e+r+m+|h+m+|m{2,}|a+h+)\b(?:\s*,)?/gi
// Doubled words like "the the"; some doubles are real English ("that that", "had had").
const REPEAT = /\b([A-Za-z']+)(?:\s+\1\b)+/gi
const REAL_DOUBLES = new Set(['that', 'had', 'is', 'do', 'no', 'so', 'very', 'really', 'bye', 'ha', 'haha', 'la', 'knock', 'ho', 'chop', 'tsk', 'yeah', 'go'])

// A line that looks like code, a path or a log line is left alone.
const CODE_LINE = /^(\s{4,}|\t)|[{};]\s*$|=>|::|^\s*[$#>]\s|\b(def|function|const|let|import|return)\b/

export type Cleaned = { text: string; removed: number }

export function cleanDictation(input: string): Cleaned {
  let removed = 0
  // Fenced blocks and inline code stay as typed.
  const parts = input.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part
    return part
      .split('\n')
      .map(line => {
        if (CODE_LINE.test(line)) return line
        let next = line.replace(FILLER, () => {
          removed++
          return ''
        })
        next = next.replace(REPEAT, (m: string, word: string) => {
          if (REAL_DOUBLES.has(word.toLowerCase())) return m
          removed++
          return word
        })
        if (next === line) return line
        return next
          .replace(/ {2,}/g, ' ')
          .trim()
          .replace(/\s+([,.;!?])/g, '$1') // " ," -> ","
          .replace(/([,;])[,;.]/g, '$1') // ",," left behind
          .replace(/(^|[.!?]\s+)[,;]\s*/g, '$1') // sentence that now opens with ","
          .replace(/(^|[.!?]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())
      })
      .join('\n')
  })
  return { text: out.join(''), removed }
}

const KEY = 'enabled'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dictation-cleanup',
      description: 'Turn dictation cleanup on or off (strips um/uh and stutter repeats)',
      argumentHint: 'on | off',
    })
    return next(e)
  })

  on('command.run', { command: 'dictation-cleanup' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = (await $.store.get(KEY)) !== false
    const value = arg === 'on' ? true : arg === 'off' ? false : !current
    await $.store.set(KEY, value)
    return { text: `Dictation cleanup is ${value ? 'on' : 'off'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    if ((await $.store.get(KEY)) === false) return next(e)
    const { text, removed } = cleanDictation(e.text)
    if (removed === 0 || text.trim() === '') return next(e)
    $.ui.status(`dictation cleanup: removed ${removed}`)
    return next({ ...e, text })
  })
}
