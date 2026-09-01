// MIDIマッピングの唯一の定義。
// 各UIはここから番号と色を導出する。番号を変える場合はこのファイルだけを直す。

export const DECK1 = 0
export const DECK2 = 1

export const PADS = [
  { id: 'PAD1', note: 36, hex: '#dc2626', border: 'border-red-600',    activeBg: 'bg-red-600'    },
  { id: 'PAD2', note: 37, hex: '#22d3ee', border: 'border-cyan-400',   activeBg: 'bg-cyan-400'   },
  { id: 'PAD3', note: 38, hex: '#a3e635', border: 'border-lime-400',   activeBg: 'bg-lime-400'   },
  { id: 'PAD4', note: 39, hex: '#9333ea', border: 'border-purple-600', activeBg: 'bg-purple-600' },
] as const

export const KNOBS = [
  { id: 'HIGH',   cc: 10 },
  { id: 'MID',    cc: 11 },
  { id: 'LOW',    cc: 12 },
  { id: 'FILTER', cc: 13 },
] as const

export const TURNTABLE_STOP_NOTE = 46
export const CUE_NOTE            = 47
export const PLAY_NOTE           = 0
export const PITCH_CC            = 9

export const PAD_NOTES  = PADS.map(p => p.note)
export const KNOB_LABELS = KNOBS.map(k => k.id)

export function padByNote(note: number) {
  return PADS.find(p => p.note === note)
}
