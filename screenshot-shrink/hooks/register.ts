import type { Register } from 'claude-code'

// Browser tools whose screenshots take a `scale` (Claude in Chrome and the
// desktop app's built-in browser, local or through remote-devices).
const BROWSER = /^mcp__(claude-in-chrome|Claude_Browser|remote-devices__Claude_Browser)__(computer|browser_batch)$/
const DEFAULT_SCALE = 0.5

type Input = Record<string, unknown>

// Adds `scale` to a screenshot that names none. Zoom is left alone: Claude
// zooms to read detail.
const shrink = (input: Input, scale: number): Input | undefined =>
  input.action === 'screenshot' && input.scale === undefined
    ? { ...input, scale }
    : undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'shrink',
      description: 'Browser screenshot size: /shrink on | off | 0.1-1 | status',
    })
    return next(e)
  })

  on('command.run', { command: 'shrink' }, async ($, e) => {
    const arg = String((e as { args?: string }).args ?? '').trim()
    const n = Number(arg)
    if (arg === 'off') await $.store.set('scale', 1)
    else if (arg === 'on') await $.store.set('scale', DEFAULT_SCALE)
    else if (arg && n >= 0.1 && n <= 1) await $.store.set('scale', n)
    else if (arg && arg !== 'status')
      return { text: 'Use /shrink on, off, a scale from 0.1 to 1, or status.' }
    const scale = Number((await $.store.get('scale')) ?? DEFAULT_SCALE)
    const count = Number((await $.store.get('count')) ?? 0)
    return {
      text:
        (scale >= 1 ? 'Screenshot shrinking is off.' : `Screenshots are taken at ${scale}x.`) +
        ` ${count} screenshots shrunk so far.`,
    }
  })

  on('tool.call', async ($, e, next) => {
    const m = BROWSER.exec(e.tool)
    if (!m) return next(e)
    const scale = Number((await $.store.get('scale')) ?? DEFAULT_SCALE)
    if (scale >= 1) return next(e)

    const input = e as unknown as Input
    let shrunk = 0
    let rewritten: Input | undefined

    if (m[2] === 'computer') {
      rewritten = shrink(input, scale)
      if (rewritten) shrunk = 1
    } else if (Array.isArray(input.actions)) {
      const actions = (input.actions as { name?: string; input?: Input }[]).map(a => {
        const out = a.name === 'computer' && a.input ? shrink(a.input, scale) : undefined
        if (!out) return a
        shrunk++
        return { ...a, input: out }
      })
      if (shrunk) rewritten = { ...input, actions }
    }

    if (!rewritten) return next(e)
    const count = Number((await $.store.get('count')) ?? 0) + shrunk
    await $.store.set('count', count)
    return next(rewritten as typeof e)
  })
}
