import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Track, VizStyle } from '../types'

const PANE = 'music-player'
const VIZ_KEY = 'viz'
const BELOW_VIZ = 8

const track = atom({ plugin: 'music-player', key: 'track' } as const, null, {
  shape: 'track-1',
})

// Rendu du visualiseur : 'wmp' (dégradé vert) ou 'mono' (couleur du thème)
const vizStyleAtom = atom({ plugin: 'music-player', key: 'vizStyle' } as const, 'wmp', {
  shape: 'style-1',
})
// Copie locale, lue par la boucle d'animation du terminal (hors rendu)
let vizStyle: VizStyle = 'wmp'

// ---------------------------------------------------------------------------
// Lecture de l'état "Now Playing" du Mac
// ---------------------------------------------------------------------------

// osascript est signé Apple (com.apple.osascript) : il a le droit, depuis
// macOS 15.4, d'interroger le framework privé MediaRemote, qui sait ce que
// joue n'importe quelle app (Qobuz, Chrome, Music, Spotify…). Rien à installer.
const JXA_PRELUDE =
  "ObjC.import('Foundation');" +
  "$.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework').load;"

const GET_SCRIPT =
  JXA_PRELUDE +
  `
function run() {
  var R = $.NSClassFromString('MRNowPlayingRequest')
  if (R.isNil()) return 'null'
  var item = R.localNowPlayingItem
  if (item.isNil()) return 'null'
  var info = ObjC.deepUnwrap(item.nowPlayingInfo) || {}
  var k = 'kMRMediaRemoteNowPlayingInfo'
  if (!info[k + 'Title']) return 'null'
  var bundle = ''
  try {
    var path = R.localNowPlayingPlayerPath
    if (!path.isNil()) bundle = ObjC.unwrap(path.client.bundleIdentifier) || ''
  } catch (e) {}
  var playing = !!R.localIsPlaying
  var rate = info[k + 'PlaybackRate'] || 0
  var elapsed = info[k + 'ElapsedTime'] || 0
  var ts = info[k + 'Timestamp']
  var tms = ts instanceof Date ? ts.getTime() : Date.parse(ts)
  if (playing && rate > 0 && isFinite(tms)) elapsed += ((Date.now() - tms) / 1000) * rate
  return JSON.stringify({
    title: String(info[k + 'Title'] || ''),
    artist: String(info[k + 'Artist'] || ''),
    album: String(info[k + 'Album'] || ''),
    duration: Number(info[k + 'Duration'] || 0),
    elapsed: elapsed,
    playing: playing,
    bundle: String(bundle),
  })
}`

// Qobuz ne publie rien dans le "Now Playing" de macOS. On lit donc ses
// propres fichiers : son journal (lecture / pause / morceau, en temps réel),
// player-0.json (position) et sa base locale (titre, artiste, album, durée).
const QOBUZ_SCRIPT = `
D="$HOME/Library/Application Support/Qobuz"
/usr/bin/pgrep -xq Qobuz || exit 0
L=$(/bin/ls -t "$D"/logs/rapport_qobuz*.txt 2>/dev/null | /usr/bin/head -1)
[ -n "$L" ] || exit 0
EV=$(/usr/bin/tail -c 80000 "$L" | /usr/bin/grep -E 'Status has changed to|(Play|Pause) track [0-9]+')
ST=$(printf '%s\\n' "$EV" | /usr/bin/grep 'Status has changed to' | /usr/bin/tail -1)
TR=$(printf '%s\\n' "$EV" | /usr/bin/grep -E '(Play|Pause) track' | /usr/bin/tail -1)
ID=$(printf '%s' "$TR" | /usr/bin/sed -E 's/.*track ([0-9]+).*/\\1/')
case "$ID" in ''|*[!0-9]*) exit 0;; esac
printf 'STATUS\\t%s\\n' "$ST"
printf 'TRACK\\t%s\\n' "$TR"
printf 'POS\\t%s\\n' "$(/usr/bin/grep -oE '"position":\\{"value":[0-9.]+,"timestamp":[0-9]+\\}' "$D/player-0.json" | /usr/bin/head -1)"
/usr/bin/sqlite3 -readonly -separator '	' "$D/qobuz.db" "select 'META', json_extract(data,'$.title'), json_extract(data,'$.performer.name'), json_extract(data,'$.album.title'), duration from L_Track where track_id='$ID' limit 1"
`

