'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import Link from 'next/link'

// --- Types ---

type MidiMsg =
  | { type: 'note_on';  channel: number; note: number; velocity: number }
  | { type: 'note_off'; channel: number; note: number }
  | { type: 'cc';       channel: number; controller: number; value: number }

type Status = 'disconnected' | 'connecting' | 'connected'

// --- Constants ---

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
      if      (msg.type === 'note_on')  addLog(`サーバに接続してください: note_on ${msg.note} ${msg.velocity}`)
      else if (msg.type === 'note_off') addLog(`サーバに接続してください: note_off ${msg.note}`)
      else if (msg.type === 'cc')       addLog(`サーバに接続してください: cc ${msg.controller} ${msg.value}`)
      return
    }
    socketRef.current.emit('midi', msg)
    if      (msg.type === 'note_on')  addLog(`Note On  ${msg.note}`)
    else if (msg.type === 'note_off') addLog(`Note Off ${msg.note}`)
    else if (msg.type === 'cc')       addLog(`CC ${msg.controller}  ${msg.value}`)
  }, [addLog])

  useEffect(() => () => { socketRef.current?.disconnect() }, [])

  return { status, log, connect, send }
}

// --- Components ---

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
      className={`rounded-2xl h-28 text-gray-200 font-semibold text-2xl select-none touch-none
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

// --- Page ---

export default function Controller() {
  const [mounted, setMounted] = useState(false)
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

      {/* Pads */}
      <div className="grid grid-cols-2 gap-3">
        {PADS.map(({ note, label }) => (
          <Pad
            key={note}
            note={note}
            label={label}
            onNoteOn={(n) => send({ type: 'note_on',  channel: 0, note: n, velocity: 127 })}
            onNoteOff={(n) => send({ type: 'note_off', channel: 0, note: n })}
          />
        ))}
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
