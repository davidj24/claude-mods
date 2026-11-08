export type VoiceConfig = {
  provider: string
  voice: string
  speed: number
  autoRead: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'voice-picker': {
      config: Shaped<VoiceConfig | null>
      group: Shaped<string>
      note: Shaped<string>
      isOpen: Shaped<boolean>
    }
  }
}