// Commandes MediaRemote : 2 = lecture/pause, 4 = suivant, 5 = précédent
const COMMANDS = { toggle: 2, next: 4, prev: 5 } as const
const commandScript = (code: number) =>
  JXA_PRELUDE +
  "ObjC.bindFunction('MRMediaRemoteSendCommand', ['bool', ['int', 'id']]);" +
  `var ok = $.MRMediaRemoteSendCommand(${code}, $());` +
  // L'envoi est asynchrone : on garde le process en vie le temps qu'il parte
  '$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.4));' +
  'String(ok)'

// Qobuz ignore MediaRemote mais écoute les touches média du clavier : on les
// simule (16 = lecture/pause, 19 = suivant, 20 = précédent, comme F8/F9/F7).
// macOS exige l'autorisation Accessibilité pour le terminal.
const MEDIA_KEYS = { toggle: 16, next: 19, prev: 20 } as const
const mediaKeyScript = (code: number) =>
  "ObjC.import('AppKit');" +
  "ObjC.bindFunction('CGEventPost', ['void', ['int', 'void *']]);" +
  '[true, false].forEach(function (down) {' +
  `  var data1 = (${code} << 16) | ((down ? 0xa : 0xb) << 8);` +
  '  var ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(' +
  '    14, $.NSMakePoint(0, 0), down ? 0xa00 : 0xb00, 0, 0, $(), 8, data1, -1);' +
  '  $.CGEventPost(0, ev.CGEvent);' +
  '});' +
  "'sent'"

const appName = (bundle: string) => {
  const known: Record<string, string> = {
    'com.apple.Music': 'Music',
    'com.spotify.client': 'Spotify',
    'com.google.Chrome': 'Chrome',
    'com.apple.Safari': 'Safari',
    'org.mozilla.firefox': 'Firefox',
    'company.thebrowser.Browser': 'Arc',
    'com.deezer.deezer-desktop': 'Deezer',
    'org.videolan.vlc': 'VLC',
    'com.apple.podcasts': 'Podcasts',
  }
  if (/qobuz/i.test(bundle)) return 'Qobuz'
  return known[bundle] ?? (bundle.split('.').pop() || bundle || '?')
}

