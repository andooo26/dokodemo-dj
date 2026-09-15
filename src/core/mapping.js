// MIDIマッピングの定義。番号を変える場合はここだけを直す。
// 画面(TS)とサーバ(CJS)の両方から読むので、素の JavaScript で書く。

const DECK1 = 0
const DECK2 = 1

const PADS = [
  { id: 'PAD1', note: 36, hex: '#dc2626', border: 'border-red-600',    activeBg: 'bg-red-600'    },
  { id: 'PAD2', note: 37, hex: '#22d3ee', border: 'border-cyan-400',   activeBg: 'bg-cyan-400'   },
  { id: 'PAD3', note: 38, hex: '#a3e635', border: 'border-lime-400',   activeBg: 'bg-lime-400'   },
  { id: 'PAD4', note: 39, hex: '#9333ea', border: 'border-purple-600', activeBg: 'bg-purple-600' },
]

const KNOBS = [
  { id: 'HIGH',   cc: 10 },
  { id: 'MID',    cc: 11 },
  { id: 'LOW',    cc: 12 },
  { id: 'FILTER', cc: 13 },
]

const TURNTABLE_STOP_NOTE = 46
const CUE_NOTE            = 47
const PLAY_NOTE           = 0
const SYNC_NOTE           = 48
const MASTER_NOTE         = 49

// TEMPOは14bit。ピッチベンドはジョグが使うのでCCペアで送る。
const PITCH_CC     = 9
const PITCH_CC_LSB = PITCH_CC + 32
const PITCH_MAX    = 16383
const PITCH_CENTER = 8192
const PITCH_DETENT = 516    // センターへの吸着幅

// 14bit値をMSBとLSBに分ける
function pitchToCC(value) {
  const v = Math.max(0, Math.min(PITCH_MAX, Math.round(value)))
  return { msb: (v >> 7) & 0x7f, lsb: v & 0x7f }
}

const PAD_NOTES   = PADS.map(p => p.note)
const KNOB_LABELS = KNOBS.map(k => k.id)

function padByNote(note) {
  return PADS.find(p => p.note === note)
}

module.exports = {
  DECK1, DECK2,
  PADS, KNOBS,
  TURNTABLE_STOP_NOTE, CUE_NOTE, PLAY_NOTE, SYNC_NOTE, MASTER_NOTE,
  PITCH_CC, PITCH_CC_LSB, PITCH_MAX, PITCH_CENTER, PITCH_DETENT,
  pitchToCC,
  PAD_NOTES, KNOB_LABELS,
  padByNote,
}
