import { expect, test } from 'claude-code/testing'

import { detectTtl } from '../hooks/register'

const row = (one: number, five: number, extra = {}) =>
  JSON.stringify({ ...extra, message: { usage: { cache_creation: { ephemeral_1h_input_tokens: one, ephemeral_5m_input_tokens: five } } } })

test('reads the latest main-thread cache write', async () => {
  expect(detectTtl([row(500, 0), row(0, 0)].join('\n'))).toBe(60)
  expect(detectTtl([row(500, 0), row(0, 800)].join('\n'))).toBe(5)
  expect(detectTtl([row(0, 800), row(0, 0, { isSidechain: true }), row(300, 0, { isSidechain: true })].join('\n'))).toBe(5)
  expect(detectTtl('{"type":"user"}\n{"cache_creation": broken')).toBe(undefined)
})
