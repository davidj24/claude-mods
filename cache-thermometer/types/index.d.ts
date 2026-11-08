export type CacheUsage = { read: number; write: number; fresh: number; output: number }
export type Warm = { at: number; read: number; isOk: boolean }
// Running total of "5-hour % used" against weighted tokens, to price a turn.
export type Rate = { pct: number; weight: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-thermometer': {
      lastAt: number | null
      ttlMin: number
      usage: Shaped<CacheUsage | null>
      autoWarm: boolean
      warmsLeft: number
      tick: number
      lastWarm: Warm | null
      isHidden: boolean
      isWarming: boolean
      rate: Rate
      lastTurnPct: number | null
    }
  }
}
