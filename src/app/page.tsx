'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import Link from 'next/link'

// --- Types ---

type MidiMsg =
  | { type: 'note_on';    channel: number; note: number; velocity: number }
  | { type: 'note_off';   channel: number; note: number }
  | { type: 'cc';         channel: number; controller: number; value: number }
  | { type: 'pitch_bend'; channel: number; value: number }

type Status = 'disconnected' | 'connecting' | 'connected'

// --- Constants ---

const TURNTABLE_STOP_NOTE = 46

const PADS = [
  { note: 36, label: '1' },
  { note: 37, label: '2' },
  { note: 38, label: '3' },
  { note: 39, label: '4' },
]

// --- Hook ---

function useMidiBridge() {
  const [status, setStatus] = useState<Status>('disconnected')
  const [log, setLog]       = useState<string[]>([])
  const socketRef           = useRef<Socket | null>(null)

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false })
    setLog((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 30))
  }, [])

  const connect = useCallback(() => {
    socketRef.current?.disconnect()
    setStatus('connecting')
    const s = io({ query: { role: 'controller' }, transports: ['websocket'], timeout: 5000 })
    s.on('connect',       () => { setStatus('connected');    addLog('接続しました') })
    s.on('disconnect',    () => { setStatus('disconnected'); addLog('切断しました') })
    s.on('connect_error', (e) => { setStatus('disconnected'); addLog(`エラー: ${e.message}`) })
    socketRef.current = s
  }, [addLog])

  const send = useCallback((msg: MidiMsg) => {
    if (!socketRef.current?.connected) {
      if      (msg.type === 'note_on')    addLog(`サーバに接続してください: note_on ${msg.note} ${msg.velocity}`)
      else if (msg.type === 'note_off')   addLog(`サーバに接続してください: note_off ${msg.note}`)
      else if (msg.type === 'cc')         addLog(`サーバに接続してください: cc ${msg.controller} ${msg.value}`)
      else if (msg.type === 'pitch_bend') addLog(`サーバに接続してください: pitch_bend ${msg.value}`)
      return
    }
    socketRef.current.emit('midi', msg)
    if      (msg.type === 'note_on')  addLog(`Note On  ${msg.note}`)
    else if (msg.type === 'note_off') addLog(`Note Off ${msg.note}`)
    else if (msg.type === 'cc')       addLog(`CC ${msg.controller}  ${msg.value}`)
    // pitch_bend は頻繁すぎるのでログしない
  }, [addLog])

  useEffect(() => () => { socketRef.current?.disconnect() }, [])

  return { status, log, connect, send }
}

// --- Components ---

function Turntable({ channel, send }: {
  channel: number
  send: (msg: MidiMsg) => void
}) {
  const [angle, setAngle]   = useState(0)
  const [pressed, setPressed] = useState(false)
  const centerRef   = useRef<{ x: number; y: number } | null>(null)
  const lastAngleRef = useRef<number | null>(null)
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const getAngle = (x: number, y: number) => {
    if (!centerRef.current) return 0
    return Math.atan2(y - centerRef.current.y, x - centerRef.current.x) * (180 / Math.PI)
  }

  const release = () => {
    setPressed(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    send({ type: 'note_off',   channel, note: TURNTABLE_STOP_NOTE })
    send({ type: 'pitch_bend', channel, value: 8192 })
  }

  return (
    <div
      className={`relative rounded-full w-full aspect-square select-none touch-none
                  border-4 transition-colors duration-75
                  ${pressed ? 'border-gray-400 bg-gray-700' : 'border-gray-700 bg-gray-800'}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        const rect = e.currentTarget.getBoundingClientRect()
        centerRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        lastAngleRef.current = getAngle(e.clientX, e.clientY)
        setPressed(true)
        send({ type: 'note_on', channel, note: TURNTABLE_STOP_NOTE, velocity: 127 })
      }}
      onPointerMove={(e) => {
        if (!pressed || lastAngleRef.current === null) return
        const cur = getAngle(e.clientX, e.clientY)
        let delta = cur - lastAngleRef.current
        if (delta >  180) delta -= 360
        if (delta < -180) delta += 360
        lastAngleRef.current = cur
        if (Math.abs(delta) < 0.1) return

        setAngle(prev => prev + delta)

        const bend = Math.max(0, Math.min(16383, Math.round(8192 + (delta / 90) * 4096)))
        send({ type: 'pitch_bend', channel, value: bend })

        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          send({ type: 'pitch_bend', channel, value: 8192 })
        }, 80)
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {/* 回転マーカー */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ transform: `rotate(${angle}deg)` }}
      >
        <div className="absolute top-4 left-1/2 -translate-x-1/2 w-2 h-10 bg-gray-400 rounded-full" />
      </div>
      {/* 中央ハブ */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className={`w-14 h-14 rounded-full border-2 transition-colors
                         ${pressed ? 'bg-gray-300 border-gray-200' : 'bg-gray-600 border-gray-500'}`} />
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: Status }) {
  const cls: Record<Status, string> = {
    connected:    'bg-gray-300',
    connecting:   'bg-gray-400 animate-pulse',
    disconnected: 'bg-gray-600',
  }
  return <span className={`inline-block w-2 h-2 rounded-full ${cls[status]}`} />
}

function Pad({ note, label, onNoteOn, onNoteOff }: {
  note: number; label: string
  onNoteOn: (n: number) => void
  onNoteOff: (n: number) => void
}) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      className={`rounded-2xl aspect-square text-gray-200 font-semibold text-2xl select-none touch-none
                  transition-all duration-75 border border-gray-700
                  ${pressed ? 'bg-gray-400 scale-95' : 'bg-gray-800'}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setPressed(true)
        onNoteOn(note)
      }}
      onPointerUp={() => { setPressed(false); onNoteOff(note) }}
      onPointerCancel={() => { setPressed(false); onNoteOff(note) }}
    >
      {label}
    </button>
  )
}

