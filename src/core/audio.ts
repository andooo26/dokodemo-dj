// ブラウザだけで鳴らす簡易DJエンジン。2デッキ分の再生とEQを持つ。
// 受け口はMIDIではなくDJの用語。MIDIとの結線は呼び出し側でやる。

import { analyzeBeats } from '@/core/bpm'

export type DeckIndex = 0 | 1
export type EqBand = 'high' | 'mid' | 'low'

export type DeckState = {
  name: string | null
  duration: number
  bpm: number | null        // 読み込み時の推定値
  beat: number | null       // 最初の拍。null なら拍が取れなかった
  bar: number               // 最初の小節頭
  playing: boolean
  cue: number
  cues: (number | null)[]   // ホットキュー4つ。未登録は null
  keylock: boolean          // テンポを変えてもピッチを保つ
  synced: boolean           // マスターに追従しているか
  master: boolean           // このデッキがテンポの基準か
  loading: boolean
  error?: string
}

export const TEMPO_RANGE = 0.08     // テンポフェーダの可変幅 ±8%
export const SCRATCH_GAIN = 2.5     // ジョグの振り切りで何倍速まで出すか
export const HOTCUE_COUNT = 4
export const PEAKS_PER_SEC = 100    // 波形表示の解像度。拡大に耐えるよう秒あたりで持つ
export const HOTCUE_HOLD_MS = 700   // 登録済みをこれだけ押し続けると消す
export const BEATS_PER_BAR = 4

// 同期のズレを戻す速さ。急に直すと音程が跳ねるので、数拍かけて寄せる
const LOCK_MS = 250       // ズレを見にいく間隔
const LOCK_GAIN = 0.05    // 1拍ぶんのズレに対して何倍のレートを足すか
const LOCK_MAX = 0.02     // 足すレートの上限。±2%なら耳につかない
const LOCK_LIMIT = 0.25   // これ以上ずれていたら直さない。別の拍へ寄せてしまうため

const EQ_MIN_DB = -26               // 絞り切りは実質キル
const EQ_MAX_DB = 6
const RAMP = 0.02                   // 値を動かすときのクリック避け
const FILTER_MIN_HZ = 200
const FILTER_MAX_HZ = 18000

