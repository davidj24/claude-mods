import type { ClientModule } from 'claude-code'

// A speed slider: a filled bar one row tall with the speed beside it. Drag or
// click along the bar, or use the arrow keys once it has the focus. The value
// shown follows the pointer while dragging; it goes to the hooks module on
// release (or each key press) through `post`.
//
// The slider keeps its own idea of the value. It takes a new value from props
// only when props actually change, so a redraw that still carries the old
// speed (while the save is on its way) never pulls the bar back.

type Props = { value: number; min: number; max: number; step: number }
type State = { drag?: number; shown?: number; seen?: number; hooked?: true }

const LABEL = 6 // "1.25×" plus a space

const clamp = (v: number, p: Props) => Math.min(p.max, Math.max(p.min, v))
const snap = (v: number, p: Props) => Math.round(clamp(Math.round(v / p.step) * p.step, p) * 100) / 100
const fmt = (v: number) => `${v.toFixed(2)}×`

const Slider: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state ?? {}

  // Props moved (a save came back, or the speed changed elsewhere): adopt it,
  // unless the person is mid-drag.
  if (state.hooked && state.drag === undefined && state.seen !== props.value) {
    state = { ...state, shown: props.value, seen: props.value }
    surface.setState(state)
  }

  const bar = Math.max(4, surface.columns - LABEL)
  const fromX = (x: number) => snap(props.min + (Math.min(Math.max(x, 0), bar - 1) / Math.max(1, bar - 1)) * (props.max - props.min), props)

  if (!state.hooked) {
    surface.onPointer(ev => {
      const cur = surface.state ?? {}
      if (ev.type === 'down' || (ev.type === 'move' && cur.drag !== undefined)) {
        const v = fromX(ev.x)
        if (v !== cur.drag) surface.setState({ ...cur, drag: v })
      } else if (ev.type === 'up' && cur.drag !== undefined) {
        const v = fromX(ev.x)
        surface.setState({ ...cur, drag: undefined, shown: v })
        surface.post({ speed: v })
      }
    })
    surface.onKey(ev => {
      const cur = surface.state ?? {}
      const base = cur.drag ?? cur.shown ?? props.value
      const delta = ev.key === 'right' || ev.key === 'up' ? props.step : ev.key === 'left' || ev.key === 'down' ? -props.step : 0
      if (delta === 0) return
      const v = snap(base + delta, props)
      surface.setState({ ...cur, shown: v })
      surface.post({ speed: v })
    })
    state = { hooked: true, shown: props.value, seen: props.value }
    surface.setState(state)
  }

  const value = state.drag ?? state.shown ?? props.value
  const filled = Math.round(((value - props.min) / (props.max - props.min)) * bar)

  return (
    <Box flexDirection="row" width="100%" height={1} overflow="hidden">
      <Box width={filled} height={1} overflow="hidden" backgroundColor="claude">
        <Text> </Text>
      </Box>
      <Box width={bar - filled} height={1} overflow="hidden" backgroundColor="subtle">
        <Text> </Text>
      </Box>
      <Box width={LABEL} height={1} overflow="hidden" justifyContent="flex-end">
        <Text bold={state.drag !== undefined} tabular>
          {fmt(value)}
        </Text>
      </Box>
    </Box>
  )
}

export default Slider