const fmt = (s: number) => {
  const t = Math.max(0, Math.floor(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Visualiseur "Bars" façon Windows Media Player
// ---------------------------------------------------------------------------

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
// Monochrome : la couleur de texte et le fond par défaut du terminal,
// pour suivre le thème clair ou sombre
const DEFAULT = 0x01000000

// Dégradé vert façon Windows Media Player, du bas vers le haut
const WMP_STOPS = [
  [0x0a, 0x5c, 0x1a],
  [0x1f, 0xa8, 0x32],
  [0x6d, 0xe0, 0x2a],
  [0xc8, 0xff, 0x4a],
] as const
const WMP_CAP = 0xe4ffc2
const wmpColor = (f: number) => {
  const x = Math.min(1, Math.max(0, f)) * (WMP_STOPS.length - 1)
  const i = Math.min(WMP_STOPS.length - 2, Math.floor(x))
  const a = WMP_STOPS[i]!
  const b = WMP_STOPS[i + 1]!
  const k = x - i
  const mix = (j: number) => Math.round(a[j]! + (b[j]! - a[j]!) * k)
  return (mix(0) << 16) | (mix(1) << 8) | mix(2)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const toBase64 = (bytes: Uint8Array) => {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63) + B64.charAt(n & 63)
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + '=='
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63) + '='
  }
  return out
}

type Viz = {
  cols: number
  rows: number
  values: number[]
  peaks: number[]
  holds: number[]
  noise: number[]
}

const makeViz = (cols: number, rows: number): Viz => {
  const n = Math.max(1, Math.floor((cols + 1) / 2))
  return {
    cols,
    rows,
    values: new Array(n).fill(0),
    peaks: new Array(n).fill(0),
    holds: new Array(n).fill(0),
    noise: new Array(n).fill(0.5),
  }
}

const stepViz = (v: Viz, t: number, isPlaying: boolean) => {
  const n = v.values.length
  // Un "kick" vers 124 bpm, plus un contretemps plus léger
  const beat = (t * 124) / 60
  const kick = Math.exp(-(beat % 1) * 7)
  const snare = Math.exp(-((beat + 0.5) % 1) * 9) * 0.5
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1)
    v.noise[i] = Math.min(1, Math.max(0, v.noise[i]! + (Math.random() - 0.5) * 0.35))
    let target = 0
    if (isPlaying) {
      const shape = 0.62 * Math.pow(1 - f, 0.7) + 0.12
      target =
        shape * (0.35 + 0.65 * v.noise[i]!) +
        kick * Math.pow(1 - f, 2.2) * 0.42 +
        snare * Math.exp(-Math.pow((f - 0.55) / 0.2, 2)) * 0.35 +
        0.06 * Math.sin(t * 5.3 + i * 0.9)
      target = Math.min(1, Math.max(0, target))
    }
    const cur = v.values[i]!
    v.values[i] = target > cur ? cur + (target - cur) * 0.7 : Math.max(0, cur - 0.045)
    if (v.values[i]! >= v.peaks[i]!) {
      v.peaks[i] = v.values[i]!
      v.holds[i] = 10
    } else if (v.holds[i]! > 0) {
      v.holds[i] = v.holds[i]! - 1
    } else {
      v.peaks[i] = Math.max(0, v.peaks[i]! - 0.012)
    }
  }
}

const isSilent = (v: Viz) =>
  v.values.every(x => x <= 0.001) && v.peaks.every(x => x <= 0.001)

