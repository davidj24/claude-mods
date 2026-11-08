import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'voice-picker',
  component: 'Pane',
  requestId: 'voices',
  props: {
    title: 'Voices',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('opens at session start, shows a slider and a typed speed that saves', async ($, on) => {
  const calls: string[][] = []
  const opened: string[] = []
  let speed = 1
  on('command.register', () => ({ value: { command: 'voices' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.close', () => ({ value: undefined }))
  // The engine's own band beneath the mod: here, one line of text.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('process.run', (_, e) => {
    const args = e.argv.slice(4)
    calls.push(args)
    if (args[0] === '--set-speed') speed = Number(args[1])
    const stdout = args[0] === '--get-config'
      ? JSON.stringify({ provider: 'kokoro', voice: 'bf_emma', speed, auto_read: false })
      : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toContain('voices')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The Voices button is there even while the pane is open, left of other bands.
  const band0 = await $.ui.mount({ plugin: 'voice-picker', component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 80 } as never })
  expect(await band0.find({ type: 'Button', key: 'show-voices' })).toBeTruthy()
  await band0.unmount()
  expect(await ui.find({ type: 'Client', key: 'speed' })).toBeTruthy()

  await ui.input({ key: 'speed-typed', text: '1.25' })
  expect(calls.some(a => a[0] === '--set-speed' && a[1] === '1.25')).toBe(true)

  await ui.post({ speed: 9 }, { in: 'speed' })
  expect(calls.some(a => a[0] === '--set-speed' && a[1] === '2')).toBe(true)

  // Dragging the slider to its left end and letting go saves the minimum.
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left' })
  // While dragging, the speed beside the bar follows the pointer before any save.
  expect((await ui.find({ type: 'Text', text: /0\.50×/, in: 'speed' }))?.text).toBe('0.50×')
  expect(calls.some(a => a[0] === '--set-speed' && a[1] === '0.5')).toBe(false)
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left' })
  // After release it stays at the new value.
  expect(await ui.find({ type: 'Text', text: /0\.50×/, in: 'speed' })).toBeTruthy()
  expect(calls.some(a => a[0] === '--set-speed' && a[1] === '0.5')).toBe(true)

  // Hide folds the pane into a Voices button above the prompt, which reopens it.
  await ui.press({ key: 'hide' })
  await ui.unmount()
  const band = await $.ui.mount({ plugin: 'voice-picker', component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 80 } as never })
  expect(await band.find({ type: 'Button', key: 'show-voices' })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /engine band/ })).toBeTruthy()
  const before = opened.length
  await band.press({ key: 'show-voices' })
  expect(opened.length).toBe(before + 1)
  await band.unmount()
})
