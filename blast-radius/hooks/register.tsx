import type { EngineInterface, Register } from 'claude-code'

// What one destructive step of a command would do.
type Effect = {
  label: string // e.g. "rm -rf build"
  paths: string[] // what it removes or discards (may be partial, see isCapped)
  files: number // files counted (walks are capped)
  bytes: number
  isCapped: boolean
  notes: string[]
}

type Word = { text: string; isGlob: boolean }

const HEADER = 'Blast radius'
const RUN = 'Run it'
const CANCEL = 'Cancel'
const WALK_CAP = 5000 // entries walked per target before giving up counting
const KEEP_PATHS = 300 // paths kept for the list

// Questions waiting on the person, by question text, for the dialog's drawing.
const pending = new Map<string, Effect[]>()

// ---------- shell parsing (good enough for review, not a full shell) ----------

function splitSegments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') cur += c + (command[++i] ?? '')
      else cur += c
      if (quote === null) cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === '\\') {
      cur += c + (command[++i] ?? '')
      continue
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function tokenize(segment: string): Word[] {
  const words: Word[] = []
  let text = ''
  let isGlob = false
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] ?? ''
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) text += segment[++i]
      else text += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
      continue
    }
    if (c === '\\' && i + 1 < segment.length) {
      text += segment[++i]
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has || text) words.push({ text, isGlob })
      text = ''
      isGlob = false
      has = false
      continue
    }
    if (c === '*' || c === '?' || c === '[') isGlob = true
    text += c
    has = true
  }
  if (has || text) words.push({ text, isGlob })
  return words
}

// Drops redirections (`2>/dev/null`, `> out.txt`): they are not targets.
function dropRedirects(words: Word[]): Word[] {
  const out: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]?.text ?? ''
    if (/^\d*(>>?|<)$/.test(w)) i++ // the next word is the file
    else if (!/^\d*(>>?|<)/.test(w)) out.push(words[i]!)
  }
  return out
}

// Drops `sudo`, `env X=y`, `command`, `nohup`, `time` and leading assignments.
function stripPrefixes(all: Word[]): Word[] {
  const words = dropRedirects(all)
  let i = 0
  while (i < words.length) {
    const w = words[i]?.text ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
    else if (['sudo', 'command', 'nohup', 'time', 'env', 'exec'].includes(w)) i++
    else if (words[i - 1]?.text === 'sudo' && w.startsWith('-')) i++
    else break
  }
  return words.slice(i)
}

const join = (dir: string, p: string) =>
  p.startsWith('/') ? p : `${dir.replace(/\/$/, '')}/${p}`

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

// ---------- measuring ----------

