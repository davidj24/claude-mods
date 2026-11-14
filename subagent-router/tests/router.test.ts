import { expect, test } from 'claude-code/testing'

const run = async ($: any, seen: Record<string, unknown>[], input: Record<string, unknown>) => {
  await $.tool.call({ tool: 'Agent', ...input })
  return seen[seen.length - 1].model
}

test('reading work goes to cheaper models; hard or named work does not', async ($, on) => {
  const seen: Record<string, unknown>[] = []
  const store: Record<string, unknown> = {}
  on('store.get', (_, e: any) => ({ value: store[e.key] }))
  on('store.set', (_, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('tool.call', (_, e) => { seen.push(e as never); return { result: {} } })

  expect(await run($, seen, { subagent_type: 'web-fetch', description: 'x', prompt: 'Fetch a page' })).toBe('haiku')
  expect(await run($, seen, { subagent_type: 'Explore', description: 'x', prompt: 'Where is auth' })).toBe('haiku')
  expect(await run($, seen, { subagent_type: 'general-purpose', description: 'Summarize docs', prompt: 'Read these and summarize' })).toBe('sonnet')
  expect(await run($, seen, { subagent_type: 'general-purpose', description: 'Fix bug', prompt: 'Find and fix the crash' })).toBe(undefined)
  expect(await run($, seen, { subagent_type: 'general-purpose', description: 'x', prompt: 'Search the web', model: 'opus' })).toBe('opus')
  expect(await run($, seen, { subagent_type: 'fork', description: 'x', prompt: 'Read files' })).toBe(undefined)
  expect(await run($, seen, { subagent_type: 'Plan', description: 'x', prompt: 'Read files' })).toBe(undefined)
})
