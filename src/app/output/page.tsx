'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { CuePlayButton, PlayStopButton } from '@/components/ControlButtons'

import { encode, decode } from '@/core/codec'
import type { MidiMsg } from '@/core/codec'

import {
  PADS, PAD_NOTES, KNOB_LABELS as EQ_LABELS, padByNote,
  TURNTABLE_STOP_NOTE, CUE_NOTE as CUE_PLAY_NOTE, PLAY_NOTE as PLAY_STOP_NOTE,
  KNOBS, PITCH_CC, PITCH_CC_LSB, PITCH_MAX, PITCH_CENTER,
} from '@/core/mapping'

// --- Monitor ---

function PitchFaderMonitor({ value }: { value: number }) {
  const thumbPct = (1 - value / PITCH_MAX) * 100
  return (
    <div className="relative w-3 h-full">
      <div className="absolute left-1/2 -translate-x-1/2 inset-y-0 w-0.5 bg-gray-700 rounded-full" />
      <div className="absolute left-0 right-0 top-1/2 h-px bg-gray-500" />
      <div
        className="absolute left-0 right-0 h-3 bg-gray-400 rounded"
        style={{ top: `${thumbPct}%`, transform: 'translateY(-50%)' }}
      />
    </div>
  )
}

function KnobMonitor({ value, label }: { value: number; label: string }) {
  const angle = (value / 127) * 270 - 135
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-8 h-8 rounded-full bg-gray-800 border border-gray-700 relative">
        <div className="absolute inset-0" style={{ transform: `rotate(${angle}deg)` }}>
          <div className="absolute top-1 left-1/2 -translate-x-1/2 w-0.5 h-2 bg-gray-400 rounded-full" />
        </div>
      </div>
      <span className="text-xs text-gray-600 uppercase tracking-wider">{label}</span>
    </div>
  )
}

// --- TurntableMonitor ---

function TurntableMonitor({ angle, stopped }: { angle: number; stopped: boolean }) {
  return (
    <div className={`relative rounded-full w-3/4 mx-auto aspect-square border-4 transition-colors duration-75 shadow-lg
                     ${stopped ? 'border-gray-300 shadow-blue-500/20' : 'border-gray-600 shadow-gray-950'}`}
      style={{
        background: stopped
          ? 'radial-gradient(circle at 30% 30%, #4a5568, #1a202c)'
          : 'radial-gradient(circle at 30% 30%, #2d3748, #0d0d0d)'
      }}>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ transform: `rotate(${angle}deg)` }}
      >
        <div className={`absolute top-2 left-1/2 -translate-x-1/2 w-1.5 h-5 rounded-full shadow-md
          ${stopped ? 'bg-blue-300 shadow-blue-300/50' : 'bg-gray-300 shadow-gray-400/50'}`} />
      </div>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-6 h-6 rounded-full border-2 border-gray-400 bg-gradient-to-br from-gray-300 to-gray-500 shadow-md" />
        <div className="absolute w-3 h-3 rounded-full bg-white border border-gray-300" />
      </div>
      {stopped && (
        <div className="absolute inset-0 flex items-end justify-center pb-3 pointer-events-none">
          <span className="text-xs text-gray-300 font-bold tracking-widest">STOP</span>
        </div>
      )}
    </div>
  )
}

type MidiPortInfo = {
  name: string | null
  virtual: boolean
  ports: string[]
  error?: string
}

const VIRTUAL_PORT_VALUE = ''

