import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { VoiceConfig } from '../types'

const PANE = 'voices'
const TITLE = 'Voices'
const SAMPLE = "Hi, I'm NAME. This is how I'd sound reading your replies."

const config = atom({ plugin: 'voice-picker', key: 'config' } as const, null, { shape: 'config-1' })
const group = atom({ plugin: 'voice-picker', key: 'group' } as const, 'bf', { shape: 'group-1' })
const note = atom({ plugin: 'voice-picker', key: 'note' } as const, '', { shape: 'note-1' })
const isOpen = atom({ plugin: 'voice-picker', key: 'isOpen' } as const, false, { shape: 'open-1' })

// Kokoro's fixed roster, grouped by the prefix of the id (language + gender).
const GROUPS: { value: string; label: string; ids: string[] }[] = [
  { value: 'af', label: 'American female', ids: ['af_heart', 'af_bella', 'af_nova', 'af_sarah', 'af_sky', 'af_alloy', 'af_aoede', 'af_jessica', 'af_kore', 'af_nicole', 'af_river'] },
  { value: 'am', label: 'American male', ids: ['am_michael', 'am_puck', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_onyx', 'am_santa'] },
  { value: 'bf', label: 'British female', ids: ['bf_emma', 'bf_alice', 'bf_isabella', 'bf_lily'] },
  { value: 'bm', label: 'British male', ids: ['bm_george', 'bm_daniel', 'bm_fable', 'bm_lewis'] },
  { value: 'other', label: 'Other languages', ids: ['ef_dora', 'em_alex', 'em_santa', 'ff_siwis', 'if_sara', 'im_nicola', 'pf_dora', 'pm_alex', 'pm_santa', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo', 'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang'] },
]
const LANG: Record<string, string> = { e: 'Spanish', f: 'French', i: 'Italian', p: 'Portuguese', h: 'Hindi', j: 'Japanese', z: 'Mandarin' }

const name = (id: string) => {
  const n = id.split('_')[1] ?? id
  return n.charAt(0).toUpperCase() + n.slice(1)
}
const label = (id: string) => {
  const lang = LANG[id.charAt(0)]
  return lang ? `${name(id)} (${lang})` : name(id)
}

// read-aloud lives in a versioned cache folder; take the newest copy.
const FIND =
  'p=$(ls -d "$HOME"/.claude/plugins/cache/*/read-aloud/*/scripts/speak.py 2>/dev/null | sort -V | tail -1); ' +
  '[ -n "$p" ] || { echo "read-aloud is not installed" >&2; exit 3; }; exec python3 "$p" "$@"'

async function speak($: Engine, args: string[]) {
  return $.process.run(['sh', '-c', FIND, 'speak', ...args], { timeoutMs: 20000 })
}

async function refresh($: Engine) {
  const r = await speak($, ['--get-config'])
  if (r.exitCode !== 0) {
    await update($, note, () => (r.stderr.trim() || 'Could not read the read-aloud settings.'))
    return
  }
  try {
    const c = JSON.parse(r.stdout)
    const next: VoiceConfig = {
      provider: String(c.provider),
      voice: String(c.voice ?? ''),
      speed: Number(c.speed ?? 1),
      autoRead: Boolean(c.auto_read),
    }
    await update($, config, () => next)
  } catch {
    await update($, note, () => 'Could not read the read-aloud settings.')
  }
}

async function act($: Engine, args: string[], message: string) {
  const r = await speak($, args)
  await update($, note, () => (r.exitCode === 0 ? message : r.stderr.trim() || 'That did not work.'))
  await refresh($)
}

const MIN_SPEED = 0.5
const MAX_SPEED = 2

async function setSpeed($: Engine, raw: number) {
  if (!Number.isFinite(raw)) {
    await update($, note, () => `Type a speed between ${MIN_SPEED} and ${MAX_SPEED}, like 1.25.`)
    return
  }
  const v = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, raw)) * 100) / 100
  // Show the new speed at once; the saved value confirms it a moment later.
  await update($, config, c => (c ? { ...c, speed: v } : c))
  await act($, ['--set-speed', String(v)], `Speed set to ${v}×.`)
}

async function openPane($: Engine, focus = false) {
  await update($, isOpen, () => true)
  await $.ui.open(focus ? { id: PANE, title: TITLE, focus: true } : { id: PANE, title: TITLE })
}

async function hidePane($: Engine) {
  await update($, isOpen, () => false)
  await $.ui.close({ id: PANE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'voices', description: 'Open the Voices pane: hear, pick and set the read-aloud voice' })
    void refresh($)
    // Always there: the pane opens with every session. Hide (or the pane's
    // own close) folds it into a small Voices button above the prompt.
    void openPane($)
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'speed') return next(e)
    const data = e.data as { speed?: unknown } | null
    if (data && typeof data.speed === 'number') await setSpeed($, data.speed)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)
    return next(e)
  })

  // A small Voices button at the left of the band above the prompt, in every
  // session and whether or not the pane is showing: the app can hide its
  // sidebar without telling the mod, so the button never depends on that.
  // Other mods' bands sit beside it, so it never pushes them out of view.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1} alignItems="flex-start">
        <Box flexShrink={0}>
          <Button key="show-voices" label="🔊 Voices" dimColor onPress={() => void openPane($, true)} />
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {below}
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'voices' }, async $ => {
    await refresh($)
    await openPane($)
    return { text: 'Voices pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Select = 'Select' in ui ? ui.Select : undefined
    const Input = 'Input' in ui ? ui.Input : undefined
    const Client = 'Client' in ui ? ui.Client : undefined
    const c = await read($, config)
    const g = await read($, group)
    const msg = await read($, note)
    const shown = GROUPS.find(x => x.value === g) ?? GROUPS[2]!

    if (!c) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{msg || 'Loading read-aloud settings…'}</Text>
          <Button key="retry" label="Try again" onPress={() => void refresh($)} />
        </Box>
      )
    }

    const isKokoro = c.provider === 'kokoro'
    const speed = Math.round(c.speed * 100) / 100

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="semibold">Voice: {c.voice ? label(c.voice) : 'default'}</Text>
          <Text dimColor>
            Speed {speed}× · Auto-read {c.autoRead ? 'on' : 'off'}
          </Text>
        </Box>

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            key="auto"
            variant={c.autoRead ? 'secondary' : 'primary'}
            label={c.autoRead ? 'Turn auto-read off' : 'Turn auto-read on'}
            onPress={() =>
              void act($, ['--auto', c.autoRead ? 'off' : 'on'], c.autoRead ? 'Auto-read is off.' : 'Every reply will now be read aloud.')
            }
          />
          <Button key="stop" label="Stop" onPress={() => void act($, ['--stop'], 'Stopped.')} />
          <Button key="hide" label="Hide" dimColor onPress={() => void hidePane($)} />
        </Box>

        <Box flexDirection="column">
          <Text weight="medium">{Client ? 'Speed' : `Speed ${speed}×`}</Text>
          {Client ? (
            <Client
              key="speed"
              module="./slider.tsx"
              width="100%"
              height={1}
              props={{ value: c.speed, min: MIN_SPEED, max: MAX_SPEED, step: 0.05 }}
            />
          ) : (
            <Box flexDirection="row" gap={1}>
              <Button key="slower" label="Slower" onPress={() => void setSpeed($, c.speed - 0.1)} />
              <Button key="faster" label="Faster" onPress={() => void setSpeed($, c.speed + 0.1)} />
            </Box>
          )}
          {Input && (
            <Input
              key="speed-typed"
              label="Type a speed"
              placeholder={`${MIN_SPEED}–${MAX_SPEED}, e.g. 1.25`}
              value={String(speed)}
              submitLabel="Set"
              onSubmit={(v: string) => void setSpeed($, Number.parseFloat(v.replace('×', '').replace('x', '')))}
            />
          )}
        </Box>

        {!isKokoro && (
          <Text dimColor>
            These are the Kokoro voices; the current engine is {c.provider}. Run /read-aloud:voice-setup to use them.
          </Text>
        )}

        {Select && <Select
          key="group"
          label="Show"
          value={shown.value}
          options={GROUPS.map(x => ({ value: x.value, label: x.label }))}
          onSelect={(v: string) => void update($, group, () => v)}
        />}

        <Box flexDirection="column">
          {shown.ids.map(id => {
            const inUse = id === c.voice
            return (
              <Box key={`row-${id}`} flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
                <Text weight={inUse ? 'semibold' : 'regular'}>
                  {label(id)}
                  {inUse ? '  ✓' : ''}
                </Text>
                <Box flexDirection="row" gap={1}>
                  <Button
                    key={`play-${id}`}
                    label="▶ Play"
                    onPress={() =>
                      void act($, ['--detach', '--voice', id, '--text', SAMPLE.replace('NAME', name(id))], `Playing ${label(id)}…`)
                    }
                  />
                  <Button
                    key={`use-${id}`}
                    label={inUse ? 'In use' : 'Use'}
                    dimColor={inUse}
                    onPress={() => {
                      if (inUse) return
                      void (async () => {
                        await act($, ['--set-voice', id], `${label(id)} is now your reading voice.`)
                        await speak($, ['--detach', '--text', `Voice saved. This is ${name(id)} from now on.`])
                      })()
                    }}
                  />
                </Box>
              </Box>
            )
          })}
        </Box>

        {msg !== '' && <Text dimColor>{msg}</Text>}
      </Box>
    )
  })
}