async function expand($: EngineInterface, cwd: string, home: string, w: Word): Promise<string[]> {
  let text = w.text
  if (text === '~' || text.startsWith('~/')) text = home + text.slice(1)
  if (!w.isGlob) return [normalize(join(cwd, text))]
  // Expand only plain globs: nothing a shell would run.
  if (!/^[\w.\/*?\[\]\-+@%=:,~]+$/.test(text)) return []
  const r = await $.process.run(
    ['bash', '-c', `shopt -s nullglob globstar; for f in ${text}; do printf '%s\\0' "$f"; done`],
    { cwd, timeoutMs: 5000 },
  )
  return r.stdout.split('\0').filter(Boolean).map(p => normalize(join(cwd, p)))
}

async function measure($: EngineInterface, paths: string[], isRecursive: boolean, effect: Effect) {
  let walked = 0
  const visit = async (path: string): Promise<void> => {
    if (walked >= WALK_CAP) {
      effect.isCapped = true
      return
    }
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (!stat) {
      effect.notes.push(`${path} does not exist`)
      return
    }
    walked++
    if (stat.kind === 'dir' && !stat.isLink) {
      if (!isRecursive) return
      if (effect.paths.length < KEEP_PATHS) effect.paths.push(path + '/')
      const entries = await $.fs.list(path).catch(() => [])
      for (const entry of entries) await visit(`${path}/${entry.name}`)
      return
    }
    effect.files++
    effect.bytes += stat.size
    if (effect.paths.length < KEEP_PATHS) effect.paths.push(path)
  }
  for (const path of paths) await visit(path)
}

function newEffect(label: string): Effect {
  return { label, paths: [], files: 0, bytes: 0, isCapped: false, notes: [] }
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string[]> {
  const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 10000 })
  return r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : []
}

// Reads one segment; returns what it would destroy, or undefined when harmless.
async function inspect(
  $: EngineInterface,
  cwd: string,
  home: string,
  words: Word[],
): Promise<Effect | undefined> {
  const [cmd, ...rest] = words
  if (!cmd) return undefined
  const name = cmd.text.split('/').pop() ?? cmd.text
  const label = words.map(w => w.text).join(' ').slice(0, 120)
  const hasDynamic = (ws: Word[]) => ws.some(w => /[$`]/.test(w.text))

  if (['rm', 'rmdir', 'unlink', 'shred'].includes(name)) {
    const effect = newEffect(label)
    let isRecursive = name === 'rmdir'
    let isEndOfFlags = false
    const targets: Word[] = []
    for (const w of rest) {
      if (!isEndOfFlags && w.text === '--') isEndOfFlags = true
      else if (!isEndOfFlags && w.text.startsWith('-') && w.text.length > 1) {
        if (/^-[a-zA-Z]*[rR]/.test(w.text) || w.text === '--recursive') isRecursive = true
      } else targets.push(w)
    }
    if (hasDynamic(targets)) effect.notes.push('Some targets are computed when it runs ($VAR or $(...)), so they cannot be listed.')
    const paths: string[] = []
    for (const t of targets.filter(t => !/[$`]/.test(t.text))) {
      const found = await expand($, cwd, home, t)
      if (t.isGlob && found.length === 0) effect.notes.push(`${t.text} matches nothing (or could not be expanded)`)
      paths.push(...found)
    }
    for (const p of paths) if (p === '/' || p === home) effect.notes.push(`!! This targets ${p} itself.`)
    await measure($, paths, isRecursive, effect)
    return effect
  }

  if (name === 'find' && rest.some(w => w.text === '-delete')) {
    const effect = newEffect(label)
    const unsafe = rest.some(w => /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w.text))
    if (unsafe || hasDynamic(rest)) {
      effect.notes.push('This find also runs other actions, so it was not dry-run.')
      return effect
    }
    const argv = ['find', ...rest.filter(w => w.text !== '-delete').map(w => w.text)]
    const r = await $.process.run(argv, { cwd, timeoutMs: 15000 })
    const lines = r.stdout.split('\n').filter(Boolean)
    effect.files = lines.length
    effect.paths = lines.slice(0, KEEP_PATHS).map(p => normalize(join(cwd, p)))
    return effect
  }

  if (name !== 'git') return undefined
  const sub = rest.findIndex(w => !w.text.startsWith('-'))
  let gitCwd = cwd
  const dashC = rest.findIndex(w => w.text === '-C')
  if (dashC >= 0 && rest[dashC + 1]) gitCwd = normalize(join(cwd, rest[dashC + 1]!.text))
  const subIndex = dashC >= 0 ? rest.findIndex((w, i) => i > dashC + 1 && !w.text.startsWith('-')) : sub
  const verb = rest[subIndex]?.text
  const args = rest.slice(subIndex + 1).map(w => w.text)
  if (!verb) return undefined

  if (verb === 'clean') {
    if (!args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')) return undefined
    const effect = newEffect(label)
    const keep = args.filter(a => !/^-[a-zA-Z]*[fniq]/.test(a) && !['--force', '--dry-run', '--interactive', '--quiet'].includes(a))
    const flags = args.filter(a => /^-[a-zA-Z]+$/.test(a)).join('').replace(/[-fniq]/g, '')
    const lines = await git($, gitCwd, ['clean', '-n', ...(flags ? [`-${flags}`] : []), ...keep.filter(a => !/^-[a-zA-Z]+$/.test(a))])
    effect.paths = lines.map(l => l.replace(/^Would remove /, '')).slice(0, KEEP_PATHS)
    effect.files = lines.length
    effect.notes.push('Untracked files: not in git, so they cannot be restored.')
    return effect
  }

  if (verb === 'reset' && args.includes('--hard')) {
    const effect = newEffect(label)
    const lines = await git($, gitCwd, ['status', '--porcelain', '--untracked-files=no'])
    effect.paths = lines.map(l => l.slice(3)).slice(0, KEEP_PATHS)
    effect.files = lines.length
    effect.notes.push('Uncommitted changes to these tracked files are thrown away.')
    const ref = args.find(a => !a.startsWith('-'))
    if (ref) effect.notes.push(`Also moves the branch to ${ref}: commits after it leave the branch.`)
    return effect
  }

  const isRestore = verb === 'restore' && !args.includes('--staged')
  const isCheckoutPaths = verb === 'checkout' && (args.includes('--') || args.includes('.'))
  if (isRestore || isCheckoutPaths) {
    const effect = newEffect(label)
    const after = args.includes('--') ? args.slice(args.indexOf('--') + 1) : args.filter(a => !a.startsWith('-'))
    const paths = after.length ? after : ['.']
    const lines = await git($, gitCwd, ['diff', '--name-only', '--', ...paths])
    effect.paths = lines.slice(0, KEEP_PATHS)
    effect.files = lines.length
    effect.notes.push('Unstaged edits to these files are thrown away.')
    return effect
  }

  if (verb === 'stash' && ['drop', 'clear'].includes(args[0] ?? '')) {
    const effect = newEffect(label)
    const lines = await git($, gitCwd, ['stash', 'list'])
    effect.notes.push(args[0] === 'clear' ? `Deletes all ${lines.length} stashes.` : `Deletes ${args[1] ?? 'the latest stash'}.`)
    return effect
  }

  if (verb === 'branch' && args.some(a => a === '-D' || (a.startsWith('-') && a.includes('D')))) {
    const effect = newEffect(label)
    effect.notes.push(`Force-deletes branch ${args.filter(a => !a.startsWith('-')).join(', ')}, merged or not.`)
    return effect
  }

  return undefined
}

async function blastRadius($: EngineInterface, command: string): Promise<Effect[]> {
  let cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? '/'
  const effects: Effect[] = []
  for (const segment of splitSegments(command)) {
    const words = stripPrefixes(tokenize(segment))
    if (words[0]?.text === 'cd') {
      const to = words[1]?.text ?? home
      cwd = normalize(join(cwd, to.startsWith('~') ? home + to.slice(1) : to))
      continue
    }
    if (words[0]?.text === 'xargs' && words.some(w => ['rm', 'shred', 'unlink'].includes(w.text))) {
      const e = newEffect(words.map(w => w.text).join(' ').slice(0, 120))
      e.notes.push('Deletes whatever the previous command prints, so the targets cannot be listed ahead of time.')
      effects.push(e)
      continue
    }
    const effect = await inspect($, cwd, home, words)
    if (effect) effects.push(effect)
  }
  return effects
}

// ---------- presenting ----------

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function summary(effects: Effect[]): string {
  const files = effects.reduce((n, e) => n + e.files, 0)
  const bytes = effects.reduce((n, e) => n + e.bytes, 0)
  const capped = effects.some(e => e.isCapped) ? '+' : ''
  const what = files > 0 ? `${files}${capped} file${files === 1 ? '' : 's'}${bytes ? ` (${size(bytes)})` : ''}` : 'data that cannot be listed in advance'
  return `This command would delete or discard ${what}. Run it?`
}

function shorten(path: string, cwd: string, max: number): string {
  const rel = path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
  return rel.length <= max ? rel : '…' + rel.slice(rel.length - max + 1)
}

let lastCwd = '/'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const effects = await blastRadius($, e.command)
    if (effects.length === 0) return next(e)
    lastCwd = await $.session.cwd()

    const question = summary(effects)
    pending.set(question, effects)
    let answer: string | undefined
    try {
      answer = await $.ui.ask(question, { header: HEADER, options: [CANCEL, RUN] })
    } catch {
      answer = undefined // dismissed, or nobody to ask
    } finally {
      pending.delete(question)
    }
    if (answer === RUN) return next(e)
    return {
      deny: `${$.plugin.name}: the user cancelled this command after seeing what it would delete. Do not retry it; ask the user how they want to proceed.`,
    }
  }).catch(($, e, next) => {
    // The guard itself failed: let the command go through to the normal permission flow.
    $.ui.log(`${$.plugin.name}: could not measure this command; passing it on.`, { to: 'debug' })
    return next(e)
  })

  // Draws the list of targets above the engine's own question dialog.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const first = e.props.questions[0] as { header?: string; question?: string } | undefined
    const effects = first?.header === HEADER && first.question ? pending.get(first.question) : undefined
    if (!effects) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const room = isTerminal ? 4 : 14
    const width = 38 // each list row stays one counted row
    const rows: string[] = []
    const notes: string[] = []
    for (const effect of effects) {
      notes.push(...effect.notes)
      for (const p of effect.paths) rows.push(shorten(p, lastCwd, width))
    }
    const total = effects.reduce((n, x) => n + x.paths.length, 0)
    const more = Math.max(0, effects.reduce((n, x) => n + Math.max(x.files, x.paths.length), 0) - Math.min(room, rows.length))

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          {effects.slice(0, isTerminal ? 1 : 3).map(x => (
            <Text bold color="warning">$ {x.label.slice(0, width)}</Text>
          ))}
          {rows.slice(0, room).map(r => (
            <Text color="error">- {r}</Text>
          ))}
          {more > 0 && <Text dimColor>…and {more} more</Text>}
          {total === 0 && notes.length === 0 && <Text dimColor>Nothing found to delete.</Text>}
          {notes.slice(0, isTerminal ? 1 : 4).map(n => (
            <Text dimColor>{n.slice(0, 2 * width)}</Text>
          ))}
        </Box>
        {await next(e)}
      </Box>
    )
  })
}