const emptyState = (): DeckState => ({
  name: null, duration: 0, bpm: null, beat: null, bar: 0, playing: false, cue: 0,
  keylock: false, synced: false, master: false, loading: false,
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
  keylock: boolean    // ワークレットに渡してある値
  synced: boolean     // マスターに追従しているか
  trim: number        // 位相のズレを戻すための、一時的なレートの足し引き
  touching: boolean   // タンテに触れているか
  scratch: number     // 触れている間のレート
  cue: number
  state: DeckState
}

// 波形表示用に、一定時間ごとの最大振幅へ畳む。
// 全体を何分割ではなく秒あたり固定なので、拡大しても粒が揃う
function computePeaks(buffer: AudioBuffer): Float32Array {
  const data = buffer.getChannelData(0)
  const per = Math.max(1, Math.round(buffer.sampleRate / PEAKS_PER_SEC))
  const out = new Float32Array(Math.ceil(data.length / per))

  for (let b = 0; b < out.length; b++) {
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
      tempo: 1, keylock: false, synced: false, trim: 0, touching: false, scratch: 0, cue: 0,
      state: emptyState(),
    }
  }

  const decks: Deck[] = [makeDeck(), makeDeck()]
  let masterDeck: DeckIndex = 0   // テンポの基準になるデッキ。初期値は左
  const holds = new Map<string, ReturnType<typeof setTimeout>>()
  const notify = () => onChange?.(decks.map(d => d.state))
  decks[masterDeck].state = { ...decks[masterDeck].state, master: true }
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

  // 実際に鳴らすレート。擦りは別ヘッドが受け持つので、ここには効かない
  const rateOf = (d: Deck) => d.tempo * (1 + d.trim)

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

  function seekTo(d: Deck, to: number) {
    if (d.playing) start(d, to)
    else pauseAt(d, to)
  }

  // --- ビートシンク ---
  // 拍の長さも位置も「曲の中の秒数」で持つ。再生速度の影響を受けない

  const beatLenOf = (d: Deck) => (d.state.bpm ? 60 / d.state.bpm : 0)

  // 今いる場所が1拍のどのあたりか。0〜1で返す
  function beatPhaseOf(d: Deck): number | null {
    const len = beatLenOf(d)
    if (!len || d.state.beat === null) return null
    const x = (positionOf(d) - d.state.beat) / len
    return x - Math.floor(x)
  }

  // 2台の拍のズレ。-0.5〜0.5拍で、近い方の拍へ寄せる向きを返す
  function phaseErrorOf(d: Deck, m: Deck): number | null {
    const pd = beatPhaseOf(d)
    const pm = beatPhaseOf(m)
    if (pd === null || pm === null) return null
    const err = pm - pd
    return err - Math.round(err)
  }

  // 拍を合わせる。両方鳴っているときだけ。片方が止まっていれば頭は合わせられない
  function alignPhase(d: Deck, m: Deck) {
    if (!d.playing || !m.playing) return
    const err = phaseErrorOf(d, m)
    if (err === null) return
    seekTo(d, positionOf(d) + err * beatLenOf(d))
  }

  // マスターと同じ実効BPMになるレートを入れる。テンポフェーダの可変幅は超えてよい
  function followMaster(d: Deck) {
    const m = decks[masterDeck]
    if (!d.state.bpm || !m.state.bpm) return
    d.tempo = (m.state.bpm * m.tempo) / d.state.bpm
    applyRate(d)
  }

  function unsync(d: Deck) {
    if (!d.synced) return
    d.synced = false
    d.trim = 0
    update(d, { synced: false })
  }

  // ズレを見張って、レートを少しだけ足し引きして寄せる。
  // 一気に飛ばすと音が途切れるので、数拍かけて詰める
  const lock = setInterval(() => {
    const m = decks[masterDeck]
    for (const d of decks) {
      if (d === m || !d.synced) continue
      followMaster(d)
      if (!d.playing || !m.playing) { d.trim = 0; continue }
      const err = phaseErrorOf(d, m)
      if (err === null || Math.abs(err) > LOCK_LIMIT) { d.trim = 0; continue }
      d.trim = Math.max(-LOCK_MAX, Math.min(LOCK_MAX, err * LOCK_GAIN))
      applyRate(d)
    }
  }, LOCK_MS)

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
      d.synced = false
      d.trim = 0
      const grid = await analyzeBeats(buffer)
      update(d, {
        name: file.name, duration: buffer.duration,
        bpm: grid?.bpm ?? null, beat: grid?.firstBeat ?? null, bar: grid?.firstBar ?? 0,
        playing: false, cue: 0, loading: false, synced: false,
        cues: Array(HOTCUE_COUNT).fill(null),
      })
      send(d, { type: 'keylock', value: d.keylock })

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
    // 止まっている間は拍を合わせられないので、鳴らし始めにここで合わせる
    if (d.synced) alignPhase(d, decks[masterDeck])
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

  // タンテに触れた。触れた地点の数秒が擦りヘッドへ渡り、曲はそのまま流れ続ける
  function touch(i: DeckIndex, down: boolean) {
    const d = decks[i]
    if (d.touching === down || !d.loaded) return
    d.touching = down
    d.scratch = 0
    send(d, { type: 'scratch', value: down })
    send(d, { type: 'srate', value: 0 })
    if (!down) send(d, { type: 'gate', value: 1 })
  }

  // amount は -1..1。負なら逆に回る。手を止めれば擦りヘッドも止まり、無音になる
  function jog(i: DeckIndex, amount: number) {
    const d = decks[i]
    if (!d.touching) return
    d.scratch = amount * SCRATCH_GAIN
    send(d, { type: 'srate', value: d.scratch })
  }

  // 擦り音の音量。トランスフォーマーのように拍で刻むのに使う。value は 0..127
  function setScratchGate(i: DeckIndex, value: number) {
    const d = decks[i]
    if (!d.touching) return
    send(d, { type: 'gate', value: Math.max(0, Math.min(127, value)) / 127 })
  }

  // value は 0..16383。中央で等速
  function setTempo(i: DeckIndex, value: number) {
    const d = decks[i]
    const ratio = (Math.max(0, Math.min(16383, value)) - 8192) / 8192
    d.tempo = 1 + ratio * TEMPO_RANGE
    unsync(d)   // フェーダを自分で動かしたら同期は外れる
    applyRate(d)
    if (decks.indexOf(d) === masterDeck) decks.forEach(o => { if (o.synced) followMaster(o) })
  }

  // マスターに合わせる。実効BPMを揃えてから、拍の頭を合わせる。
  // 合わせ先は一番近い拍。小節単位ではないので、最大でも半拍しか飛ばない
  function sync(i: DeckIndex) {
    const d = decks[i]
    const m = decks[masterDeck]
    if (d === m || !d.loaded || !m.loaded || !d.state.bpm || !m.state.bpm) return
    if (d.synced) { unsync(d); return }

    d.synced = true
    d.trim = 0
    followMaster(d)
    alignPhase(d, m)
    update(d, { synced: true })
  }

  // 基準にするデッキを選ぶ。自分は誰にも追従しない
  function setMaster(i: DeckIndex) {
    if (masterDeck === i) return
    masterDeck = i
    unsync(decks[i])
    decks.forEach((d, k) => update(d, { master: k === i }))
    decks.forEach(d => { if (d.synced) followMaster(d) })
  }

  // テンポを変えてもピッチを保つ。擦っている間はワークレット側で素通しになる
  function setKeylock(i: DeckIndex, on: boolean) {
    const d = decks[i]
    if (d.keylock === on) return
    d.keylock = on
    send(d, { type: 'keylock', value: on })
    update(d, { keylock: on })
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
    if (d.synced) followMaster(d)
    else if (decks.indexOf(d) === masterDeck) decks.forEach(o => { if (o.synced) followMaster(o) })
  }

  function seek(i: DeckIndex, to: number) {
    const d = decks[i]
    if (!d.loaded) return
    seekTo(d, to)
    notify()
  }

  // iOS は操作を挟まないと鳴らない
  const resume = () => ctx.resume()

  function dispose() {
    clearInterval(lock)
    holds.forEach(clearTimeout)
    holds.clear()
    decks.forEach(d => { send(d, { type: 'pause' }); d.node?.disconnect(); d.gain.disconnect() })
    ctx.close()
  }

  return {
    load, play, pause, toggle,
    cuePress, cueRelease,
    touch, jog, setScratchGate, setTempo, setKeylock, setEq, setFilter, seek, hotCue, setBpm,
    sync, setMaster,
    beatPhase: (i: DeckIndex) => beatPhaseOf(decks[i]),
    position: (i: DeckIndex) => positionOf(decks[i]),
    beatPhase: (i: DeckIndex) => beatPhaseOf(decks[i]),
    peaks: (i: DeckIndex) => decks[i].peaks,
    rate:  (i: DeckIndex) => decks[i].tempo,
    states: () => decks.map(d => d.state),
    resume, dispose,
  }
}

export type DjEngine = ReturnType<typeof createDjEngine>
