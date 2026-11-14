import { expect, test } from 'claude-code/testing'

test('a screenshot is taken at half size; zoom and set scales are left alone', async ($, on) => {
  const seen: Record<string, unknown>[] = []
  const store: Record<string, unknown> = {}
  on('store.get', (_, e: any) => ({ value: store[e.key] }))
  on('store.set', (_, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('tool.call', (_, e) => { seen.push(e as never); return { result: {} } })

  await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot', tabId: 1 } as never)
  await $.tool.call({ tool: 'mcp__Claude_Browser__computer', action: 'screenshot', scale: 1 } as never)
  await $.tool.call({ tool: 'mcp__Claude_Browser__computer', action: 'zoom', region: [0, 0, 9, 9] } as never)
  await $.tool.call({
    tool: 'mcp__claude-in-chrome__browser_batch',
    actions: [
      { name: 'navigate', input: { url: 'https://example.com' } },
      { name: 'computer', input: { action: 'screenshot', tabId: 1 } },
    ],
  } as never)

  expect(seen[0].scale).toBe(0.5)
  expect(seen[1].scale).toBe(1)
  expect(seen[2].scale).toBe(undefined)
  const batch = seen[3].actions as { input: Record<string, unknown> }[]
  expect(batch[0].input.scale).toBe(undefined)
  expect(batch[1].input.scale).toBe(0.5)
})
