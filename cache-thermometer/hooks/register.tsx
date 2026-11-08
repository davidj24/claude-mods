import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { CacheUsage, Rate, Warm } from '../types'

const lastAt = atom({ plugin: 'cache-thermometer', key: 'lastAt' } as const, null)
const ttlMin = atom({ plugin: 'cache-thermometer', key: 'ttlMin' } as const, 60)
const usage = atom({ plugin: 'cache-thermometer', key: 'usage' } as const, null, { shape: 'usage-2' })
const autoWarm = atom({ plugin: 'cache-thermometer', key: 'autoWarm' } as const, false)
const warmsLeft = atom({ plugin: 'cache-thermometer', key: 'warmsLeft' } as const, 0)
const tick = atom({ plugin: 'cache-thermometer', key: 'tick' } as const, 0)
const lastWarm = atom({ plugin: 'cache-thermometer', key: 'lastWarm' } as const, null)
const isHidden = atom({ plugin: 'cache-thermometer', key: 'isHidden' } as const, false)
const isWarming = atom({ plugin: 'cache-thermometer', key: 'isWarming' } as const, false)
const rate = atom({ plugin: 'cache-thermometer', key: 'rate' } as const, { pct: 0, weight: 0 })
const lastTurnPct = atom({ plugin: 'cache-thermometer', key: 'lastTurnPct' } as const, null)

// Auto-warm pings up to the break-even count per absence (19 on a 1-hour
// cache, 11 on a 5-minute one): back sooner, it saved; never back, it spent
// about one cold restart. Pinging past that point can only cost more.
const maxAuto = (ttl: number) => Math.floor(writeMult(ttl) / READ - 1)
const PING = 'Cache keep-alive ping from the cache-thermometer mod. Reply with only: ok'

// Relative price of a token by kind, input = 1 (API list-price ratios).
const READ = 0.1
const writeMult = (ttl: number) => (ttl === 60 ? 2 : 1.25)
const OUTPUT = 5

// Colors: warm orange, cooling amber, cold blue.
const WARM = '#ff8a3d'
const COOLING = '#ffc53d'
const COLD = '#5aa9ff'
const TRACK = '#2b2b2b'
const GOOD = '#5bd17a'
const MID = '#ffc53d'
const LOW = '#ff5c5c'

