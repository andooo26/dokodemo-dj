// MidiMsg と MIDI バイト列の相互変換。

export type MidiMsg =
  | { type: 'note_on';    channel: number; note: number; velocity: number }
  | { type: 'note_off';   channel: number; note: number }
  | { type: 'cc';         channel: number; controller: number; value: number }
  | { type: 'pitch_bend'; channel: number; value: number }

export const NOTE_OFF = 0x80
export const NOTE_ON  = 0x90
export const CC       = 0xb0
export const BEND     = 0xe0

export function encode(msg: MidiMsg): Uint8Array {
  const ch = (msg.channel ?? 0) & 0x0f
  switch (msg.type) {
    case 'note_on':  return Uint8Array.from([NOTE_ON  | ch, msg.note & 0x7f, msg.velocity & 0x7f])
    case 'note_off': return Uint8Array.from([NOTE_OFF | ch, msg.note & 0x7f, 0])
    case 'cc':       return Uint8Array.from([CC       | ch, msg.controller & 0x7f, msg.value & 0x7f])
    case 'pitch_bend': {
      const v = Math.max(0, Math.min(16383, msg.value))
      return Uint8Array.from([BEND | ch, v & 0x7f, (v >> 7) & 0x7f])
    }
  }
}

export function decode(bytes: ArrayLike<number>): MidiMsg | null {
  if (bytes.length < 3) return null
  const status = bytes[0] & 0xf0
  const channel = bytes[0] & 0x0f
  switch (status) {
    case NOTE_ON:  return { type: 'note_on',  channel, note: bytes[1], velocity: bytes[2] }
    case NOTE_OFF: return { type: 'note_off', channel, note: bytes[1] }
    case CC:       return { type: 'cc',       channel, controller: bytes[1], value: bytes[2] }
    case BEND:     return { type: 'pitch_bend', channel, value: (bytes[2] << 7) | bytes[1] }
    default:       return null
  }
}

// 同じ値の連続送信を弾くためのキー。ノートは対象外。
export function dedupKey(msg: MidiMsg): string | null {
  if (msg.type === 'cc')         return `c${msg.channel}:${msg.controller}`
  if (msg.type === 'pitch_bend') return `b${msg.channel}`
  return null
}

export function valueOf(msg: MidiMsg): number {
  return msg.type === 'note_on' ? msg.velocity
    : msg.type === 'note_off' ? 0
    : msg.value
}
