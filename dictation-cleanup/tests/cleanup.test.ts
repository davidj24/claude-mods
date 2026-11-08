import { expect, mock, test } from 'claude-code/testing'

const cases: [string, string][] = [
  ['Um, so I want to, uh, fix the the build.', 'So I want to fix the build.'],
  ['Can you, um, check this? Uh I think it broke.', 'Can you check this? I think it broke.'],
  ['I know that that works and I had had enough.', 'I know that that works and I had had enough.'],
  ['Run `rm um uh` please', 'Run `rm um uh` please'],
  ['the umbrella and the hummus stay', 'the umbrella and the hummus stay'],
  ['```\nuh = 1\nuh uh\n```\num okay', '```\nuh = 1\nuh uh\n```\nOkay'],
]

test('fillers and stutters go, real words and code stay', async ($, on) => {
  mock.store(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'dictation-cleanup' } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context ?? [] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const [said, want] of cases) {
    const r = await $.prompt.submit({ text: said })
    expect(r.text).toBe(want)
  }
})
