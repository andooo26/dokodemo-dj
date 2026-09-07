// controller から届く MIDI を検証する。
// 許可する番号は src/core/mapping.ts をそのまま参照する。

const {
  PAD_NOTES, KNOBS, TURNTABLE_STOP_NOTE, CUE_NOTE, PLAY_NOTE,
  PITCH_CC, PITCH_CC_LSB, DECK1, DECK2,
} = require('../src/core/mapping.ts')

const NOTE_OFF = 0x80
const NOTE_ON  = 0x90
const CC       = 0xb0
const BEND     = 0xe0

const CHANNELS = new Set([DECK1, DECK2])
const NOTES    = new Set([...PAD_NOTES, TURNTABLE_STOP_NOTE, CUE_NOTE, PLAY_NOTE])
const CCS      = new Set([...KNOBS.map(k => k.cc), PITCH_CC, PITCH_CC_LSB])

// 3バイトで、既知のチャンネルと番号のものだけ通す
function isAllowed(b) {
  if (!ArrayBuffer.isView(b) || b.length !== 3) return false
  if (b[1] > 0x7f || b[2] > 0x7f) return false
  if (!CHANNELS.has(b[0] & 0x0f)) return false

  switch (b[0] & 0xf0) {
    case NOTE_ON:
    case NOTE_OFF: return NOTES.has(b[1])
    case CC:       return CCS.has(b[1])
    case BEND:     return true   // ジョグは全域を使う
    default:       return false
  }
}

// トークンバケツ。ジョグは毎フレーム流れるので上限は高めに取る
const RATE_PER_SEC = 500
const BURST        = 1000

function createRateLimiter(perSec = RATE_PER_SEC, burst = BURST) {
  let tokens = burst
  let last = Date.now()

  return function allow() {
    const now = Date.now()
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSec)
    last = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

module.exports = { isAllowed, createRateLimiter, RATE_PER_SEC, BURST }