let isBusy = false // a turn of the main loop is running
let fiveHourBefore: number | null = null

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}
const pct = (p: number) => (p <= 0 ? '0%' : p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`)

function resetIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h >= 1) return `${h}h ${m}m`
  return `${m}m`
}

async function limits($: EngineInterface): Promise<readonly SessionRateLimit[]> {
  return $.session.usage().then(r => r.rateLimits).catch(() => [])
}

async function fiveHourUsed($: EngineInterface): Promise<number | null> {
  return (await limits($)).find(l => l.kind === 'five_hour')?.percentUsed ?? null
}

// Reads which cache lifetime the session's latest cache write actually used,
// from the transcript's own usage records: 60 (1-hour), 5 (5-minute), or
// undefined when no recent request wrote to the cache.
export function detectTtl(transcript: string): number | undefined {
  const lines = transcript.trimEnd().split('\n')
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 400; i--, seen++) {
    const line = lines[i] ?? ''
    if (!line.includes('"cache_creation"')) continue
    try {
      const row = JSON.parse(line) as {
        isSidechain?: boolean
        message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
      }
      const c = row.message?.usage?.cache_creation
      if (row.isSidechain || !c) continue
      if ((c.ephemeral_1h_input_tokens ?? 0) > 0) return 60
      if ((c.ephemeral_5m_input_tokens ?? 0) > 0) return 5
    } catch {
      // a line cut mid-write; look further back
    }
  }
  return undefined
}

async function remainingMs($: EngineInterface): Promise<number | null> {
  const at = await read($, lastAt)
  if (at === null) return null
  return at + (await read($, ttlMin)) * 60_000 - (await $.clock.now())
}

async function warm($: EngineInterface, why: 'manual' | 'auto') {
  if (isBusy || (await read($, isWarming))) return
  await update($, isWarming, () => true)
  try {
    const r = await $.model.fork({ prompt: PING })
    const now = await $.clock.now()
    const cached = ('usage' in r ? r.usage?.cache_read_input_tokens : undefined) ?? 0
    const ok = r.isAnswered && cached > 0
    const w: Warm = { at: now, read: cached, isOk: ok }
    await update($, lastWarm, () => w)
    if (ok) await update($, lastAt, () => now)
    if (why === 'auto') await update($, warmsLeft, n => Math.max(0, n - 1))
    $.ui.toast(
      ok
        ? `Cache kept warm: ${k(cached)} tokens served from cache (${why}).`
        : r.isAnswered
          ? 'Ping answered but nothing came from cache: it had already gone cold.'
          : `Keep-warm ping failed: ${r.reason}.`,
    )
  } finally {
    await update($, isWarming, () => false)
  }
}

async function statusLine($: EngineInterface) {
  const left = await remainingMs($)
  if (left === null) return $.ui.status(undefined)
  $.ui.status(left > 0 ? `cache warm · ${mmss(left)}` : 'cache cold')
}

// ---------- drawing ----------

// A rounded progress bar: an SVG on desktop, dots elsewhere.
function svgBar(width: number, frac: number, colors: string[], knob: boolean): string {
  const f = Math.max(0, Math.min(1, frac))
  const h = 10
  const r = h / 2
  const fillW = Math.max(f > 0 ? h : 0, f * width)
  const stops = colors
    .map((c, i) => `<stop offset="${colors.length === 1 ? 0 : i / (colors.length - 1)}" stop-color="${c}"/>`)
    .join('')
  const k = knob && f > 0
    ? `<circle cx="${Math.min(width - r, Math.max(r, fillW - r))}" cy="${r + 2}" r="${r + 1}" fill="#ffffff"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h + 4}" viewBox="0 0 ${width} ${h + 4}">
