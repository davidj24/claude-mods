import { expect, test } from 'claude-code/testing'

const big = {
  items: Array.from({ length: 30 }, (_, i) => ({
    id: i, title: `Assignment ${i} due Friday`, body: 'Read chapter 3 and answer every question.',
    avatar_url: 'https://cdn.example.com/a.png', etag: 'abc', notes: null, tags: [], meta: {},
    attachment: 'https://cdn.example.com/file.jpg', link: 'https://example.com/item',
  })),
}

test('a large connector result loses only empty fields and image links', async ($, on) => {
  const store: Record<string, unknown> = {}
  const files: Record<string, string> = {}
  on('store.get', (_, e: any) => ({ value: store[e.key] }))
  on('store.set', (_, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('fs.write', (_, e: any) => { files[e.path] = e.text; return { value: undefined } })
  const raw = JSON.stringify(big, null, 2)
  on('tool.call', () => ({ result: [{ type: 'text', text: raw }], text: raw }))

  const out: any = await $.tool.call({ tool: 'mcp__abc__list_issues', tool_use_id: 't1' } as never)
  const parsed = JSON.parse(out.result[0].text)
  expect(parsed.items.length).toBe(30)
  expect(parsed.items[3]).toEqual({ id: 3, title: 'Assignment 3 due Friday', body: 'Read chapter 3 and answer every question.', link: 'https://example.com/item' })
  expect(out.context[0]).toContain('/tmp/claude-connector-trim/t1.txt')
  expect(files['/tmp/claude-connector-trim/t1.txt']).toBe(raw)
})

test('small, browser and error results pass untouched', async ($, on) => {
  const store: Record<string, unknown> = {}
  on('store.get', (_, e: any) => ({ value: store[e.key] }))
  on('store.set', (_, e: any) => { store[e.key] = e.value; return { value: undefined } })
  const raw = JSON.stringify(big, null, 2)
  on('tool.call', (_, e: any) =>
    e.tool.endsWith('fail') ? { isError: true, result: raw, text: raw } :
    e.tool.endsWith('small') ? { result: '{"a": null}' } : { result: raw })

  expect(((await $.tool.call({ tool: 'mcp__x__small' } as never)) as any).result).toBe('{"a": null}')
  expect(((await $.tool.call({ tool: 'mcp__claude-in-chrome__get_page_text' } as never)) as any).result).toBe(raw)
  expect(((await $.tool.call({ tool: 'mcp__x__fail' } as never)) as any).result).toBe(raw)
})
