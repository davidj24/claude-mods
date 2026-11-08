import { expect, test } from 'claude-code/testing'

// $.ui.ask is an AskUserQuestion tool call; this answers it as the person would.
const answer = (label: string, seen?: (q: string) => void) => (_: unknown, e: { questions: { question: string }[] }) => {
  const q = e.questions[0]?.question ?? ''
  seen?.(q)
  return { result: { questions: e.questions, answers: { [q]: label } } } as never
}

test('a harmless command runs without a question', async ($, on) => {
  let asked = 0
  on('session.cwd', () => ({ value: '/proj' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('tool.call', { tool: 'AskUserQuestion' }, answer('Cancel', () => asked++))
  on('tool.call', () => ({ result: {} }) as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
  expect(asked).toBe(0)
  expect(r.isError).not.toBe(true)
})

test('rm -rf asks, lists, and Cancel denies', async ($, on) => {
  let question = ''
  on('session.cwd', () => ({ value: '/proj' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.stat', (_, e) => {
    const p = (e as { path: string }).path
    if (p === '/proj/build') return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    return { value: { kind: 'file', size: 2048, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', () => ({ value: [
    { name: 'a.o', kind: 'file', size: 2048, mtimeMs: 0, isLink: false },
    { name: 'b.o', kind: 'file', size: 2048, mtimeMs: 0, isLink: false },
  ] }))
  on('tool.call', { tool: 'AskUserQuestion' }, answer('Cancel', q => { question = q }))
  let ran = false
  on('tool.call', { tool: 'Bash' }, () => { ran = true; return { result: {} } as never })
  const r = await $.tool.call({ tool: 'Bash', command: 'cd /proj && rm -rf build 2>/dev/null' })
  expect(question).toContain('2 files')
  expect(ran).toBe(false)
  expect(r.deny).toContain('cancelled')
})

test('Run it lets the command through', async ($, on) => {
  on('session.cwd', () => ({ value: '/proj' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('tool.call', { tool: 'AskUserQuestion' }, answer('Run it'))
  let ran = false
  on('tool.call', { tool: 'Bash' }, () => { ran = true; return { result: {} } as never })
  await $.tool.call({ tool: 'Bash', command: 'git branch -D old-feature' })
  expect(ran).toBe(true)
})
