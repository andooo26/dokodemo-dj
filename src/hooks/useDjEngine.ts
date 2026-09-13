// ブラウザ内のDJエンジンを画面に繋ぐ。MidiMsg を渡せばそのまま鳴る。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createDjEngine } from '@/core/audio'
import { createMidiHandler } from '@/core/djmidi'
import type { DeckIndex, DeckState, DjEngine } from '@/core/audio'
import type { MidiMsg } from '@/core/codec'

const empty = (): DeckState => ({
  name: null, duration: 0, playing: false, cue: 0, loading: false,
  cues: [null, null, null, null],
})
const EMPTY: DeckState[] = [empty(), empty()]

export function useDjEngine() {
  const [decks, setDecks] = useState<DeckState[]>(EMPTY)
  const engineRef  = useRef<DjEngine | null>(null)
  const handlerRef = useRef<((msg: MidiMsg) => void) | null>(null)

  // AudioContext はブラウザ側でしか作れない
  useEffect(() => {
    const engine = createDjEngine(setDecks)
    engineRef.current  = engine
    handlerRef.current = createMidiHandler(engine)
    return () => {
      engineRef.current = null
      handlerRef.current = null
      engine.dispose()
    }
  }, [])

  const handle = useCallback((msg: MidiMsg) => handlerRef.current?.(msg), [])

  // iOS は操作を挟むまで音が出ない
  const load = useCallback(async (deck: DeckIndex, file: File) => {
    await engineRef.current?.resume()
    await engineRef.current?.load(deck, file)
  }, [])

  const resume   = useCallback(() => engineRef.current?.resume(), [])
  const position = useCallback((deck: DeckIndex) => engineRef.current?.position(deck) ?? 0, [])
  const seek     = useCallback((deck: DeckIndex, to: number) => engineRef.current?.seek(deck, to), [])

  return { decks, handle, load, seek, position, resume }
}
