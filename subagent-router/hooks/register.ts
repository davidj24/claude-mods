import type { Register } from 'claude-code'

// Picks a cheaper model for a subagent when Claude named none. Rules only, no
// model call. Anything unclear keeps the default (the main model).

// Agent types whose job is reading: fixed model.
const BY_TYPE: Record<string, 'haiku' | 'sonnet'> = {
  'web-fetch': 'haiku',
  Explore: 'haiku',
  'claude-code-guide': 'sonnet',
}

// Generic agents: work that needs the main model.
const HARD = /\b(implement|write (the )?code|fix|debug|refactor|design|architect|review|audit|security|prove|derive|migrat|edit|modify|build|plan)\w*/i
// Generic agents: reading and gathering.
const READING = /\b(summari[sz]e|search|find|read|fetch|look ?up|list|extract|collect|gather|research|check whether|compare)\w*/i
const GENERIC = new Set(['general-purpose', 'claude', ''])

type AgentInput = { subagent_type?: string; model?: string; prompt?: string; description?: string }

export const pick = (a: AgentInput): 'haiku' | 'sonnet' | undefined => {
  const type = a.subagent_type ?? ''
  if (a.model || type === 'fork') return undefined
  if (type in BY_TYPE) return BY_TYPE[type]
  if (!GENERIC.has(type)) return undefined
  const text = `${a.description ?? ''}\n${a.prompt ?? ''}`
  if (HARD.test(text)) return undefined
  return READING.test(text) ? 'sonnet' : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route-agents',
      description: 'Subagent model routing: /route-agents on | off | status',
    })
    return next(e)
  })

  on('command.run', { command: 'route-agents' }, async ($, e) => {
    const arg = String((e as { args?: string }).args ?? '').trim()
    if (arg === 'off') await $.store.set('off', true)
    else if (arg === 'on') await $.store.set('off', false)
    else if (arg && arg !== 'status') return { text: 'Use /route-agents on, off or status.' }
    const off = (await $.store.get('off')) === true
    const counts = ((await $.store.get('counts')) ?? {}) as Record<string, number>
    const tally = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet'
    return { text: `Subagent routing is ${off ? 'off' : 'on'}. Routed so far: ${tally}.` }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if ((await $.store.get('off')) === true) return next(e)
    const model = pick(e as unknown as AgentInput)
    if (!model) return next(e)
    const counts = ((await $.store.get('counts')) ?? {}) as Record<string, number>
    await $.store.set('counts', { ...counts, [model]: (counts[model] ?? 0) + 1 })
    $.ui.toast(`subagent-router: ${(e as unknown as AgentInput).description ?? 'subagent'} → ${model}`)
    return next({ ...e, model } as typeof e)
  })
}