const renderViz = (v: Viz, style: VizStyle = vizStyle) => {
  const { cols, rows } = v
  const isWmp = style === 'wmp'
  const words = new Uint32Array(cols * rows * 3)
  const n = v.values.length
  const used = n * 2 - 1
  const offset = Math.max(0, Math.floor((cols - used) / 2))
  for (let r = 0; r < rows; r++) {
    const fromBottom = rows - 1 - r
    for (let c = 0; c < cols; c++) {
      const idx = (r * cols + c) * 3
      let ch = 0x20
      let fg = isWmp ? wmpColor(rows > 1 ? fromBottom / (rows - 1) : 0) : DEFAULT
      const x = c - offset
      if (x >= 0 && x < used && x % 2 === 0) {
        const b = x / 2
        const eighths = Math.round(v.values[b]! * rows * 8)
        const fill = Math.min(8, Math.max(0, eighths - fromBottom * 8))
        if (fill > 0) {
          ch = BLOCKS[fill]?.codePointAt(0) ?? 0x20
        } else {
          const peakRow = Math.min(rows - 1, Math.floor((v.peaks[b]! * rows * 8) / 8))
          if (v.peaks[b]! > 0.03 && peakRow === fromBottom) {
            ch = 0x2581 // ▁ : le petit chapeau de crête
            if (isWmp) fg = WMP_CAP
          }
        }
      }
      words[idx] = ch
      words[idx + 1] = fg
      words[idx + 2] = DEFAULT
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

// ---------------------------------------------------------------------------
// Visualiseur "Bars" pour le desktop (pas de Raster) : un SVG animé en SMIL,
// joué par le cadre isolé de la surface, sans aucun aller-retour du mod.
// La source ne dépend que de l'état lecture/pause : identique d'un rendu à
// l'autre, elle ne relance pas l'animation à chaque poll.
// ---------------------------------------------------------------------------

const SVG_W = 640
const SVG_H = 160
const SVG_BARS = 32
const SVG_FRAMES = 16

// Générateur pseudo-aléatoire à graine fixe : la même animation à chaque rendu
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}

const buildSvg = (playing: boolean, style: VizStyle) => {
  const rand = seeded(0x5eed)
  const slot = SVG_W / SVG_BARS
  const barW = slot * 0.62
  const capH = 3
  const baseY = SVG_H - 1
  const maxH = SVG_H - capH - 4
  let bars = ''
  for (let i = 0; i < SVG_BARS; i++) {
    const f = i / (SVG_BARS - 1)
    const x = (i * slot + (slot - barW) / 2).toFixed(1)
    const dur = (1.8 + rand() * 1.2).toFixed(2)
    if (!playing) {
      bars += `<rect class="b" x="${x}" y="${baseY - 2}" width="${barW.toFixed(1)}" height="2"/>`
      continue
    }
    // Comme le terminal : graves plus hautes, bruit, et un kick sur les basses
    const shape = 0.62 * Math.pow(1 - f, 0.7) + 0.12
    const vals: number[] = []
    for (let k = 0; k < SVG_FRAMES; k++) {
      const kick = k % 4 === 0 ? Math.pow(1 - f, 2.2) * 0.42 : 0
      vals.push(Math.min(1, Math.max(0.03, shape * (0.35 + 0.65 * rand()) + kick)))
    }
    vals.push(vals[0]!) // boucle sans saut
    // Chapeaux de crête : retombent lentement derrière la barre
    let cap = Math.max(...vals)
    for (let k = 0; k < 3; k++) {
      for (const v of vals) cap = Math.max(v, cap - 0.06)
    }
    const caps: number[] = []
    for (const v of vals) {
      cap = Math.max(v, cap - 0.06)
      caps.push(cap)
    }
    const hs = vals.map(v => (v * maxH).toFixed(1))
    const ys = vals.map(v => (baseY - v * maxH).toFixed(1))
    const cs = caps.map(c => (baseY - c * maxH - capH - 1).toFixed(1))
    const anim = (attr: string, values: string[]) =>
      `<animate attributeName="${attr}" dur="${dur}s" repeatCount="indefinite" values="${values.join(';')}"/>`
    bars +=
      `<rect class="b" x="${x}" y="${ys[0]}" width="${barW.toFixed(1)}" height="${hs[0]}">` +
      anim('y', ys) +
      anim('height', hs) +
      `</rect>` +
      `<rect class="c" x="${x}" y="${cs[0]}" width="${barW.toFixed(1)}" height="${capH}">` +
      anim('y', cs) +
      `</rect>`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}">` +
    (style === 'wmp'
      ? // Le dégradé est fixé au cadre, pas à chaque barre : une barre haute
        // révèle le vert clair du sommet, comme sur le vrai visualiseur
        `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="${SVG_H}" x2="0" y2="0">` +
        WMP_STOPS.map(
          (c, i) =>
            `<stop offset="${(i / (WMP_STOPS.length - 1)).toFixed(2)}" stop-color="rgb(${c.join(',')})"/>`,
        ).join('') +
        `</linearGradient></defs>` +
        `<style>.b{fill:url(#g)}.c{fill:#${WMP_CAP.toString(16)}}</style>`
      : `<style>.b,.c{fill:#8a8a8a}.c{opacity:.75}` +
        `@media (prefers-color-scheme: dark){.b,.c{fill:#e6e6e6}}` +
        `@media (prefers-color-scheme: light){.b,.c{fill:#2b2b2b}}</style>`) +
    bars +
    `</svg>`
  )
}

// Traits de la barre de progression (desktop) : très larges, étirés sans
// garder les proportions (preserveAspectRatio="none") à la boîte qui les tient
const LINE_H = 10
const line = (thickness: number, style: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${LINE_H}" viewBox="0 0 100 ${LINE_H}" preserveAspectRatio="none">` +
  `<style>${style}</style>` +
  `<rect class="l" x="0" y="${(LINE_H - thickness) / 2}" width="100" height="${thickness}"/></svg>`
const LINE_PLAYED = line(
  2.5,
  `.l{fill:#555}@media (prefers-color-scheme: dark){.l{fill:#e6e6e6}}@media (prefers-color-scheme: light){.l{fill:#1f1f1f}}`,
)
const LINE_WMP = line(3, `.l{fill:rgb(${WMP_STOPS[2]!.join(',')})}`)
const LINE_REST = line(1, `.l{fill:#9a9a9a}`)

const SVGS: Record<VizStyle, { playing: string; paused: string }> = {
  wmp: { playing: buildSvg(true, 'wmp'), paused: buildSvg(false, 'wmp') },
  mono: { playing: buildSvg(true, 'mono'), paused: buildSvg(false, 'mono') },
}

// ---------------------------------------------------------------------------
// Le mod
// ---------------------------------------------------------------------------

type $T = EngineInterface

type Site = { viz: Viz; cells: string; isSilentBlitted: boolean }
// Un visualiseur par emplacement dessiné, par requestId (panneau, bandeau)
const sites = new Map<string, Site>()

const siteFor = (requestId: string, cols: number, rows: number): Site => {
  const old = sites.get(requestId)
  if (old && old.viz.cols === cols && old.viz.rows === rows) return old
  const viz = makeViz(cols, rows)
  if (old && old.viz.values.length === viz.values.length) {
    viz.values = old.viz.values
    viz.peaks = old.viz.peaks
  }
  const site = { viz, cells: renderViz(viz), isSilentBlitted: false }
  sites.set(requestId, site)
  return site
}

let isPlaying = false
let isPolling = false

async function nowPlaying($: $T): Promise<Track | null> {
  const r = await $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', GET_SCRIPT], {
    timeoutMs: 5000,
  })
  const out = r.stdout.trim()
  if (r.exitCode !== 0 || !out || out === 'null') return null
  const j = JSON.parse(out) as {
    title: string
    artist: string
    album: string
    duration: number
    elapsed: number
    playing: boolean
    bundle: string
  }
  const duration = j.duration > 0 ? j.duration : 0
  return {
    title: j.title,
    artist: j.artist,
    album: j.album,
    app: appName(j.bundle),
    duration,
    elapsed: duration > 0 ? Math.min(Math.max(0, j.elapsed), duration) : Math.max(0, j.elapsed),
    isPlaying: j.playing,
  }
}

