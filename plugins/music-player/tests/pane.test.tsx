import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'music-player',
  component: 'Pane',
  requestId: 'music-player',
  props: {
    title: 'Lecteur',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TRACK = {
  title: 'Pyramid Song',
  artist: 'Radiohead',
  album: '',
  app: 'Chrome',
  duration: 288,
  elapsed: 91,
  isPlaying: true,
}

for (const stored of [null, TRACK]) {
  test(`le panneau se dessine sur chaque surface (${stored ? 'en lecture' : 'vide'})`, async ($, on) => {
    on('state.get', (_, e, next) =>
      (e as { key?: string }).key === 'track' ? { value: { value: stored && { shape: 'track-1', value: stored }, version: 1 } } : next(e),
    )
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const status = await ui.find({ type: 'Text', text: stored ? /Lecture/ : /Rien en lecture/ })
      expect(status).toBeTruthy()
      await ui.unmount()
    }
  })
}
