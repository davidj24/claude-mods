import { expect, mock, test } from 'claude-code/testing'

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
  for (let i = 0; i < 50 && !(await ui.find({ type: 'Client', key: 'speed' })); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
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

test('a reading shows the player, its buttons reach the reader, and replies are sent', async ($, on) => {
  const calls: { path: string; stdin?: string }[] = []
  const clock = mock.clock(on)
  mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1000' })
  on('command.register', () => ({ value: { command: 'voices' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('process.run', (_, e) => {
    const path = String(e.argv[8]).replace('http://localhost', '')
    calls.push({ path, stdin: e.init?.stdin })
    const stdout = path === '/status'
      ? JSON.stringify({ state: 'playing', buffering: false, voice: 'af_heart', speed: 1, autoRead: true, position: 62, duration: 190, isEstimate: true, index: 2, count: 9, text: 'The current sentence.' })
      : '{"ok":true}'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /sentence 3 of 9/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /1:02 \/ about 3:10/ }))).toBeTruthy()
  expect(await ui.find({ type: 'Client', key: 'seek' })).toBeTruthy()

  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'stop' })
  await ui.post({ to: 30 }, { in: 'seek' })
  for (const path of ['/toggle', '/skip?by=-10', '/sentence?by=1', '/stop', '/seek?to=30.00']) {
    expect(calls.some(c => c.path === path)).toBe(true)
  }

  const finished = { durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const, answer: 'Hello there.' }
  await $.turn.complete(finished)
  expect(calls.some(c => c.path === '/speak?source=claude' && c.stdin === 'Hello there.')).toBe(true)
  calls.length = 0
  await $.turn.complete({ ...finished, agentId: 'sub' })
  expect(calls.some(c => c.path.startsWith('/speak'))).toBe(false)
  await ui.unmount()
})
