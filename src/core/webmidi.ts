// ブラウザから直接 MIDI を出す。ブリッジの代わりにモニタ画面が音を出す。
// 仮想ポートは作れないので、OS のループバック (IAC / loopMIDI) へ出す。

import { PITCH_CENTER } from '@/core/mapping'

type MidiNavigator = Navigator & {
  requestMIDIAccess?: (opts?: MIDIOptions) => Promise<MIDIAccess>
}

export type WebMidiPort = { id: string; name: string }

export type WebMidiState = {
  supported: boolean
  ready: boolean
  name: string | null
  ports: WebMidiPort[]
  error?: string
}

const STORAGE_KEY = 'dokodemo-dj:midiout'
const NOTE_OFF = 0x80
const NOTE_ON  = 0x90
const BEND     = 0xe0

export function isWebMidiSupported(): boolean {
  return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator
}

export function createWebMidiSink(onChange?: (state: WebMidiState) => void) {
  let access: MIDIAccess | null = null
  let out: MIDIOutput | null = null
  let error: string | undefined

  // 離脱時に戻すため、鳴らした音を覚えておく
  const activeNotes  = new Set<string>()
  const bentChannels = new Set<number>()

  const portName = (p: MIDIOutput): string => p.name ?? p.id

  const ports = (): WebMidiPort[] =>
    access ? Array.from(access.outputs.values()).map(p => ({ id: p.id, name: portName(p) })) : []

  const state = (): WebMidiState => ({
    supported: isWebMidiSupported(),
    ready: access !== null,
    name: out ? portName(out) : null,
    ports: ports(),
    error,
  })

  const notify = () => onChange?.(state())

  // id は環境をまたぐと変わるので、名前で覚える
  const remembered = (): string | null => {
    try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
  }
  const remember = (name: string | null) => {
    try {
      if (name) localStorage.setItem(STORAGE_KEY, name)
      else localStorage.removeItem(STORAGE_KEY)
    } catch { /* プライベートモード */ }
  }

  // 探し方はブリッジ側に揃える
  function find(key: string): MIDIOutput | null {
    if (!access) return null
    const list = Array.from(access.outputs.values())
    return list.find(p => p.id === key)
      ?? list.find(p => portName(p) === key)
      ?? list.find(p => portName(p).includes(key))
      ?? null
  }

  function track(b: Uint8Array) {
    const status = b[0] & 0xf0
    const ch = b[0] & 0x0f
    if (status === NOTE_ON && b[2] > 0) activeNotes.add(`${ch}:${b[1]}`)
    else if (status === NOTE_ON || status === NOTE_OFF) activeNotes.delete(`${ch}:${b[1]}`)
    else if (status === BEND) {
      const v = (b[2] << 7) | b[1]
      if (v === PITCH_CENTER) bentChannels.delete(ch)
      else bentChannels.add(ch)
    }
  }

  function raw(bytes: number[]) {
    out?.send(bytes)
  }

  // 鳴りっぱなしを戻し、件数を返す
  function panic(): number {
    const n = activeNotes.size + bentChannels.size
    if (!out || n === 0) { activeNotes.clear(); bentChannels.clear(); return 0 }

    for (const key of activeNotes) {
      const [ch, note] = key.split(':').map(Number)
      raw([NOTE_OFF | ch, note, 0])
    }
    for (const ch of bentChannels) {
      raw([BEND | ch, PITCH_CENTER & 0x7f, (PITCH_CENTER >> 7) & 0x7f])
    }
    activeNotes.clear()
    bentChannels.clear()
    return n
  }

  // key は名前か id。null で閉じる
  function open(key: string | null): WebMidiState {
    if (!access) throw new Error('Web MIDI が有効ではありません')
    panic()

    if (!key) {
      out?.close?.()
      out = null
      remember(null)
      notify()
      return state()
    }

    const hit = find(key)
    if (!hit) throw new Error(`MIDI ポート "${key}" が見つかりません`)

    out?.close?.()
    out = hit
    error = undefined
    remember(portName(hit))
    notify()
    return state()
  }

  // 許可を取り、前回のポートを開き直す
  async function enable(): Promise<WebMidiState> {
    if (access) return state()

    const nav = navigator as MidiNavigator
    if (!nav.requestMIDIAccess) {
      error = 'このブラウザは Web MIDI に対応していません'
      notify()
      return state()
    }

    try {
      access = await nav.requestMIDIAccess({ sysex: false })
      error = undefined
    } catch (e) {
      error = e instanceof Error ? e.message : 'MIDI の使用が許可されませんでした'
      notify()
      return state()
    }

    // 抜き差しに追従する
    const granted = access
    granted.onstatechange = () => {
      // 開いていたポートが消えたら手放す。もう届かないので記録も捨てる
      if (out && out.state === 'disconnected') {
        activeNotes.clear()
        bentChannels.clear()
        out = null
        error = 'MIDI ポートが切断されました'
      } else if (!out) {
        const saved = remembered()
        if (saved) { try { open(saved) } catch { /* まだ現れていない */ } }
      }
      notify()
    }

    const saved = remembered()
    if (saved) { try { open(saved) } catch { /* 前回のポートが無い */ } }
    notify()
    return state()
  }

  function send(bytes: Uint8Array) {
    if (!out || bytes.length !== 3) return
    track(bytes)
    raw([bytes[0], bytes[1], bytes[2]])
  }

  function close() {
    panic()
    out?.close?.()
    out = null
    if (access) access.onstatechange = null
    notify()
  }

  return { state, ports, enable, open, send, panic, close }
}

export type WebMidiSink = ReturnType<typeof createWebMidiSink>
