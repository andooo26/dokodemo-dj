// デッキ1台分の読み出し。速度を負にもできるので、逆回転と擦りができる。
// 位置はここが正。メインスレッドへは間引いて知らせる。

const GLIDE_SEC = 0.006   // 速度を変えたときの追従。切り替えのクリックを消す
const REPORT_BLOCKS = 16  // 位置を知らせる間隔

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

    this.port.onmessage = ({ data }) => {
      if (data.type === 'load') {
        this.channels = data.channels
        this.length = data.length
        this.position = 0
        this.rate = 0
        this.target = 0
        this.playing = false
      }
      else if (data.type === 'play')  this.playing = true
      else if (data.type === 'pause') { this.playing = false; this.rate = 0 }
      else if (data.type === 'seek')  this.position = Math.max(0, Math.min(this.length - 1, data.position))
      else if (data.type === 'rate')  this.target = data.value
    }
  }

  report(ended) {
    this.port.postMessage({ position: this.position, playing: this.playing, ended: Boolean(ended) })
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

      const idx = Math.floor(this.position)
      const frac = this.position - idx
      if (idx < 0 || idx + 1 >= this.length) {
        left[i] = 0
        if (right) right[i] = 0
      } else {
        left[i] = a[idx] + (a[idx + 1] - a[idx]) * frac
        if (right) right[i] = b[idx] + (b[idx + 1] - b[idx]) * frac
      }
      this.position += this.rate
    }

    // 端に着いたら止める
    if (this.position >= this.length - 1) {
      this.position = this.length - 1
      this.playing = false
      this.report(true)
      return true
    }
    if (this.position < 0) {
      this.position = 0
      this.rate = 0
      this.target = 0
    }

    if (++this.blocks % REPORT_BLOCKS === 0) this.report(false)
    return true
  }
}

registerProcessor('deck', DeckProcessor)
