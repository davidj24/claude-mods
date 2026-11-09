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

test('uses whichever name Python answers to, and never needs sh', async ($, on) => {
  const tried: string[] = []
  let launcher = ''
  on('command.register', () => ({ value: { command: 'voices' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    tried.push(e.argv[0])
    launcher = e.argv[2]
    if (e.argv[0] === 'python3') return { deny: 'cannot start' }
    const stdout = JSON.stringify({ provider: 'kokoro', voice: 'bf_emma', speed: 1, auto_read: false })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The speed control only draws once the settings came back through the fallback.
  let speedControl = await ui.find({ type: 'Client', key: 'speed' })
  for (let i = 0; i < 50 && !speedControl; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    speedControl = await ui.find({ type: 'Client', key: 'speed' })
  }
  expect(speedControl).toBeTruthy()
  expect(tried).toContain('python')
  expect(tried).not.toContain('sh')
  expect(launcher).not.toContain('\n')
  await ui.unmount()
})

test('Stop ends the whole reading on Windows, in one line', async ($, on) => {
  const launchers: string[] = []
  on('command.register', () => ({ value: { command: 'voices' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    if (e.argv[3] === '--stop') launchers.push(e.argv[2])
    const stdout = JSON.stringify({ provider: 'kokoro', voice: 'bf_emma', speed: 1, auto_read: false })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (let i = 0; i < 50 && !(await ui.find({ type: 'Button', key: 'stop' })); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await ui.press({ key: 'stop' })
  for (let i = 0; i < 50 && launchers.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(launchers[0]).toContain('taskkill')
  expect(launchers[0]).not.toContain('\n')
  await ui.unmount()
})

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
    const args = e.argv.slice(3)
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