<defs><linearGradient id="g" x1="0" x2="${width}" y1="0" y2="0" gradientUnits="userSpaceOnUse">${stops}</linearGradient></defs>
<rect x="0" y="2" width="${width}" height="${h}" rx="${r}" fill="${TRACK}"/>
${fillW > 0 ? `<rect x="0" y="2" width="${fillW}" height="${h}" rx="${r}" fill="url(#g)"/>` : ''}${k}</svg>`
}

const dots = (frac: number, n = 10) => {
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * n)
  return ['●'.repeat(filled), '·'.repeat(n - filled)] as const
}

// How long you can be away before keeping the cache warm stops paying off.
// Away for time T, you either let it cool (pay one rewrite of the context, W)
// or ping just before each expiry (each ping re-reads the context, R) and come
// back warm (R). Warming wins while pings * R + R < W, so the break-even is
// W / R - 1 pings, whatever the context size. Pings land ~a minute early.
function breakEvenMs(ttlMinutes: number): number {
  const pings = writeMult(ttlMinutes) / READ - 1
  const every = Math.max(1, ttlMinutes - 1.5) * 60_000
  return pings * every
}

const span = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 90) return `${m} min`
  const h = ms / 3_600_000
  return `${h >= 10 ? Math.round(h) : h.toFixed(1)} h`
}

const toneOf = (leftPct: number) => (leftPct > 50 ? GOOD : leftPct > 20 ? MID : LOW)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache',
      description: 'Show or hide the cache & usage bar; /cache warm pings once',
      argumentHint: 'show | hide | warm | auto on|off',
    })
    $.clock.every(15_000, async () => {
      await update($, tick, n => n + 1)
      await statusLine($)
      const left = await remainingMs($)
      const shouldWarm =
        left !== null && left > 0 && left < 90_000 &&
        (await read($, autoWarm)) && (await read($, warmsLeft)) > 0
      if (shouldWarm) await warm($, 'auto')
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isBusy = true
      fiveHourBefore = await fiveHourUsed($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isBusy = false
    const now = await $.clock.now()
    if (e.usage) {
      const u: CacheUsage = {
        read: e.usage.cache_read_input_tokens,
        write: e.usage.cache_creation_input_tokens,
        fresh: e.usage.input_tokens,
        output: e.usage.output_tokens,
      }
      await update($, usage, () => u)
      await update($, lastAt, () => now)

      // What this turn took from the 5-hour window, and the running price per token.
      const after = await fiveHourUsed($)
      if (fiveHourBefore !== null && after !== null && after >= fiveHourBefore) {
        const delta = after - fiveHourBefore
        const weight = u.read * READ + u.write * writeMult(await read($, ttlMin)) + u.fresh + u.output * OUTPUT
        await update($, lastTurnPct, () => delta)
        if (weight > 0) await update($, rate, (r): Rate => ({ pct: r.pct + delta, weight: r.weight + weight }))
      }
    }
    fiveHourBefore = null
    const ttlNow = await read($, ttlMin)
    await update($, warmsLeft, () => maxAuto(ttlNow))
    await statusLine($)
    return next(e)
  })

  // After each turn, learn the real cache lifetime from the transcript, so the
  // timer follows Claude Code (1 hour normally, 5 minutes in usage overage).
  on('classic.Stop', async ($, e, next) => {
    const text = await $.fs.read(e.transcript_path).catch(() => undefined)
    const ttl = text === undefined ? undefined : detectTtl(text)
    if (ttl !== undefined && ttl !== (await read($, ttlMin))) {
      await update($, ttlMin, () => ttl)
      $.ui.toast(`Prompt cache lifetime is now ${ttl === 60 ? '1 hour' : '5 minutes'}.`)
    }
    return next(e)
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const [verb, arg] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'hide') {
      await update($, isHidden, () => true)
      return { text: 'Cache bar hidden. /cache show brings it back.' }
    }
    if (verb === 'warm') {
      void warm($, 'manual')
      return { text: 'Sending one keep-warm ping.' }
    }
    if (verb === 'auto') {
      const isOn = arg === 'on'
      await update($, autoWarm, () => isOn)
      return { text: `Auto-warm ${isOn ? `on (up to ${maxAuto(await read($, ttlMin))} pings, the break-even point)` : 'off'}.` }
    }
    await update($, isHidden, () => false)
    return { text: 'Cache bar shown above the prompt.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick) // redraw on every tick
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isDesktop = e.surface === 'desktop'
    const Svg = isDesktop ? $.ui.resolve(e).Svg : undefined
    const now = await $.clock.now()
    const session = await $.session.usage().catch(() => undefined)
    const lims = session?.rateLimits ?? []
    const context = session?.context.tokens ?? 0

    const bar = (key: string, width: number, frac: number, colors: string[], knob = false, alt = '') =>
      Svg ? (
        <Svg source={svgBar(width, frac, colors, knob)} alt={alt} width={width} height={14} />
      ) : (
        <Text>
          <Text color={colors[colors.length - 1]}>{dots(frac)[0]}</Text>
          <Text dimColor>{dots(frac)[1]}</Text>
        </Text>
      )

    // ---- usage limits ----
    const order = ['seven_day', 'five_hour']
    const shown = [...lims].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    const usageRow = (
      <Box flexDirection="row" gap={4} alignItems="center" flexWrap="wrap">
        <Text size="caption" weight="semibold" dimColor>USAGE</Text>
        {shown.length === 0 && <Text dimColor size="caption">limits not reported yet</Text>}
        {shown.map(l => {
          const leftPct = Math.max(0, 100 - l.percentUsed)
          const tone = toneOf(leftPct)
          const label = l.kind === 'five_hour' ? '5H' : l.kind === 'seven_day' ? '7D' : l.kind.toUpperCase()
          return (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text size="caption" weight="semibold" dimColor>{label}</Text>
              {bar(l.kind, 140, leftPct / 100, [tone], false, `${label} ${Math.round(leftPct)}% left`)}
              <Text color={tone} weight="semibold" tabular>{Math.round(leftPct)}% left</Text>
              {l.resetsAt && <Text dimColor size="caption">· {resetIn(l.resetsAt, now)}</Text>}
            </Box>
          )
        })}
      </Box>
    )

    const at = await read($, lastAt)
    if (at === null) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="#3a3a3a" paddingX={1}>
          {usageRow}
        </Box>
      )
    }

    // ---- cache ----
    const ttl = await read($, ttlMin)
    const left = at + ttl * 60_000 - now
    const frac = Math.max(0, Math.min(1, left / (ttl * 60_000)))
    const isWarm = left > 0
    const heat = !isWarm ? COLD : frac > 0.15 ? WARM : COOLING
    const r = await read($, rate)
    const perToken = r.weight > 0 && r.pct > 0 ? r.pct / r.weight : null
    const warmCost = context * READ
    const coldCost = context * writeMult(ttl)
    const times = Math.round(writeMult(ttl) / READ)
    const lastPct = await read($, lastTurnPct)
    const auto = await read($, autoWarm)
    const leftPings = await read($, warmsLeft)
    const warming = await read($, isWarming)
    const lw = await read($, lastWarm)

    const cost = (w: number) => (perToken !== null ? `≈${pct(w * perToken)} of 5H` : `${k(context)} tokens`)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#3a3a3a" paddingX={1} gap={1}>
        <Box flexDirection="row" gap={4} alignItems="center" flexWrap="wrap" justifyContent="space-between" width="100%">
          <Box flexDirection="column" minWidth={300}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text backgroundColor={heat} color="#141414" weight="bold" size="caption">
                {isWarm ? (frac > 0.15 ? ' WARM ' : ' COOLING ') : ' COLD '}
              </Text>
              <Text size="title" weight="bold" tabular color={isWarm ? undefined : COLD}>
                {isWarm ? mmss(left) : '0:00'}
              </Text>
            </Box>
            <Text dimColor size="caption">{isWarm ? `until the cache cools (${ttl === 60 ? '1h' : '5m'} cache)` : 'cache has cooled'}</Text>
            {bar('cache', 300, frac, [COLD, COOLING, WARM], true, `${Math.round(frac * 100)}% of cache life left`)}
          </Box>
          {context > 0 && (
            <Box flexDirection="column">
              <Text dimColor size="caption">{isWarm ? 'Reply now' : 'Next reply'}</Text>
              <Text weight="semibold" size="heading" color={isWarm ? GOOD : LOW}>
                {cost(isWarm ? warmCost : coldCost)}
              </Text>
              <Text dimColor size="caption">
                {isWarm ? `${k(context)} from cache` : `re-processes ${k(context)}`}
              </Text>
            </Box>
          )}
          {context > 0 && isWarm && (
            <Box flexDirection="column">
              <Text dimColor size="caption">After it cools</Text>
              <Text weight="semibold" size="heading">{cost(coldCost)}</Text>
              <Text color={LOW} size="caption" weight="semibold">{times}× more</Text>
            </Box>
          )}
          {isWarm && (
            <Box flexDirection="column">
              <Text dimColor size="caption">Taking a break?</Text>
              <Text weight="semibold" size="heading" color={WARM}>
                Under {span(breakEvenMs(ttl))}: keep warm
              </Text>
              <Text dimColor size="caption">Longer: let it cool ({maxAuto(ttl)} pings max)</Text>
            </Box>
          )}
          {lastPct !== null && (
            <Box flexDirection="column">
              <Text dimColor size="caption">Last turn</Text>
              <Text weight="semibold" size="heading">{pct(lastPct)}</Text>
              <Text dimColor size="caption">of the 5-hour window</Text>
            </Box>
          )}
        </Box>
        {usageRow}
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Button key="warm" label={warming ? 'Warming…' : 'Warm now'} onPress={() => warm($, 'manual')} />
          <Button
            key="auto"
            label={auto ? `Auto-warm on (${leftPings} left)` : 'Auto-warm off'}
            onPress={() => update($, autoWarm, v => !v)}
          />
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
          {lw && <Text dimColor size="caption">last ping: {lw.isOk ? `${k(lw.read)} cached` : 'missed'}</Text>}
          {perToken === null && <Text dimColor size="caption">usage % estimates appear after a turn moves the 5H meter</Text>}
        </Box>
      </Box>
    )
  })
}