async function qobuz($: $T): Promise<Track | null> {
  const r = await $.process.run(['/bin/sh', '-c', QOBUZ_SCRIPT], { timeoutMs: 5000 })
  if (r.exitCode !== 0 || !r.stdout.trim()) return null
  const lines = new Map<string, string[]>()
  for (const line of r.stdout.split('\n')) {
    const [key, ...rest] = line.split('\t')
    if (key) lines.set(key, rest)
  }
  const meta = lines.get('META')
  if (!meta) return null
  const [title = '', artist = '', album = '', durationText = '0'] = meta
  const duration = Math.max(0, parseFloat(durationText) || 0)
  const statusLine = lines.get('STATUS')?.[0] ?? ''
  const trackLine = lines.get('TRACK')?.[0] ?? ''
  const isPlaying = /Status has changed to Playing/.test(statusLine)
  // Les lignes du journal commencent par un horodatage ISO (UTC)
  const playedAt = /Play track/.test(trackLine) ? Date.parse(trackLine.slice(0, 24)) : NaN
  let elapsed = 0
  const pos = /"value":([0-9.]+),"timestamp":([0-9]+)/.exec(lines.get('POS')?.[0] ?? '')
  if (pos) {
    elapsed = parseFloat(pos[1] ?? '0') / 1000
    const since = Math.max(Number(pos[2]), Number.isFinite(playedAt) ? playedAt : 0)
    if (isPlaying) elapsed += Math.max(0, (await $.clock.now()) - since) / 1000
  }
  return {
    title,
    artist,
    album,
    app: 'Qobuz',
    duration,
    elapsed: duration > 0 ? Math.min(elapsed, duration) : elapsed,
    isPlaying,
  }
}

