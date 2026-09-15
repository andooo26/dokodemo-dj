// デッキ1台分の読み出し。速度を負にもできるので、逆回転と擦りができる。
// 位置はここが正。メインスレッドへは間引いて知らせる。

const GLIDE_SEC = 0.006   // 速度を変えたときの追従。切り替えのクリックを消す
const REPORT_BLOCKS = 16  // 位置を知らせる間隔

// キーロック（テンポを変えてもピッチを保つ）用。粒を重ねて貼り直す
const HOP_SEC = 0.04        // 貼り直す間隔。短いと籠もり、長いと山彦になる
const SEARCH = 256          // 継ぎ目を探す幅。±この範囲で波形が合う所を選ぶ
const MATCH = 128           // 波形の合い具合を測る長さ
const KEYLOCK_MIN = 0.05    // この範囲の速度でだけ働かせる。擦っている間は素通し
const KEYLOCK_MAX = 4
const KEYLOCK_DEAD = 0.001  // 等速とみなす幅

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = []
    this.length = 0
    this.position = 0
    this.rate = 0
    this.target = 0
    this.playing = false
    this.blocks = 0
    this.glide = 1 - Math.exp(-1 / (GLIDE_SEC * sampleRate))

    this.keylock = false
    this.hop = Math.round(HOP_SEC * sampleRate)
    this.grainOut = 0    // 消えていく粒の読み位置
    this.grainIn = 0     // 現れる粒の読み位置
    this.age = 0         // 今の粒に入ってからの経過サンプル
    this.stitching = false

    this.port.onmessage = ({ data }) => {
      if (data.type === 'load') {
        this.channels = data.channels
        this.length = data.length
        this.position = 0
        this.rate = 0
        this.target = 0
        this.playing = false
        this.stitching = false
      }
      else if (data.type === 'play')  this.playing = true
      else if (data.type === 'pause') { this.playing = false; this.rate = 0; this.stitching = false }
      else if (data.type === 'seek')  { this.position = Math.max(0, Math.min(this.length - 1, data.position)); this.stitching = false }
      else if (data.type === 'rate')  this.target = data.value
      else if (data.type === 'keylock') { this.keylock = Boolean(data.value); this.stitching = false }
    }
  }

  report(ended) {
    this.port.postMessage({ position: this.position, playing: this.playing, ended: Boolean(ended) })
  }

  // 補間して1サンプル読む。端の外は無音
  sample(ch, at) {
    const idx = Math.floor(at)
    if (idx < 0 || idx + 1 >= this.length) return 0
    return ch[idx] + (ch[idx + 1] - ch[idx]) * (at - idx)
  }

  // 消えていく粒の続きと一番よく似ている所を、狙った位置の近くから探す。
  // ここを合わせないと継ぎ目で位相が喧嘩して山彦になる
  alignment(anchor) {
    const ch = this.channels[0]
    const from = Math.floor(this.grainOut)
    if (from < 0 || from + MATCH >= this.length) return anchor

    let bestLag = 0
    let best = -Infinity
    for (let lag = -SEARCH; lag <= SEARCH; lag++) {
      const at = Math.floor(anchor) + lag
      if (at < 0 || at + MATCH >= this.length) continue
      let sum = 0
      for (let k = 0; k < MATCH; k++) sum += ch[from + k] * ch[at + k]
      if (sum > best) { best = sum; bestLag = lag }
    }
    return anchor + bestLag
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out.length > 1 ? out[1] : null

    if (!this.channels.length || !this.playing) {
      this.rate += (0 - this.rate) * this.glide
      return true
    }

    const a = this.channels[0]
    const b = this.channels[1] ?? a

    for (let i = 0; i < left.length; i++) {
      this.rate += (this.target - this.rate) * this.glide

      // 貼り直しが効くのは、前向きに、ほどほどの速さで回っているときだけ
      const stretch = this.keylock
        && this.rate > KEYLOCK_MIN && this.rate < KEYLOCK_MAX
        && Math.abs(this.rate - 1) > KEYLOCK_DEAD

      if (stretch) {
        if (!this.stitching) {
          this.grainOut = this.position
          this.grainIn = this.position
          this.age = 0
          this.stitching = true
        }
        if (this.age >= this.hop) {
          this.grainOut = this.grainIn
          this.grainIn = this.alignment(this.position)
          this.age = 0
        }

        // 粒どうしを三角の重みで渡す。重みの和は常に1
        const w = this.age / this.hop
        left[i] = this.sample(a, this.grainOut) * (1 - w) + this.sample(a, this.grainIn) * w
        if (right) right[i] = this.sample(b, this.grainOut) * (1 - w) + this.sample(b, this.grainIn) * w

        // 粒は等速で読む。だからピッチが変わらない
        this.grainOut++
        this.grainIn++
        this.age++
      } else {
        this.stitching = false
        left[i] = this.sample(a, this.position)
        if (right) right[i] = this.sample(b, this.position)
      }

      this.position += this.rate
    }

    // 端に着いたら止める
    if (this.position >= this.length - 1) {
      this.position = this.length - 1
      this.playing = false
      this.stitching = false
      this.report(true)
      return true
    }
    if (this.position < 0) {
      this.position = 0
      this.rate = 0
      this.target = 0
      this.stitching = false
    }

    if (++this.blocks % REPORT_BLOCKS === 0) this.report(false)
    return true
  }
}

registerProcessor('deck', DeckProcessor)
