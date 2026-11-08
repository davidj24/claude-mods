import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-07T20:00:00Z')
const seeded: Record<string, unknown> = {
  lastAt: NOW - 18 * 60_000,
  ttlMin: 60,
  rate: { pct: 2, weight: 200_000 },
  lastTurnPct: 0.8,
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the bar draws cache heat and both limits on ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    // The engine beneath answers with its own (here empty) band.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    on('state.get', (_, e) => {
      const key = (e as { key: string }).key
      return key in seeded ? ({ value: { value: seeded[key], version: 1 } } as never) : ({ value: { version: 0 } } as never)
    })
    on('session.usage', () => ({
      value: {
        startedAt: NOW - 3_600_000,
        context: { tokens: 85_000, window: 200_000, percent: 42 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 18, resetsAt: '2026-11-07T22:10:00Z' },
          { kind: 'seven_day', percentUsed: 32, resetsAt: '2026-11-11T00:00:00Z' },
        ],
      },
    }) as never)
    const ui = await $.ui.mount({
      plugin: 'cache-thermometer',
      surface,
      component: 'AbovePrompt',
      requestId: 'above-prompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
    } as never)
    expect((await ui.find({ type: 'Text', text: /WARM/ }))?.text).toContain('WARM')
    expect((await ui.find({ type: 'Text', text: /42:00/ }))?.text).toContain('42:00')
    expect((await ui.find({ type: 'Text', text: /82% left/ }))?.text).toContain('82% left')
    expect((await ui.find({ type: 'Text', text: /68% left/ }))?.text).toContain('68% left')
    expect((await ui.find({ type: 'Text', text: /20× more/ }))?.text).toContain('20× more')
    expect((await ui.find({ type: 'Text', text: /keep warm/ }))?.text).toBe('Under 19 h: keep warm')
    await ui.unmount()
  })
}

test('a band drawn beneath (another mod) is carried in the bar', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    return key in seeded ? ({ value: { value: seeded[key], version: 1 } } as never) : ({ value: { version: 0 } } as never)
  })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: [] } }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other mod</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'cache-thermometer',
    surface: 'desktop',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as never)
  expect(await ui.find({ type: 'Text', text: /other mod/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /WARM/ })).toBeTruthy()
  await ui.unmount()
})