async function poll($: $T) {
  if (isPolling) return
  isPolling = true
  try {
    const [system, fromQobuz] = await Promise.all([
      nowPlaying($).catch(() => null),
      qobuz($).catch(() => null),
    ])
    // Celui qui joue gagne ; sinon le dernier connu de macOS, puis Qobuz
    const next =
      [system, fromQobuz].find(t => t?.isPlaying) ?? system ?? fromQobuz ?? null
    isPlaying = next?.isPlaying ?? false
    await update($, track, () => next)
  } finally {
    isPolling = false
  }
}

async function control($: $T, action: keyof typeof COMMANDS) {
  const current = await read($, track)
  const script =
    current?.app === 'Qobuz'
      ? mediaKeyScript(MEDIA_KEYS[action])
      : commandScript(COMMANDS[action])
  await $.process
    .run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script], { timeoutMs: 5000 })
    .catch(() => null)
  if (action === 'toggle' && current) {
    // Réaction immédiate à l'écran, le prochain poll confirmera
    isPlaying = !current.isPlaying
    await update($, track, t => (t ? { ...t, isPlaying: !t.isPlaying } : t))
  }
  await $.clock.sleep(300)
  await poll($)
}

const progressLine = (t: Track | null, width: number) => {
  const ratio = t && t.duration > 0 ? Math.min(1, t.elapsed / t.duration) : 0
  const times = t ? ` ${fmt(t.elapsed)} / ${t.duration > 0 ? fmt(t.duration) : '--:--'}` : ''
  const bar = Math.max(5, width - times.length)
  const filled = Math.round(ratio * (bar - 1))
  return { filled, rest: Math.max(0, bar - 1 - filled), times }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lecteur',
      description: 'Ouvre le lecteur audio (now playing + visualiseur Bars)',
    })

    void $.ui.open({ id: PANE, title: 'Lecteur' })

    void poll($)
    $.clock.every(1000, () => poll($))

    const startedAt = await $.clock.now()
    $.clock.every(33, async () => {
      const t = ((await $.clock.now()) - startedAt) / 1000
      for (const [requestId, site] of sites) {
        stepViz(site.viz, t, isPlaying)
        const silent = isSilent(site.viz)
        if (silent && site.isSilentBlitted) continue
        site.cells = renderViz(site.viz)
        const r = await $.ui.blit({ requestId, key: VIZ_KEY, cells: site.cells })
        if ('deny' in r && r.deny) {
          // Plus affiché (bandeau replié, panneau fermé) : il sera recréé au rendu
          sites.delete(requestId)
        } else {
          site.isSilentBlitted = silent
        }
      }
    })

    return next(e)
  })

  on('command.run', { command: 'lecteur' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Lecteur' })
    void poll($)
    return { text: 'Lecteur ouvert.' }
  })

  // Le panneau du lecteur (ouvert au démarrage, ou par /lecteur)
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = await read($, track)
    const style = await read($, vizStyleAtom)
    if (style !== vizStyle) {
      vizStyle = style
      // Le terminal repeint ses barres à la prochaine image, même au repos
      for (const site of sites.values()) site.isSilentBlitted = false
    }
    const width = Math.max(10, e.props.bodyColumns)
    // Sous le visualiseur : 8 lignes (titre, artiste, progression, boutons…)
    const room = e.props.scroll.bodyRows - BELOW_VIZ
    // Une cellule de terminal est ~2x plus haute que large : cols / 6 lignes
    // donne un visualiseur environ 3x plus large que haut, à toute largeur
    const rows = Math.max(2, Math.min(Math.round(width / 6), room))
    const { filled, rest, times } = progressLine(t, width - 1)
    const { Box, Text, Button } = $.ui.resolve(e)

    let visualizer = null
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const site = siteFor(PANE, width, rows)
      visualizer = <Raster key={VIZ_KEY} columns={width} rows={rows} cells={site.cells} />
    } else {
      // desktop, vscode, mobile : pas de Raster, mais un Svg dessiné en image
      // (le SMIL s'y anime aussi), à une taille explicite en pixels CSS
      const { Svg } = $.ui.resolve(e)
      const svgW = Math.min(SVG_W, Math.max(160, width * 8))
      visualizer = (
        <Svg
          source={t?.isPlaying ? SVGS[style].playing : SVGS[style].paused}
          alt={t?.isPlaying ? 'Visualiseur Bars en mouvement' : 'Visualiseur Bars à l’arrêt'}
          width={svgW}
          height={Math.round((svgW * SVG_H) / SVG_W)}
        />
      )
    }

    const ratio = t && t.duration > 0 ? Math.min(1, t.elapsed / t.duration) : 0
    const status = t ? `${t.isPlaying ? 'Lecture' : 'En pause'} · ${t.app}` : ' '

    // Terminal : la ligne en caractères, calculée à la colonne près.
    // Ailleurs la police est proportionnelle : la piste prend la place qui
    // reste (flexGrow), coupée par overflow, et le temps garde la sienne.
    // Le Svg des surfaces graphiques (le terminal n'en a pas)
    const LineSvg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
    const progress =
      e.surface === 'terminal' || !LineSvg ? (
        <Box flexDirection="row" marginTop={1}>
          <Text>{'━'.repeat(filled)}</Text>
          <Text>●</Text>
          <Text dimColor>{'─'.repeat(rest)}</Text>
          <Text dimColor>{times}</Text>
        </Box>
      ) : (
        <Box flexDirection="row" alignItems="center" gap={1} marginTop={1}>
          <Box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            {/* Pas de texte ici (il passe à la ligne, ou se coupe avec « … ») :
                deux traits SVG étirés à la largeur de leur boîte */}
            <Box width={`${Math.round(ratio * 100)}%`} flexShrink={0} overflow="hidden">
              <LineSvg source={style === 'wmp' ? LINE_WMP : LINE_PLAYED} alt="Écoulé" height={LINE_H} />
            </Box>
            <Box flexShrink={0}>
              <Text>●</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <LineSvg source={LINE_REST} alt="Restant" height={LINE_H} />
            </Box>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{times.trim()}</Text>
          </Box>
        </Box>
      )

    return (
      <Box flexDirection="column">
        {visualizer}
        <Box flexDirection="column" marginTop={1}>
          {t ? (
            <>
              <Text bold wrap="truncate">
                ♪ {t.title || 'Sans titre'}
              </Text>
              <Text dimColor wrap="truncate">
                {[t.artist, t.album].filter(Boolean).join(' — ') || '—'}
              </Text>
            </>
          ) : (
            <>
              <Text bold>Rien en lecture</Text>
              <Text dimColor wrap="truncate">
                Lance une musique (Qobuz, YouTube Music…)
              </Text>
            </>
          )}
        </Box>
        {progress}
        <Box flexDirection="row" justifyContent="center" gap={2} marginTop={1}>
          <Button key="prev" label="◀◀" hotkey="b" onPress={() => control($, 'prev')} />
          <Button
            key="toggle"
            label={t?.isPlaying ? '❚❚' : ' ▶ '}
            hotkey="p"
            variant="primary"
            onPress={() => control($, 'toggle')}
          />
          <Button key="next" label="▶▶" hotkey="n" onPress={() => control($, 'next')} />
        </Box>
        {/* Centrée sous les boutons, détachée d'une ligne ; à droite, la
            bascule de rendu, discrète : un glyphe nu, atténué */}
        <Box flexDirection="row" justifyContent="center" alignItems="center" gap={1} marginTop={1}>
          <Text dimColor wrap="truncate">
            {status}
          </Text>
          <Button
            key="viz-style"
            label={style === 'wmp' ? '◐' : '◑'}
            plain
            dimColor
            onPress={() => update($, vizStyleAtom, s => (s === 'wmp' ? 'mono' : 'wmp'))}
          />
        </Box>
      </Box>
    )
  })
}
