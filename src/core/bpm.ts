// ビートグリッドの推定。音の立ち上がりを周波数領域で拾い、
// まず周期(BPM)を、次にその周期をどこに置くか(位相)を決める。
// 解析は重いので、途中で制御を返して画面を固めない。

const BPM_MIN = 85                  // 倍テンポ・半テンポをこの範囲へ畳む
const BPM_MAX = 175
const HARMONICS = 4                 // 倍音をどこまで見るか
const PRIOR_CENTER = 128            // 倍と半分のどちらを採るかは、この値に近い方
const GRID = 0.25                   // 候補テンポの刻み
const SEARCH_MIN = 40               // 支配的な周期を探す範囲
const SEARCH_MAX = 300

const TARGET_RATE = 11025           // 解析用に落とすサンプリング周波数
const FFT_SIZE = 512
const HOP = 64                      // 1コマ約6ミリ秒
const WINDOW_SEC = 12               // 区間の長さ
const WINDOW_HOP_SEC = 6
const SMOOTH_SEC = 0.5              // 局所平均を取る幅
const YIELD_FRAMES = 4000           // これだけ進めたら一度制御を返す
const BEATS_PER_BAR = 4             // 小節線は4拍ごと。ダンスミュージック前提

// 拍の位置と速さ。時刻は曲の頭からの秒数で、再生速度の影響を受けない
export type BeatGrid = {
  bpm: number
  firstBeat: number   // 最初の拍
  firstBar: number    // 最初の小節頭。firstBeat から 0〜3拍ぶん後ろ
}

// 基数2のFFT。回転因子は使い回す
function makeFft(n: number) {
  const levels = Math.round(Math.log2(n))
  const cos = new Float32Array(n / 2)
  const sin = new Float32Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n)
    sin[i] = Math.sin((2 * Math.PI * i) / n)
  }
  const rev = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    let j = 0
    for (let b = 0; b < levels; b++) j = (j << 1) | ((i >> b) & 1)
    rev[i] = j
  }

  return (re: Float32Array, im: Float32Array) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr
        const ti = im[i]; im[i] = im[j]; im[j] = ti
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half
          const tre =  re[l] * cos[k] + im[l] * sin[k]
          const tim = -re[l] * sin[k] + im[l] * cos[k]
          re[l] = re[j] - tre; im[l] = im[j] - tim
          re[j] += tre;        im[j] += tim
        }
      }
    }
  }
}

// 全チャンネルを混ぜ、解析用の低い周波数へ落とす
function downmix(buffer: AudioBuffer): Float32Array {
  const step = Math.max(1, Math.round(buffer.sampleRate / TARGET_RATE))
  const len = Math.floor(buffer.length / step)
  const out = new Float32Array(len)
  const channels = Math.min(2, buffer.numberOfChannels)

  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < len; i++) out[i] += data[i * step] / channels
  }
  return out
}

// 各コマで音量が増えた分だけを足す。打楽器の立ち上がりが立つ
async function fluxEnvelope(signal: Float32Array): Promise<Float32Array> {
  const fft = makeFft(FFT_SIZE)
  const bins = FFT_SIZE / 2
  const frames = Math.floor((signal.length - FFT_SIZE) / HOP)
  if (frames < 64) return new Float32Array(0)

  const window = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE)
  }

  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)
  const prev = new Float32Array(bins)
  const flux = new Float32Array(frames)

  for (let f = 0; f < frames; f++) {
    const start = f * HOP
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = signal[start + i] * window[i]
      im[i] = 0
    }
    fft(re, im)

    let sum = 0
    for (let k = 1; k < bins; k++) {
      // 対数にしてから比べる。大きな音に引きずられにくい
      const mag = Math.log1p(Math.hypot(re[k], im[k]))
      const diff = mag - prev[k]
      if (diff > 0) sum += diff
      prev[k] = mag
    }
    flux[f] = sum

    if (f % YIELD_FRAMES === YIELD_FRAMES - 1) await new Promise(r => setTimeout(r, 0))
  }
  return flux
}

// 局所平均を引いて底を揃える
function rectify(flux: Float32Array, span: number): Float32Array {
  const out = new Float32Array(flux.length)
  let sum = 0
  for (let f = 0; f < flux.length; f++) {
    sum += flux[f]
    if (f >= span) sum -= flux[f - span]
    const mean = sum / Math.min(f + 1, span)
    out[f] = Math.max(0, flux[f] - mean)
  }
  return out
}

const lagAt = (bpm: number, secPerFrame: number) => 60 / (bpm * secPerFrame)

// onset の [from, to) を見て、lagごとの自己相関を返す。
// 区間の音量差が効かないよう、山の高さで割って揃える
function windowAc(onset: Float32Array, from: number, to: number, maxLag: number): Float32Array {
  const ac = new Float32Array(maxLag + 1)
  if (to - from < maxLag + 4) return ac

  let peak = 0
  for (let lag = 2; lag <= maxLag; lag++) {
    let sum = 0
    let n = 0
    for (let f = from + lag; f < to; f++) { sum += onset[f] * onset[f - lag]; n++ }
    ac[lag] = n ? sum / n : 0
    if (ac[lag] > peak) peak = ac[lag]
  }
  if (peak > 0) for (let lag = 2; lag <= maxLag; lag++) ac[lag] /= peak
  return ac
}

