'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import Link from 'next/link'

// --- Types ---

type MidiMsg =
  | { type: 'note_on';    channel: number; note: number; velocity: number }
  | { type: 'note_off';   channel: number; note: number }
  | { type: 'cc';         channel: number; controller: number; value: number }
  | { type: 'pitch_bend'; channel: number; value: number }

// MIDI メッセージ → バイト列
function toBytes(msg: MidiMsg): number[] {
  const ch = (msg.channel ?? 0) & 0x0f
  if (msg.type === 'note_on')    return [0x90 | ch, msg.note & 0x7f, msg.velocity & 0x7f]
  if (msg.type === 'note_off')   return [0x80 | ch, msg.note & 0x7f, 0]
  if (msg.type === 'cc')         return [0xb0 | ch, msg.controller & 0x7f, msg.value & 0x7f]
  if (msg.type === 'pitch_bend') {
    const v = Math.max(0, Math.min(16383, msg.value))
    return [0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f]
  }
  return []
}

// --- Constants ---

const PAD_NOTES          = [36, 37, 38, 39]
const TURNTABLE_STOP_NOTE = 46

// --- TurntableMonitor ---

function TurntableMonitor({ angle, stopped }: { angle: number; stopped: boolean }) {
  return (
    <div className={`relative rounded-full w-3/4 mx-auto aspect-square border-4 transition-colors duration-75
                     ${stopped ? 'border-gray-400 bg-gray-700' : 'border-gray-700 bg-gray-800'}`}>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ transform: `rotate(${angle}deg)` }}
      >
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-1.5 h-6 bg-gray-400 rounded-full" />
      </div>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className={`w-8 h-8 rounded-full border-2 transition-colors
                         ${stopped ? 'bg-gray-300 border-gray-200' : 'bg-gray-600 border-gray-500'}`} />
      </div>
      {stopped && (
        <div className="absolute inset-0 flex items-end justify-center pb-3 pointer-events-none">
          <span className="text-xs text-gray-300 font-bold tracking-widest">STOP</span>
        </div>
      )}
    </div>
  )
}

