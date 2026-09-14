// ブラウザだけで鳴らす簡易DJエンジン。2デッキ分の再生とEQを持つ。
// 受け口はMIDIではなくDJの用語。MIDIとの結線は呼び出し側でやる。

import { analyzeBpm } from '@/core/bpm'

export type DeckIndex = 0 | 1
export type EqBand = 'high' | 'mid' | 'low'

export type DeckState = {
  name: string | null
  duration: number
  bpm: number | null        // 読み込み時の推定値
  playing: boolean
  cue: number
  cues: (number | null)[]   // ホットキュー4つ。未登録は null
  loading: boolean
  error?: string
}

export const TEMPO_RANGE = 0.08     // テンポフェーダの可変幅 ±8%
export const SCRATCH_GAIN = 2.5     // ジョグの振り切りで何倍速まで出すか
export const HOTCUE_COUNT = 4
export const PEAK_BUCKETS = 480     // 波形表示の解像度
export const HOTCUE_HOLD_MS = 700   // 登録済みをこれだけ押し続けると消す

const EQ_MIN_DB = -26               // 絞り切りは実質キル
const EQ_MAX_DB = 6
const RAMP = 0.02                   // 値を動かすときのクリック避け
const FILTER_MIN_HZ = 200
const FILTER_MAX_HZ = 18000

const emptyState = (): DeckState => ({
  name: null, duration: 0, bpm: null, playing: false, cue: 0, loading: false,
  cues: Array(HOTCUE_COUNT).fill(null),
})

type Deck = {
  node: AudioWorkletNode | null
  peaks: Float32Array | null
  loaded: boolean
  high: BiquadFilterNode
  mid: BiquadFilterNode
  low: BiquadFilterNode
  hpf: BiquadFilterNode
  lpf: BiquadFilterNode
  gain: GainNode
  playing: boolean
  reportedPos: number   // ワークレットから届いた位置
  reportedAt: number    // それを受け取った時刻
  tempo: number       // テンポフェーダ由来の基準レート
  touching: boolean   // タンテに触れているか
  scratch: number     // 触れている間のレート
  cue: number
  state: DeckState
}

// 波形表示用に、区間ごとの最大振幅へ畳む
function computePeaks(buffer: AudioBuffer): Float32Array {
  const data = buffer.getChannelData(0)
  const out = new Float32Array(PEAK_BUCKETS)
  const per = Math.max(1, Math.floor(data.length / PEAK_BUCKETS))

  for (let b = 0; b < PEAK_BUCKETS; b++) {
    const start = b * per
    const end = Math.min(data.length, start + per)
    let peak = 0
    for (let i = start; i < end; i++) {
      const v = Math.abs(data[i])
      if (v > peak) peak = v
    }
    out[b] = peak
  }
  return out
}

