import type { ClientModule } from 'claude-code'

// The reading's progress bar. Drag or click along it to move; the position
// follows the pointer while dragging and goes to the hooks module on release.

type Props = { position: number; duration: number }
type State = { drag?: number; hooked?: true }

// The handlers are registered once, so they read the latest values from here.
let latest: Props & { bar: number } = { position: 0, duration: 0, bar: 1 }

const Seek: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? {}
  const bar = Math.max(4, surface.columns)
  latest = { ...props, bar }

  const fromX = (x: number) =>
    (Math.min(Math.max(x, 0), latest.bar - 1) / Math.max(1, latest.bar - 1)) * latest.duration

  if (!state.hooked) {
    surface.onPointer(ev => {
      const cur = surface.state ?? {}
      if (ev.type === 'down' || (ev.type === 'move' && cur.drag !== undefined)) {
        surface.setState({ ...cur, drag: fromX(ev.x) })
      } else if (ev.type === 'up' && cur.drag !== undefined) {
        surface.setState({ ...cur, drag: undefined })
        surface.post({ to: fromX(ev.x) })
      }
    })
    surface.setState({ hooked: true })
  }

  const shown = state.drag ?? props.position
  const filled = props.duration > 0 ? Math.round(Math.min(1, shown / props.duration) * bar) : 0

  return (
    <Box flexDirection="row" width="100%" height={1} overflow="hidden">
      <Box width={filled} height={1} overflow="hidden" backgroundColor="claude">
        <Text> </Text>
      </Box>
      <Box width={bar - filled} height={1} overflow="hidden" backgroundColor="subtle">
        <Text> </Text>
      </Box>
    </Box>
  )
}

export default Seek