function CueButton({ note, channel, label, active, onNoteOn, onNoteOff }: {
  note: number; channel: number; label: string; active: boolean
  onNoteOn: (n: number, ch: number) => void
  onNoteOff: (n: number, ch: number) => void
}) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      className={`rounded-2xl h-20 text-gray-200 font-semibold text-lg select-none touch-none
                  transition-all duration-75 border
                  ${pressed
                    ? 'bg-yellow-300 border-yellow-200 scale-95'
                    : active
                      ? 'bg-yellow-600 border-yellow-500'
                      : 'bg-yellow-950 border-yellow-900'}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setPressed(true)
        onNoteOn(note, channel)
      }}
      onPointerUp={() => { setPressed(false); onNoteOff(note, channel) }}
      onPointerCancel={() => { setPressed(false); onNoteOff(note, channel) }}
    >
      {label}
    </button>
  )
}

// --- Page ---

export default function Controller() {
  const [mounted, setMounted] = useState(false)
  const [activeDeck, setActiveDeck] = useState(0)
  const { status, log, connect, send } = useMidiBridge()

  useEffect(() => { setMounted(true) }, [])

  return (
    <main className="min-h-screen bg-gray-950 text-white px-4 py-6 max-w-md mx-auto flex flex-col gap-6">

      {/* Header */}
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-bold">どこでもDJ</h1>
        <StatusDot status={status} />
        <span className="text-sm text-gray-400">{status}</span>
        <div className="ml-auto flex gap-2">
          <Link
            href="/output"
            className="min-h-[44px] px-4 rounded-xl text-sm font-medium touch-manipulation
                       bg-gray-800 active:bg-gray-600 border border-gray-700 transition-colors
                       flex items-center"
          >
            PC画面
          </Link>
          <button
            disabled={!mounted || status === 'connecting'}
            onClick={() => connect()}
            className="min-h-[44px] px-5 rounded-xl text-sm font-medium touch-manipulation
                       bg-gray-800 active:bg-gray-600 border border-gray-700
                       disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            {!mounted ? '...' : status === 'connected' ? '再接続' : '接続'}
          </button>
        </div>
      </div>

      {/* Turntable */}
      <div className="w-3/5 mx-auto">
        <Turntable channel={activeDeck} send={send} />
      </div>

      {/* Pads */}
      <div className="grid grid-cols-4 gap-3">
        {PADS.map(({ note, label }) => (
          <Pad
            key={note}
            note={note}
            label={label}
            onNoteOn={(n) => send({ type: 'note_on',  channel: activeDeck, note: n, velocity: 127 })}
            onNoteOff={(n) => send({ type: 'note_off', channel: activeDeck, note: n })}
          />
        ))}
      </div>

      {/* CUE */}
      <div className="grid grid-cols-2 gap-3">
          <CueButton
            note={48} channel={0} label="DECK 1" active={activeDeck === 0}
            onNoteOn={(n, ch) => { setActiveDeck(0); send({ type: 'note_on',  channel: ch, note: n, velocity: 127 }) }}
            onNoteOff={(n, ch) => send({ type: 'note_off', channel: ch, note: n })}
          />
          <CueButton
            note={48} channel={1} label="DECK 2" active={activeDeck === 1}
            onNoteOn={(n, ch) => { setActiveDeck(1); send({ type: 'note_on',  channel: ch, note: n, velocity: 127 }) }}
            onNoteOff={(n, ch) => send({ type: 'note_off', channel: ch, note: n })}
          />
      </div>

      {/* Log */}
      <div className="flex-1 bg-gray-900 rounded-2xl p-3 overflow-y-auto font-mono text-xs space-y-0.5 min-h-[160px]">
        {log.length === 0
          ? <p className="text-gray-600">-log-</p>
          : log.map((l, i) => <p key={i} className="text-gray-400 leading-5">{l}</p>)}
      </div>

    </main>
  )
}