export function createDjEngine(onChange?: (states: DeckState[]) => void) {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  const master = ctx.createGain()
  master.connect(ctx.destination)

  const makeDeck = (): Deck => {
    const high = ctx.createBiquadFilter()
    const mid  = ctx.createBiquadFilter()
    const low  = ctx.createBiquadFilter()
    const hpf  = ctx.createBiquadFilter()
    const lpf  = ctx.createBiquadFilter()
    const gain = ctx.createGain()

    high.type = 'highshelf'; high.frequency.value = 3200
    mid.type  = 'peaking';   mid.frequency.value  = 1000; mid.Q.value = 0.8
    low.type  = 'lowshelf';  low.frequency.value  = 220
    hpf.type  = 'highpass';  hpf.frequency.value  = 20
    lpf.type  = 'lowpass';   lpf.frequency.value  = 20000

    high.connect(mid).connect(low).connect(hpf).connect(lpf).connect(gain).connect(master)

    return {
      node: null, peaks: null, loaded: false,
      high, mid, low, hpf, lpf, gain,
      playing: false, reportedPos: 0, reportedAt: 0,
      tempo: 1, touching: false, scratch: 0, cue: 0,
      state: emptyState(),
    }
  }

  const decks: Deck[] = [makeDeck(), makeDeck()]
  const holds = new Map<string, ReturnType<typeof setTimeout>>()
  const notify = () => onChange?.(decks.map(d => d.state))
  const update = (d: Deck, patch: Partial<DeckState>) => { d.state = { ...d.state, ...patch }; notify() }

  // 読み出しはワークレットに任せる。速度を負にできるので逆回転と擦りができる
  const ready = ctx.audioWorklet.addModule('/deck-processor.js').then(() => {
    for (const d of decks) {
      const node = new AudioWorkletNode(ctx, 'deck', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      })
      node.port.onmessage = ({ data }: MessageEvent<{ position: number; ended: boolean }>) => {
        d.reportedPos = data.position / ctx.sampleRate
        d.reportedAt = ctx.currentTime
        if (data.ended && d.playing) { d.playing = false; update(d, { playing: false }) }
      }
      node.connect(d.high)
      d.node = node
    }
  }).catch(() => {
    for (const d of decks) update(d, { error: 'この環境では再生できません' })
  })

  const send = (d: Deck, msg: Record<string, unknown>) => d.node?.port.postMessage(msg)

  // 実際に鳴らすレート。タンテに触れている間はジョグが決める
  const rateOf = (d: Deck) => (d.touching ? d.scratch : d.tempo)

  const positionOf = (d: Deck) => {
    const moved = d.playing ? (ctx.currentTime - d.reportedAt) * rateOf(d) : 0
    return Math.max(0, Math.min(d.state.duration, d.reportedPos + moved))
  }

  const markAt = (d: Deck, at: number) => {
    d.reportedPos = Math.max(0, Math.min(d.state.duration, at))
    d.reportedAt = ctx.currentTime
  }

  function start(d: Deck, from: number) {
    if (!d.loaded) return
    markAt(d, from)
    send(d, { type: 'seek', position: d.reportedPos * ctx.sampleRate })
    send(d, { type: 'rate', value: rateOf(d) })
    send(d, { type: 'play' })
    d.playing = true
  }

  function pauseAt(d: Deck, at: number) {
    markAt(d, at)
    send(d, { type: 'pause' })
    send(d, { type: 'seek', position: d.reportedPos * ctx.sampleRate })
    d.playing = false
  }

  // レートを変える。位置の計算がずれないよう、変える前に現在位置へ畳む
  function applyRate(d: Deck) {
    if (d.playing) markAt(d, positionOf(d))
    send(d, { type: 'rate', value: rateOf(d) })
  }

  // --- 外向きの操作 ---

  async function load(i: DeckIndex, file: File) {
    const d = decks[i]
    update(d, { loading: true, error: undefined })
    try {
      await ready
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
      pauseAt(d, 0)
      d.peaks = computePeaks(buffer)
      d.cue = 0
      update(d, {
        name: file.name, duration: buffer.duration, bpm: await analyzeBpm(buffer),
        playing: false, cue: 0, loading: false,
        cues: Array(HOTCUE_COUNT).fill(null),
      })

      // 波形とBPMを取り終えたら、生データはワークレットへ渡して手放す
      const channels: Float32Array[] = []
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
        channels.push(buffer.getChannelData(c).slice())
      }
      send(d, { type: 'load', channels, length: buffer.length })
      d.loaded = true
      d.playing = false
      markAt(d, 0)
    } catch {
      update(d, { loading: false, error: 'この音声ファイルは読み込めません' })
    }
  }

  function play(i: DeckIndex) {
    const d = decks[i]
    if (!d.loaded || d.playing) return
    start(d, d.reportedPos >= d.state.duration - 0.01 ? 0 : d.reportedPos)
    update(d, { playing: true })
  }

  function pause(i: DeckIndex) {
    const d = decks[i]
    if (!d.playing) return
    pauseAt(d, positionOf(d))
    update(d, { playing: false })
  }

  function toggle(i: DeckIndex) {
    if (decks[i].playing) pause(i)
    else play(i)
  }

  // 止まっていれば頭出し点から試聴、鳴っていればそこを頭出し点にして戻る
  function cuePress(i: DeckIndex) {
    const d = decks[i]
    if (!d.loaded) return
    if (d.playing) {
      d.cue = positionOf(d)
      pauseAt(d, d.cue)
      update(d, { playing: false, cue: d.cue })
      return
    }
    start(d, d.cue)
    update(d, { playing: true })
  }

  function cueRelease(i: DeckIndex) {
    const d = decks[i]
    if (!d.loaded || !d.playing) return
    pauseAt(d, d.cue)
    update(d, { playing: false })
  }

  // タンテに触れた。離すまではジョグがレートを握る
  function touch(i: DeckIndex, down: boolean) {
    const d = decks[i]
    if (d.touching === down) return
    if (d.playing) markAt(d, positionOf(d))
    d.touching = down
    d.scratch = 0
    applyRate(d)
  }

  // amount は -1..1。負なら逆に回る
  function jog(i: DeckIndex, amount: number) {
    const d = decks[i]
    if (!d.touching) return
    d.scratch = amount * SCRATCH_GAIN
    applyRate(d)
  }

  // value は 0..16383。中央で等速
  function setTempo(i: DeckIndex, value: number) {
    const d = decks[i]
    const ratio = (Math.max(0, Math.min(16383, value)) - 8192) / 8192
    d.tempo = 1 + ratio * TEMPO_RANGE
    applyRate(d)
  }

  // value は 0..127。64 が素通し
  function setEq(i: DeckIndex, band: EqBand, value: number) {
    const d = decks[i]
    const v = Math.max(0, Math.min(127, value))
    const db = v <= 64
      ? EQ_MIN_DB * (1 - v / 64)
      : EQ_MAX_DB * ((v - 64) / 63)
    const node = band === 'high' ? d.high : band === 'mid' ? d.mid : d.low
    node.gain.setTargetAtTime(db, ctx.currentTime, RAMP)
  }

  // 64 で素通し。左でローパス、右でハイパス
  function setFilter(i: DeckIndex, value: number) {
    const d = decks[i]
    const v = Math.max(0, Math.min(127, value))
    const now = ctx.currentTime
    if (v < 64) {
      const t = v / 64
      d.lpf.frequency.setTargetAtTime(FILTER_MIN_HZ + (FILTER_MAX_HZ - FILTER_MIN_HZ) * t * t, now, RAMP)
      d.hpf.frequency.setTargetAtTime(20, now, RAMP)
    } else {
      const t = (v - 64) / 63
      d.hpf.frequency.setTargetAtTime(20 + 8000 * t * t, now, RAMP)
      d.lpf.frequency.setTargetAtTime(20000, now, RAMP)
    }
  }

  // 押した時点で未登録なら登録、登録済みならそこから再生。
  // 登録済みを押し続けると消す
  function hotCue(i: DeckIndex, index: number, down: boolean) {
    const d = decks[i]
    const key = `${i}:${index}`
    if (!d.loaded || index < 0 || index >= HOTCUE_COUNT) return

    if (!down) {
      const timer = holds.get(key)
      if (timer) { clearTimeout(timer); holds.delete(key) }
      return
    }

    const at = d.state.cues[index]
    if (at === null) {
      const cues = [...d.state.cues]
      cues[index] = positionOf(d)
      update(d, { cues })
      return
    }

    start(d, at)
    update(d, { playing: true })
    holds.set(key, setTimeout(() => {
      holds.delete(key)
      const cues = [...d.state.cues]
      cues[index] = null
      update(d, { cues })
    }, HOTCUE_HOLD_MS))
  }

  // 倍や半分で拾ったときに手で直す
  function setBpm(i: DeckIndex, bpm: number) {
    const d = decks[i]
    if (!d.state.bpm) return
    const v = Math.min(400, Math.max(20, bpm))
    update(d, { bpm: Math.round(v * 10) / 10 })
  }

  function seek(i: DeckIndex, to: number) {
    const d = decks[i]
    if (!d.loaded) return
    if (d.playing) start(d, to)
    else pauseAt(d, to)
    notify()
  }

  // iOS は操作を挟まないと鳴らない
  const resume = () => ctx.resume()

  function dispose() {
    holds.forEach(clearTimeout)
    holds.clear()
    decks.forEach(d => { send(d, { type: 'pause' }); d.node?.disconnect(); d.gain.disconnect() })
    ctx.close()
  }

  return {
    load, play, pause, toggle,
    cuePress, cueRelease,
    touch, jog, setTempo, setEq, setFilter, seek, hotCue, setBpm,
    position: (i: DeckIndex) => positionOf(decks[i]),
    peaks: (i: DeckIndex) => decks[i].peaks,
    rate:  (i: DeckIndex) => decks[i].tempo,
    states: () => decks.map(d => d.state),
    resume, dispose,
  }
}

export type DjEngine = ReturnType<typeof createDjEngine>
