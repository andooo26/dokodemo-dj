// ブラウザだけで鳴らす簡易DJエンジン。2デッキ分の再生とEQを持つ。
// 受け口はMIDIではなくDJの用語。MIDIとの結線は呼び出し側でやる。

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
const BPM_MIN = 85                  // 倍テンポ・半テンポをこの範囲へ畳む
const BPM_MAX = 175
const HARMONICS = 4                 // 倍音をどこまで見るか
const PRIOR_CENTER = 128            // 倍と半分が同点のとき、この辺りを選ぶ
const PRIOR_WIDTH = 0.55            // オクターブ単位の広がり
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
  buffer: AudioBuffer | null
  peaks: Float32Array | null
  source: AudioBufferSourceNode | null
  high: BiquadFilterNode
  mid: BiquadFilterNode
  low: BiquadFilterNode
  hpf: BiquadFilterNode
  lpf: BiquadFilterNode
  gain: GainNode
  playing: boolean
  offset: number      // 最後に再生を始めた位置
  startedAt: number   // その時刻
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

// 音量の立ち上がりを拾い、その周期の自己相関からBPMを当てる。
// 四つ打ちには強いが、リズムの薄い曲では外れる
function analyzeBpm(buffer: AudioBuffer): number | null {
  const src   = buffer.getChannelData(0)
  const step  = Math.max(1, Math.round(buffer.sampleRate / 11025))
  const frame = 256
  const hop   = 64      // 重ねて刻む。1コマ約6ミリ秒
  const frames = Math.floor((src.length / step - frame) / hop)
  if (frames < 128) return null

  const energy = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = f * hop * step
    let sum = 0
    for (let i = 0; i < frame; i++) {
      const v = src[start + i * step]
      sum += v * v
    }
    energy[f] = Math.sqrt(sum / frame)
  }

  // 立ち上がりだけ残し、平均を引いて底を揃える
  const onset = new Float32Array(frames)
  let mean = 0
  for (let f = 1; f < frames; f++) {
    const diff = energy[f] - energy[f - 1]
    onset[f] = diff > 0 ? diff : 0
    mean += onset[f]
  }
  mean /= frames
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, onset[f] - mean)

  // lag は実数で受ける。コマの間は線形に読む
  const corr = (lag: number) => {
    const base = Math.floor(lag)
    const frac = lag - base
    let sum = 0
    let n = 0
    for (let f = base + 1; f < frames; f++) {
      const back = onset[f - base] * (1 - frac) + onset[f - base - 1] * frac
      sum += onset[f] * back
      n++
    }
    return n ? sum / n : 0
  }

  const secPerFrame = (hop * step) / buffer.sampleRate
  const lagOf = (bpm: number) => 60 / (bpm * secPerFrame)

  // 整数lagの自己相関を先に作る。倍音の確認で何度も引くため
  const maxLag = Math.min(frames - 2, Math.ceil(lagOf(BPM_MIN) * HARMONICS))
  const ac = new Float32Array(maxLag + 1)
  for (let lag = 2; lag <= maxLag; lag++) ac[lag] = corr(lag)

  const acAt = (lag: number) => {
    if (lag < 2 || lag >= maxLag) return 0
    const base = Math.floor(lag)
    const frac = lag - base
    return ac[base] * (1 - frac) + ac[base + 1] * frac
  }

  // 本当の拍なら、その2倍3倍の位置にも山が立つ。
  // 1.5倍や半分で拾った候補はここで落ちる
  const comb = (bpm: number, at: (lag: number) => number) => {
    const lag = lagOf(bpm)
    let sum = 0
    for (let h = 1; h <= HARMONICS; h++) sum += at(h * lag) / h
    return sum
  }

  // 倍でも半分でも倍音の裏付けは同じだけ出る。人の感じ方に寄せて解く
  const prior = (bpm: number) =>
    Math.exp(-0.5 * Math.pow(Math.log2(bpm / PRIOR_CENTER) / PRIOR_WIDTH, 2))

  let bpm = 0
  let best = 0
  for (let cand = BPM_MIN; cand <= BPM_MAX; cand += 0.25) {
    const v = comb(cand, acAt) * prior(cand)
    if (v > best) { best = v; bpm = cand }
  }
  if (!bpm || best <= 0) return null

  // 周辺を実信号で細かく走査する
  let fine = comb(bpm, corr) * prior(bpm)
  for (let d = -0.5; d <= 0.5; d += 0.01) {
    const cand = bpm + d
    if (cand < BPM_MIN || cand > BPM_MAX) continue
    const v = comb(cand, corr) * prior(cand)
    if (v > fine) { fine = v; bpm = cand }
  }

  return Math.round(bpm * 10) / 10
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
      buffer: null, peaks: null, source: null,
      high, mid, low, hpf, lpf, gain,
      playing: false, offset: 0, startedAt: 0,
      tempo: 1, touching: false, scratch: 0, cue: 0,
      state: emptyState(),
    }
  }

  const decks: Deck[] = [makeDeck(), makeDeck()]
  const holds = new Map<string, ReturnType<typeof setTimeout>>()
  const notify = () => onChange?.(decks.map(d => d.state))
  const update = (d: Deck, patch: Partial<DeckState>) => { d.state = { ...d.state, ...patch }; notify() }

  // 実際に鳴らすレート。タンテに触れている間はジョグが決める
  const rateOf = (d: Deck) => (d.touching ? d.scratch : d.tempo)

  const positionOf = (d: Deck) => {
    if (!d.playing) return d.offset
    const p = d.offset + (ctx.currentTime - d.startedAt) * rateOf(d)
    return Math.max(0, Math.min(d.state.duration, p))
  }

  // 鳴らし直す。Web Audio のソースは一度止めると再利用できない
  function start(d: Deck, from: number) {
    if (!d.buffer) return
    stopSource(d)
    const src = ctx.createBufferSource()
    src.buffer = d.buffer
    src.playbackRate.value = Math.max(0, rateOf(d))
    src.connect(d.high)
    src.onended = () => {
      // 自然に終わった場合だけ止める。差し替えのときは onended を外してある
      if (d.source !== src) return
      d.playing = false
      d.offset = d.state.duration
      update(d, { playing: false })
    }
    src.start(0, Math.max(0, Math.min(d.state.duration, from)))
    d.source = src
    d.offset = from
    d.startedAt = ctx.currentTime
    d.playing = true
  }

  function stopSource(d: Deck) {
    if (!d.source) return
    d.source.onended = null
    try { d.source.stop() } catch { /* まだ鳴っていない */ }
    d.source.disconnect()
    d.source = null
  }

  function pauseAt(d: Deck, at: number) {
    stopSource(d)
    d.playing = false
    d.offset = at
  }

  // レートを変える。位置の計算がずれないよう、変える前に現在位置へ畳む
  function applyRate(d: Deck) {
    const next = Math.max(0, rateOf(d))
    if (!d.playing || !d.source) return
    d.offset = positionOf(d)
    d.startedAt = ctx.currentTime
    d.source.playbackRate.setTargetAtTime(next, ctx.currentTime, RAMP)
  }

  // --- 外向きの操作 ---

  async function load(i: DeckIndex, file: File) {
    const d = decks[i]
    update(d, { loading: true, error: undefined })
    try {
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
      pauseAt(d, 0)
      d.buffer = buffer
      d.peaks = computePeaks(buffer)
      d.cue = 0
      update(d, {
        name: file.name, duration: buffer.duration, bpm: analyzeBpm(buffer),
        playing: false, cue: 0, loading: false,
        cues: Array(HOTCUE_COUNT).fill(null),
      })
    } catch {
      update(d, { loading: false, error: 'この音声ファイルは読み込めません' })
    }
  }

  function play(i: DeckIndex) {
    const d = decks[i]
    if (!d.buffer || d.playing) return
    start(d, d.offset >= d.state.duration ? 0 : d.offset)
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
    if (!d.buffer) return
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
    if (!d.buffer || !d.playing) return
    pauseAt(d, d.cue)
    update(d, { playing: false })
  }

  // タンテに触れた。離すまではジョグがレートを握る
  function touch(i: DeckIndex, down: boolean) {
    const d = decks[i]
    if (d.touching === down) return
    if (d.playing) d.offset = positionOf(d)
    d.touching = down
    d.scratch = 0
    d.startedAt = ctx.currentTime
    applyRate(d)
  }

  // amount は -1..1。逆回転は出せないので、戻す向きは無音になる
  function jog(i: DeckIndex, amount: number) {
    const d = decks[i]
    if (!d.touching) return
    d.scratch = Math.max(0, amount) * SCRATCH_GAIN
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
    if (!d.buffer || index < 0 || index >= HOTCUE_COUNT) return

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

  function seek(i: DeckIndex, to: number) {
    const d = decks[i]
    if (!d.buffer) return
    if (d.playing) start(d, to)
    else pauseAt(d, to)
    notify()
  }

  // iOS は操作を挟まないと鳴らない
  const resume = () => ctx.resume()

  function dispose() {
    holds.forEach(clearTimeout)
    holds.clear()
    decks.forEach(d => { stopSource(d); d.gain.disconnect() })
    ctx.close()
  }

  return {
    load, play, pause, toggle,
    cuePress, cueRelease,
    touch, jog, setTempo, setEq, setFilter, seek, hotCue,
    position: (i: DeckIndex) => positionOf(decks[i]),
    peaks: (i: DeckIndex) => decks[i].peaks,
    rate:  (i: DeckIndex) => decks[i].tempo,
    states: () => decks.map(d => d.state),
    resume, dispose,
  }
}

export type DjEngine = ReturnType<typeof createDjEngine>