export default function OutputPage() {
  const [midiPort, setMidiPort]         = useState<MidiPortInfo | null>(null)
  const [sockStatus, setSockStatus]     = useState<'disconnected' | 'connected'>('disconnected')
  const [controllers, setControllers]   = useState(0)
  const [log, setLog]                          = useState<string[]>([])
  const [activePadsDeck1, setActivePadsDeck1]  = useState<Set<number>>(new Set())
  const [activePadsDeck2, setActivePadsDeck2]  = useState<Set<number>>(new Set())
  const [angleDeck1, setAngleDeck1]            = useState(0)
  const [angleDeck2, setAngleDeck2]            = useState(0)
  const [stoppedDeck1, setStoppedDeck1]        = useState(false)
  const [stoppedDeck2, setStoppedDeck2]        = useState(false)
  const [cueDeck1, setCueDeck1]                = useState(false)
  const [cueDeck2, setCueDeck2]                = useState(false)
  const [playDeck1, setPlayDeck1]              = useState(false)
  const [playDeck2, setPlayDeck2]              = useState(false)
  const [pitchDeck1, setPitchDeck1]            = useState(PITCH_CENTER)
  const [pitchDeck2, setPitchDeck2]            = useState(PITCH_CENTER)
  const [eqDeck1, setEqDeck1]                  = useState([64, 64, 64, 64])
  const [eqDeck2, setEqDeck2]                  = useState([64, 64, 64, 64])

  // コールバックから最新値を参照する
  const pitchMsbRef = useRef<[number, number]>([PITCH_CENTER >> 7, PITCH_CENTER >> 7])
  const socketRef   = useRef<Socket | null>(null)

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false })
    setLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 40))
  }, [])

  // Socket.io
  useEffect(() => {
    const socket = io({
      query: { role: 'output' },
      transports: ['websocket'],
    })
    socketRef.current = socket

    socket.on('connect',    () => { setSockStatus('connected'); addLog('サーバーに接続しました') })
    socket.on('disconnect', () => { setSockStatus('disconnected'); setControllers(0); addLog('切断しました') })

    socket.on('midiport', (p: MidiPortInfo) => {
      setMidiPort(p)
      if (p.error) addLog(`MIDI 切り替え失敗: ${p.error}`)
      else addLog(p.name ? `MIDI 出力: ${p.name}` : 'MIDI ポートを開けませんでした')
    })

    // スマホ(controller)の接続数
    socket.on('controllers', (n: number) => {
      setControllers(n)
      addLog(n === 0 ? 'スマホが切断しました' : `スマホが接続しました (${n}台)`)
    })

    socket.on('midi', (raw: MidiMsg | ArrayBuffer | Uint8Array) => {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw) ? raw as Uint8Array : null
      const msg = bytes ? decode(bytes) : (raw as MidiMsg)
      if (!msg) return

      // パッドの点灯
      if (msg.type === 'note_on' && padByNote(msg.note)) {
        if (msg.channel === 0) setActivePadsDeck1(prev => new Set(prev).add(msg.note))
        else if (msg.channel === 1) setActivePadsDeck2(prev => new Set(prev).add(msg.note))
      } else if (msg.type === 'note_off' && padByNote(msg.note)) {
        if (msg.channel === 0) setActivePadsDeck1(prev => { const s = new Set(prev); s.delete(msg.note); return s })
        else if (msg.channel === 1) setActivePadsDeck2(prev => { const s = new Set(prev); s.delete(msg.note); return s })
      }

      // ターンテーブルの回転
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
      if (msg.type === 'note_on' && msg.note === CUE_PLAY_NOTE) {
        if (msg.channel === 0) setCueDeck1(true)
        else if (msg.channel === 1) setCueDeck2(true)
      }
      if (msg.type === 'note_off' && msg.note === CUE_PLAY_NOTE) {
        if (msg.channel === 0) setCueDeck1(false)
        else if (msg.channel === 1) setCueDeck2(false)
      }
      if (msg.type === 'note_on' && msg.note === PLAY_STOP_NOTE) {
        if (msg.channel === 0) setPlayDeck1(true)
        else if (msg.channel === 1) setPlayDeck2(true)
      }
      if (msg.type === 'note_off' && msg.note === PLAY_STOP_NOTE) {
        if (msg.channel === 0) setPlayDeck1(false)
        else if (msg.channel === 1) setPlayDeck2(false)
      }
      // TEMPO は MSB と LSB を合成する
      if (msg.type === 'cc' && (msg.controller === PITCH_CC || msg.controller === PITCH_CC_LSB)) {
        const deck = msg.channel === 1 ? 1 : 0
        if (msg.controller === PITCH_CC) pitchMsbRef.current[deck] = msg.value
        const lsb = msg.controller === PITCH_CC_LSB ? msg.value : 0
        const v   = Math.min(PITCH_MAX, (pitchMsbRef.current[deck] << 7) | lsb)
        if (deck === 0) setPitchDeck1(v)
        else setPitchDeck2(v)
      }
      const knobIdx = msg.type === 'cc' ? KNOBS.findIndex(k => k.cc === msg.controller) : -1
      if (msg.type === 'cc' && knobIdx >= 0) {
        const idx = knobIdx
        if (msg.channel === 0) setEqDeck1(prev => prev.map((v, i) => i === idx ? msg.value : v))
        else if (msg.channel === 1) setEqDeck2(prev => prev.map((v, i) => i === idx ? msg.value : v))
      }

      // MIDI送信はサーバ側。ここは表示のみ
      const outBytes = bytes ?? encode(msg)
      const hex = Array.from(outBytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
      addLog(`→ ${msg.type.padEnd(10)} [${hex}]`)
    })

    return () => { socket.disconnect(); socketRef.current = null }
  }, [])

  // プルダウンで選んだポートへ切り替える
  const changeMidiPort = (name: string) => socketRef.current?.emit('setmidiport', name)
  const refreshMidiPorts = () => socketRef.current?.emit('midiports')

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col font-sans overflow-hidden">

      {/* Header bar */}
      <header className="flex items-center gap-6 px-6 py-3 border-b border-gray-800 shrink-0">
        <h1 className="text-xl font-bold">どこでもDJ</h1>
        <span className="ml-auto text-xs text-gray-500 uppercase tracking-widest">Monitor</span>
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
              <div className="relative">
                <TurntableMonitor angle={angleDeck1} stopped={stoppedDeck1} />
                <div className="absolute right-0 top-0 bottom-0 py-1">
                  <PitchFaderMonitor value={pitchDeck1} />
                </div>
                <div className="absolute left-0 bottom-0 flex flex-col gap-2">
                  <CuePlayButton channel={0} active={cueDeck1} />
                  <PlayStopButton channel={0} active={playDeck1} />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {PAD_NOTES.map((note, i) => {
                  const { border, activeBg } = PADS[i]
                  return (
                    <div
                      key={note}
                      className={`rounded-2xl aspect-square flex items-center justify-center text-3xl font-bold
                                  border-2 transition-all duration-75 bg-black
                                  ${activePadsDeck1.has(note)
                                    ? `${activeBg} text-gray-950 scale-95`
                                    : `${border} text-gray-600`}`}
                    >
                    </div>
                  )
                })}
              </div>
              <div className="grid grid-cols-4 gap-1">
                {EQ_LABELS.map((label, i) => (
                  <KnobMonitor key={label} value={eqDeck1[i]} label={label} />
                ))}
              </div>
            </div>

            {/* DECK 2 — right */}
            <div className="flex flex-col gap-2 flex-1">
              <span className="text-xs text-gray-500 uppercase tracking-widest text-center">Deck 2</span>
              <div className="relative">
                <TurntableMonitor angle={angleDeck2} stopped={stoppedDeck2} />
                <div className="absolute right-0 top-0 bottom-0 py-1">
                  <PitchFaderMonitor value={pitchDeck2} />
                </div>
                <div className="absolute left-0 bottom-0 flex flex-col gap-2">
                  <CuePlayButton channel={1} active={cueDeck2} />
                  <PlayStopButton channel={1} active={playDeck2} />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {PAD_NOTES.map((note, i) => {
                  const { border, activeBg } = PADS[i]
                  return (
                    <div
                      key={note}
                      className={`rounded-2xl aspect-square flex items-center justify-center text-3xl font-bold
                                  border-2 transition-all duration-75 bg-black
                                  ${activePadsDeck2.has(note)
                                    ? `${activeBg} text-gray-950 scale-95`
                                    : `${border} text-gray-600`}`}
                    >
                    </div>
                  )
                })}
              </div>
              <div className="grid grid-cols-4 gap-1">
                {EQ_LABELS.map((label, i) => (
                  <KnobMonitor key={label} value={eqDeck2[i]} label={label} />
                ))}
              </div>
            </div>

          </div>

          {/* Status */}
          <div className="shrink-0 grid grid-cols-2 gap-6 bg-gray-900 rounded-2xl px-5 py-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-gray-400 uppercase tracking-widest">スマホ接続</span>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  sockStatus !== 'connected' ? 'bg-red-500'
                    : controllers > 0 ? 'bg-lime-400' : 'bg-yellow-400'}`} />
                <span className="text-sm">
                  {sockStatus !== 'connected' ? 'サーバー未接続'
                    : controllers > 0 ? `接続中 (${controllers}台)` : '未接続'}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <span className="text-xs text-gray-400 uppercase tracking-widest">MIDIポート</span>
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  midiPort?.name ? 'bg-lime-400' : midiPort ? 'bg-red-500' : 'bg-yellow-400'}`} />
                <select
                  className="min-w-0 flex-1 bg-gray-800 border border-gray-700 rounded-lg
                             px-2 py-1 text-sm text-white disabled:text-gray-500"
                  disabled={!midiPort}
                  value={midiPort?.virtual ? VIRTUAL_PORT_VALUE : midiPort?.name ?? VIRTUAL_PORT_VALUE}
                  title={midiPort?.name ?? ''}
                  onMouseDown={refreshMidiPorts}
                  onChange={e => changeMidiPort(e.target.value)}
                >
                  <option value={VIRTUAL_PORT_VALUE}>DokodemoDJ (仮想)</option>
                  {midiPort?.ports.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              {midiPort && !midiPort.name && (
                <span className="text-xs text-red-400">ポートを開けません</span>
              )}
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
