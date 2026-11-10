export type VizStyle = 'mono' | 'wmp'

export type Track = {
  title: string
  artist: string
  album: string
  app: string
  duration: number
  elapsed: number
  isPlaying: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'music-player': {
      track: Shaped<Track | null>
      vizStyle: Shaped<VizStyle>
    }
  }
}
