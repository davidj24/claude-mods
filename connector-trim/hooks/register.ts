import type { Register } from 'claude-code'

// Shrinks large connector (MCP) results with fixed rules, never a model:
// - JSON: drops null, "", [] and {} values, image and avatar links, base64
//   blobs and etags, then re-prints it compact (no indentation).
// - Plain text: trims trailing spaces and collapses runs of blank lines.
// Every word of real content stays. The full result is saved to a file, and
// Claude is told the path, so nothing is ever out of reach.

const MIN_CHARS = 2000 // smaller results pass untouched
const MIN_SAVING = 0.1 // keep the original unless at least 10% goes
const DIR = '/tmp/claude-connector-trim'

// Servers left alone: browsers, the app's own tools, and mods' own tools.
const SKIP = /^mcp__(claude-in-chrome|Claude_Browser|remote-devices|ccd_|plugin-|plugin_|easel|visualize|terminal|scheduled-tasks|mcp-registry)/

const IMAGE_KEY = /(avatar|image|photo|picture|thumbnail|icon|logo|gravatar)s?(_?(url|urls|uri|src|link))?$/i
const NOISE_KEY = /^(etag|_etag)$/i
const IMAGE_URL = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|ico)(\?\S*)?$/i
const BLOB = /^(data:[^,]{0,80},)?[A-Za-z0-9+/=_-]{400,}$/

const isEmpty = (v: unknown) =>
  v === null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)

export const prune = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(prune).filter(x => !isEmpty(x))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (IMAGE_KEY.test(k) || NOISE_KEY.test(k)) continue
      if (typeof x === 'string' && (IMAGE_URL.test(x) || BLOB.test(x))) continue
      const p = prune(x)
      if (!isEmpty(p)) out[k] = p
    }
    return out
  }
  return v
}

export const trimText = (s: string): string => {
  const t = s.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(prune(JSON.parse(t)))
    } catch {
      // not JSON after all: fall through to plain text
    }
  }
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')
}

type Block = { type?: string; text?: string }

// Applies trimText to the result whatever shape core gave it: a string, a list
// of content blocks, or `{ content: [...] }`.
const trimResult = (r: unknown): unknown => {
  if (typeof r === 'string') return trimText(r)
  if (Array.isArray(r))
    return r.map((b: Block) => (b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: trimText(b.text) } : b))
  // structuredContent is kept as is: a tool's output schema may require it.
  if (r && typeof r === 'object' && Array.isArray((r as { content?: unknown }).content))
    return { ...(r as object), content: trimResult((r as { content: unknown }).content) }
  return r
}

const size = (r: unknown) => (typeof r === 'string' ? r.length : JSON.stringify(r ?? '').length)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'trim',
      description: 'Connector result trimming: /trim on | off | status',
    })
    return next(e)
  })

  on('command.run', { command: 'trim' }, async ($, e) => {
    const arg = String((e as { args?: string }).args ?? '').trim()
    if (arg === 'off') await $.store.set('off', true)
    else if (arg === 'on') await $.store.set('off', false)
    else if (arg && arg !== 'status') return { text: 'Use /trim on, off or status.' }
    const off = (await $.store.get('off')) === true
    const n = Number((await $.store.get('count')) ?? 0)
    const saved = Number((await $.store.get('saved')) ?? 0)
    return {
      text: `Connector trimming is ${off ? 'off' : 'on'}. ${n} results trimmed, about ${Math.round(saved / 4).toLocaleString()} tokens saved. Full results are in ${DIR}.`,
    }
  })

  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith('mcp__') || SKIP.test(e.tool)) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    if ((await $.store.get('off')) === true) return ran

    const before = size(ran.result)
    if (before < MIN_CHARS) return ran
    const trimmed = trimResult(ran.result)
    const after = size(trimmed)
    if (after > before * (1 - MIN_SAVING)) return ran

    const path = `${DIR}/${e.tool_use_id}.txt`
    await $.fs.write(path, ran.text ?? JSON.stringify(ran.result))
    await $.store.set('count', Number((await $.store.get('count')) ?? 0) + 1)
    await $.store.set('saved', Number((await $.store.get('saved')) ?? 0) + (before - after))

    return {
      result: trimmed as typeof ran.result,
      context: [
        ...(ran.context ?? []),
        `connector-trim removed empty fields, image links and padding from this result (${before} → ${after} chars). No text content was removed. The untrimmed result is at ${path}.`,
      ],
    }
  })
}
