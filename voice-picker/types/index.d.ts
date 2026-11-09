export type VoiceConfig = {
  provider: string
  voice: string
  speed: number
  autoRead: boolean
}

export type Player = {
  state: string
  isBuffering: boolean
  position: number
  duration: number
  isEstimate: boolean
  index: number
  count: number
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'voice-picker': {
      config: Shaped<VoiceConfig | null>
      group: Shaped<string>
      note: Shaped<string>
      isOpen: Shaped<boolean>
      player: Shaped<Player | null>
    }
  }
}