export default function OutputPage() {
  const [midiPorts, setMidiPorts]       = useState<string[]>([])
  const [selectedPort, setSelectedPort] = useState('')
  const [midiStatus, setMidiStatus]     = useState('初期化中...')
  const [sockStatus, setSockStatus]     = useState<'disconnected' | 'connected'>('disconnected')
  const [log, setLog]                          = useState<string[]>([])
  const [activePadsDeck1, setActivePadsDeck1]  = useState<Set<number>>(new Set())
  const [activePadsDeck2, setActivePadsDeck2]  = useState<Set<number>>(new Set())
  const [angleDeck1, setAngleDeck1]            = useState(0)
  const [angleDeck2, setAngleDeck2]            = useState(0)
  const [stoppedDeck1, setStoppedDeck1]        = useState(false)
  const [stoppedDeck2, setStoppedDeck2]        = useState(false)

  // useRef で最新値をコールバック内から参照
  const outputsRef = useRef<Map<string, MIDIOutput>>(new Map())
  const selectedRef = useRef('')

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false })
    setLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 40))
  }, [])

  // --- Web MIDI API ---
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      setMidiStatus('Web MIDI API 非対応 — Chrome または Edge で開いてください')
      return
    }

    navigator.requestMIDIAccess({ sysex: false }).then(access => {
      const refresh = () => {
        outputsRef.current.clear()
        const names: string[] = []
        access.outputs.forEach((out: MIDIOutput) => {
          const name = out.name ?? out.id
          outputsRef.current.set(name, out)
          names.push(name)
        })
        setMidiPorts(names)
        setMidiStatus(`${names.length} ポート検出`)

        // 以前選択していたポートが消えた場合はリセット
        if (selectedRef.current !== '' && !names.includes(selectedRef.current)) {
          selectedRef.current = ''
          setSelectedPort('')
        }
      }

      refresh()
      access.onstatechange = refresh
    }).catch(e => {
      setMidiStatus(`MIDI アクセス失敗: ${e.message}`)
    })
  }, [])

  // --- Socket.io (same-origin — サーバーは server.js) ---
  useEffect(() => {
    const socket = io({
      query: { role: 'output' },
      transports: ['websocket'],
    })

    socket.on('connect',    () => { setSockStatus('connected'); addLog('サーバーに接続しました') })
    socket.on('disconnect', () => { setSockStatus('disconnected'); addLog('切断しました') })

    socket.on('midi', (msg: MidiMsg) => {
      // パッドの点灯状態を更新
      if (msg.type === 'note_on' && PAD_NOTES.includes(msg.note)) {
        if (msg.channel === 0) setActivePadsDeck1(prev => new Set(prev).add(msg.note))
        else if (msg.channel === 1) setActivePadsDeck2(prev => new Set(prev).add(msg.note))
      } else if (msg.type === 'note_off' && PAD_NOTES.includes(msg.note)) {
        if (msg.channel === 0) setActivePadsDeck1(prev => { const s = new Set(prev); s.delete(msg.note); return s })
        else if (msg.channel === 1) setActivePadsDeck2(prev => { const s = new Set(prev); s.delete(msg.note); return s })
      }

      // ターンテーブルの回転・停止状態を更新
      if (msg.type === 'pitch_bend' && msg.value !== 8192) {
        const delta = (msg.value - 8192) / 4096 * 90
        if (msg.channel === 0) setAngleDeck1(prev => prev + delta)
        else if (msg.channel === 1) setAngleDeck2(prev => prev + delta)
      }
      if (msg.type === 'note_on' && msg.note === TURNTABLE_STOP_NOTE) {
        if (msg.channel === 0) setStoppedDeck1(true)
        else if (msg.channel === 1) setStoppedDeck2(true)
      }
      if (msg.type === 'note_off' && msg.note === TURNTABLE_STOP_NOTE) {
        if (msg.channel === 0) setStoppedDeck1(false)
        else if (msg.channel === 1) setStoppedDeck2(false)
      }

      // MIDI 出力
      const out = outputsRef.current.get(selectedRef.current)
      if (!out) {
        addLog('MIDIポートを選択してください')
        return
      }
      const bytes = toBytes(msg)
      if (bytes.length) {
        out.send(bytes)
        const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')
        addLog(`→ ${msg.type.padEnd(10)} [${hex}]`)
      }
    })

    return () => { socket.disconnect() }
  }, [])

  const sockColor = sockStatus === 'connected' ? 'text-white' : 'text-gray-500'
  const midiColor = midiPorts.length > 0 ? 'text-white' : 'text-yellow-400'

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col font-sans overflow-hidden">

      {/* Header bar */}
      <header className="flex items-center gap-6 px-6 py-3 border-b border-gray-800 shrink-0">
        <h1 className="text-xl font-bold">どこでもDJ</h1>
        <span className={`text-sm ${sockColor}`}>
          ● {sockStatus === 'connected' ? 'スマホ接続中' : '未接続'}
        </span>
        <span className={`text-sm ${midiColor}`}>♪ {midiStatus}</span>
        <div className="ml-auto flex items-center gap-3">
          {midiPorts.length === 0 ? (
            <span className="text-sm text-yellow-400">MIDI デバイスなし</span>
          ) : (
            <select
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm
                         focus:outline-none focus:border-blue-500"
              value={selectedPort}
              onChange={e => {
                setSelectedPort(e.target.value)
                selectedRef.current = e.target.value
                addLog(`ポート変更: ${e.target.value || '(未選択)'}`)
              }}
            >
              <option value="">-- ポートを選択 --</option>
              {midiPorts.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
          <Link
            href="/"
            className="px-4 py-1.5 rounded-lg text-sm font-medium
                       bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors"
          >
            スマホ版
          </Link>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden p-6 gap-6">

        {/* Pad Monitor */}
        <section className="flex flex-col gap-3 w-1/2">
          <label className="text-xs text-gray-400 uppercase tracking-widest">Pad Monitor</label>
          <div className="flex gap-4 flex-1">

            {/* DECK 1 — left */}
            <div className="flex flex-col gap-2 flex-1">
              <span className="text-xs text-gray-500 uppercase tracking-widest text-center">Deck 1</span>
              <TurntableMonitor angle={angleDeck1} stopped={stoppedDeck1} />
              <div className="grid grid-cols-4 gap-3">
                {PAD_NOTES.map((note, i) => (
                  <div
                    key={note}
                    className={`rounded-2xl aspect-square flex items-center justify-center text-3xl font-bold
                                border-2 transition-all duration-75
                                ${activePadsDeck1.has(note)
                                  ? 'bg-white text-gray-950 border-white scale-95'
                                  : 'bg-gray-800 text-gray-600 border-gray-700'}`}
                  >
                    {i + 1}
                  </div>
                ))}
              </div>
            </div>

            {/* DECK 2 — right */}
            <div className="flex flex-col gap-2 flex-1">
              <span className="text-xs text-gray-500 uppercase tracking-widest text-center">Deck 2</span>
              <TurntableMonitor angle={angleDeck2} stopped={stoppedDeck2} />
              <div className="grid grid-cols-4 gap-3">
                {PAD_NOTES.map((note, i) => (
                  <div
                    key={note}
                    className={`rounded-2xl aspect-square flex items-center justify-center text-3xl font-bold
                                border-2 transition-all duration-75
                                ${activePadsDeck2.has(note)
                                  ? 'bg-white text-gray-950 border-white scale-95'
                                  : 'bg-gray-800 text-gray-600 border-gray-700'}`}
                  >
                    {i + 1}
                  </div>
                ))}
              </div>
            </div>

          </div>
        </section>

        {/* Log */}
        <section className="flex flex-col gap-3 flex-1">
          <label className="text-xs text-gray-400 uppercase tracking-widest">MIDI LOG</label>
          <div className="flex-1 bg-gray-900 rounded-2xl p-4 overflow-y-auto font-mono text-xs space-y-0.5">
            {log.length === 0
              ? <p className="text-gray-600">スマホから操作するとここにログが流れます</p>
              : log.map((l, i) => <p key={i} className="text-white leading-5">{l}</p>)}
          </div>
        </section>

      </div>
    </div>
  )
}