// 周期が分かったあと、それをどこに置けば立ち上がりに乗るかを探す。
// phase から period ごとに拾った値の合計が、いちばん大きい所を採る
function combScore(onset: Float32Array, phase: number, period: number): number {
  let sum = 0
  for (let t = phase; t < onset.length - 1; t += period) {
    const i = Math.floor(t)
    const frac = t - i
    sum += onset[i] * (1 - frac) + onset[i + 1] * frac
  }
  return sum
}

export async function analyzeBeats(buffer: AudioBuffer): Promise<BeatGrid | null> {
  const signal = downmix(buffer)
  const rate = buffer.sampleRate / Math.max(1, Math.round(buffer.sampleRate / TARGET_RATE))
  const flux = await fluxEnvelope(signal)
  if (!flux.length) return null
  // コマの中心が、その立ち上がりの起きた時刻
  const timeOf = (frame: number) => (frame * HOP + FFT_SIZE / 2) / rate

  const secPerFrame = HOP / rate
  const onset = rectify(flux, Math.round(SMOOTH_SEC / secPerFrame))
  const lagOf = (bpm: number) => lagAt(bpm, secPerFrame)

  const maxLag = Math.min(onset.length - 4, Math.ceil(lagOf(BPM_MIN) * HARMONICS))
  if (maxLag < 8) return null

  // 区間ごとの自己相関を足し合わせる。イントロや間奏に引きずられない
  const span = Math.round(WINDOW_SEC / secPerFrame)
  const hop  = Math.round(WINDOW_HOP_SEC / secPerFrame)
  const ac = new Float32Array(maxLag + 1)
  let windows = 0

  for (let from = 0; from + span <= onset.length; from += hop) {
    const part = windowAc(onset, from, from + span, maxLag)
    for (let lag = 2; lag <= maxLag; lag++) ac[lag] += part[lag]
    windows++
  }
  if (!windows) ac.set(windowAc(onset, 0, onset.length, maxLag))

  const at = (lag: number) => {
    if (lag < 2 || lag >= maxLag) return 0
    const base = Math.floor(lag)
    const frac = lag - base
    return ac[base] * (1 - frac) + ac[base + 1] * frac
  }
  // 本当の拍なら2倍3倍の位置にも山が立つ
  const comb = (bpm: number) => {
    const lag = lagOf(bpm)
    let sum = 0
    for (let h = 1; h <= HARMONICS; h++) sum += at(h * lag) / h
    return sum
  }

  // いちばん強い周期を1つ選ぶ
  let domLag = 0
  let domValue = 0
  const from = Math.max(2, Math.floor(lagOf(SEARCH_MAX)))
  const to   = Math.min(maxLag - 1, Math.ceil(lagOf(SEARCH_MIN)))
  for (let lag = from; lag <= to; lag++) {
    if (ac[lag] > domValue) { domValue = ac[lag]; domLag = lag }
  }
  if (!domLag) return null

  // 候補はその倍と半分だけ。1.5倍や3/4倍の誤りが入り込む余地を消す。
  // どの倍率を採るかは波形から決められないので、人が拍と感じる速さに近い方を選ぶ
  let bpm = 0
  let nearest = Infinity
  for (let k = -3; k <= 3; k++) {
    const cand = (60 / (domLag * secPerFrame)) * Math.pow(2, k)
    if (cand < BPM_MIN || cand > BPM_MAX) continue
    const distance = Math.abs(Math.log2(cand / PRIOR_CENTER))
    if (distance < nearest) { nearest = distance; bpm = cand }
  }
  if (!bpm) return null

  // 周辺を細かく詰める。倍率は決まったので相関だけで見る
  let fine = comb(bpm)
  for (let d = -GRID * 3; d <= GRID * 3; d += 0.01) {
    const cand = bpm + d
    if (cand < BPM_MIN || cand > BPM_MAX) continue
    const v = comb(cand)
    if (v > fine) { fine = v; bpm = cand }
  }
  bpm = Math.round(bpm * 10) / 10

  // ここから位相。1コマ刻みで1拍ぶんを総当たりする
  const beatLen = lagOf(bpm)
  let phase = 0
  let best = -Infinity
  for (let p = 0; p < beatLen; p++) {
    const v = combScore(onset, p, beatLen)
    if (v > best) { best = v; phase = p }
  }

  // 小節頭は、1拍目から4拍のうちどれか。4拍ごとに拾って強い所を選ぶ
  let bar = phase
  let barBest = -Infinity
  for (let k = 0; k < BEATS_PER_BAR; k++) {
    const p = phase + k * beatLen
    const v = combScore(onset, p, beatLen * BEATS_PER_BAR)
    if (v > barBest) { barBest = v; bar = p }
  }

  return { bpm, firstBeat: timeOf(phase), firstBar: timeOf(bar) }
}
