// MidiMsg をDJエンジンの操作へ翻訳する。番号の意味は mapping.js に従う。

import type { MidiMsg } from '@/core/codec'
import type { DjEngine, DeckIndex } from '@/core/audio'
import {
  KNOBS, PAD_NOTES, TURNTABLE_STOP_NOTE, CUE_NOTE, PLAY_NOTE,
  PITCH_CC, PITCH_CC_LSB, PITCH_CENTER,
} from '@/core/mapping'

const JOG_SCALE = 4096   // touch画面が90度の回転で振る幅

export function createMidiHandler(engine: DjEngine) {
  // TEMPO は MSB と LSB に分かれて届く
  const msb: number[] = [PITCH_CENTER >> 7, PITCH_CENTER >> 7]

  return function handle(msg: MidiMsg) {
    const deck: DeckIndex = msg.channel === 1 ? 1 : 0

    if (msg.type === 'note_on' || msg.type === 'note_off') {
      const down = msg.type === 'note_on'
      const pad = PAD_NOTES.indexOf(msg.note)
      if (pad >= 0)                              engine.hotCue(deck, pad, down)
      else if (msg.note === TURNTABLE_STOP_NOTE) engine.touch(deck, down)
      else if (msg.note === CUE_NOTE)            { if (down) engine.cuePress(deck); else engine.cueRelease(deck) }
      else if (msg.note === PLAY_NOTE && down)   engine.toggle(deck)
      return
    }

    if (msg.type === 'pitch_bend') {
      engine.jog(deck, (msg.value - PITCH_CENTER) / JOG_SCALE)
      return
    }

    if (msg.type === 'cc') {
      if (msg.controller === PITCH_CC || msg.controller === PITCH_CC_LSB) {
        if (msg.controller === PITCH_CC) msb[deck] = msg.value
        const lsb = msg.controller === PITCH_CC_LSB ? msg.value : 0
        engine.setTempo(deck, (msb[deck] << 7) | lsb)
        return
      }
      const knob = KNOBS.findIndex(k => k.cc === msg.controller)
      if (knob === 0) engine.setEq(deck, 'high', msg.value)
      if (knob === 1) engine.setEq(deck, 'mid', msg.value)
      if (knob === 2) engine.setEq(deck, 'low', msg.value)
      if (knob === 3) engine.setFilter(deck, msg.value)
    }
  }
}
