'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useMidiBridge } from '@/hooks/useMidiBridge'
import type { MidiMsg, Status } from '@/hooks/useMidiBridge'
import { LinkButton, ConnectButton } from '@/components/HeaderButton'
import {
  PADS, KNOBS, TURNTABLE_STOP_NOTE, CUE_NOTE, PLAY_NOTE,
  PITCH_CC, PITCH_CC_LSB, PITCH_MAX, PITCH_CENTER, PITCH_DETENT, pitchToCC,
} from '@/core/mapping'

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
                  border-4 transition-colors duration-75 shadow-2xl
                  ${pressed ? 'border-gray-300 shadow-blue-500/30' : 'border-gray-600 shadow-gray-950'}`}
      style={{
        background: pressed
          ? 'radial-gradient(circle at 30% 30%, #4a5568, #1a202c)'
          : 'radial-gradient(circle at 30% 30%, #2d3748, #0d0d0d)'
      }}
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
        <div className={`absolute top-3 left-1/2 -translate-x-1/2 w-2.5 h-12 rounded-full shadow-lg
          ${pressed ? 'bg-blue-400 shadow-blue-400/50' : 'bg-gray-300 shadow-gray-400/50'}`} />
      </div>
      {/* 中央ハブ */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-16 h-16 rounded-full border-3 border-gray-400 bg-gradient-to-br from-gray-300 to-gray-500 shadow-lg" />
        <div className="absolute w-8 h-8 rounded-full bg-white border-2 border-gray-300" />
      </div>
    </div>
  )
}

function Knob({ label, cc, channel, send, value, onValueChange }: {
  label: string; cc: number; channel: number; send: (msg: MidiMsg) => void
  value: number; onValueChange: (v: number) => void
}) {
  const dragRef    = useRef<{ y: number; startValue: number } | null>(null)
  const lastTapRef = useRef<number>(0)
  const angle      = (value / 127) * 270 - 135

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className="w-14 h-14 rounded-full bg-gray-800 border border-gray-700 relative select-none touch-none cursor-pointer"
        onPointerDown={(e) => {
          const now = Date.now()
          if (now - lastTapRef.current < 300) {
            lastTapRef.current = 0
            onValueChange(64)
            send({ type: 'cc', channel, controller: cc, value: 64 })
            return
          }
          lastTapRef.current = now
          e.currentTarget.setPointerCapture(e.pointerId)
          dragRef.current = { y: e.clientY, startValue: value }
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return
          const delta = dragRef.current.y - e.clientY
          let v = Math.max(0, Math.min(127, Math.round(dragRef.current.startValue + delta * 0.5)))
          if (Math.abs(v - 64) <= 4) v = 64
          onValueChange(v)
          send({ type: 'cc', channel, controller: cc, value: v })
        }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-1 h-3 bg-gray-400 rounded-full" />
        </div>
      </div>
      <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
    </div>
  )
}

function PitchFader({ channel, send, value, onValueChange }: {
  channel: number
  send: (msg: MidiMsg) => void
  value: number; onValueChange: (v: number) => void
}) {
  const trackRef   = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const updateFromPointer = (e: React.PointerEvent) => {
    if (!trackRef.current) return
    const rect  = trackRef.current.getBoundingClientRect()
    const ratio = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    let v       = Math.round(ratio * PITCH_MAX)
    if (Math.abs(v - PITCH_CENTER) <= PITCH_DETENT) v = PITCH_CENTER
    onValueChange(v)
    // MSB → LSB の順で送る
    const { msb, lsb } = pitchToCC(v)
    send({ type: 'cc', channel, controller: PITCH_CC,     value: msb })
    send({ type: 'cc', channel, controller: PITCH_CC_LSB, value: lsb })
  }

  const thumbPct = (1 - value / PITCH_MAX) * 100

  return (
    <div ref={trackRef} className="relative w-5 h-full select-none touch-none cursor-pointer"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        draggingRef.current = true
        updateFromPointer(e)
      }}
      onPointerMove={(e) => { if (draggingRef.current) updateFromPointer(e) }}
      onPointerUp={() => { draggingRef.current = false }}
      onPointerCancel={() => { draggingRef.current = false }}
    >
      {/* トラック */}
      <div className="absolute left-1/2 -translate-x-1/2 inset-y-0 w-1 bg-gray-700 rounded-full" />
      {/* センターマーク */}
      <div className="absolute left-0 right-0 top-1/2 h-px bg-gray-500" />
      {/* サム */}
      <div
        className="absolute left-0 right-0 h-5 bg-gray-400 rounded border border-gray-300 transition-none"
        style={{ top: `${thumbPct}%`, transform: 'translateY(-50%)' }}
      />
    </div>
  )
}

function CuePlayButton({ channel, send }: {
  channel: number; send: (msg: MidiMsg) => void
}) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      className={`w-12 h-12 rounded-full text-xs font-semibold select-none touch-none border border-gray-700
                  transition-all duration-75
                  ${pressed ? 'bg-gray-400 scale-95 text-gray-950' : 'bg-gray-800 text-gray-200'}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setPressed(true)
        send({ type: 'note_on', channel, note: CUE_NOTE, velocity: 127 })
      }}
      onPointerUp={() => { setPressed(false); send({ type: 'note_off', channel, note: CUE_NOTE }) }}
      onPointerCancel={() => { setPressed(false); send({ type: 'note_off', channel, note: CUE_NOTE }) }}
    >
      CUE
    </button>
  )
}

function PlayStopButton({ channel, send }: {
  channel: number; send: (msg: MidiMsg) => void
}) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      className={`w-12 h-12 rounded-full text-sm font-semibold select-none touch-none border border-gray-700
                  transition-all duration-75
                  ${pressed ? 'bg-gray-400 scale-95 text-gray-950' : 'bg-gray-800 text-gray-200'}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setPressed(true)
        send({ type: 'note_on', channel, note: PLAY_NOTE, velocity: 127 })
      }}
      onPointerUp={() => { setPressed(false); send({ type: 'note_off', channel, note: PLAY_NOTE }) }}
      onPointerCancel={() => { setPressed(false); send({ type: 'note_off', channel, note: PLAY_NOTE }) }}
    >
      ▷/‖
    </button>
  )
}

function Pad({ note, label, border, activeBg, onNoteOn, onNoteOff }: {
  note: number; label: string; border: string; activeBg: string
  onNoteOn: (n: number) => void
  onNoteOff: (n: number) => void
}) {
  const [pressed, setPressed] = useState(false)
  const borderColor = border

  return (
    <button
      className={`rounded-2xl aspect-square font-semibold text-2xl select-none touch-none
                  transition-all duration-75 border bg-black
                  ${pressed ? `${activeBg} scale-95 text-gray-950` : `${borderColor} text-gray-600`}`}
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
      className={`rounded-2xl h-12 text-gray-200 font-semibold text-sm select-none touch-none
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
  const [mounted, setMounted]   = useState(false)
  const [activeDeck, setActiveDeck] = useState(0)
  const [eqValues, setEqValues]   = useState([[64,64,64,64],[64,64,64,64]])
  const [pitchValues, setPitchValues] = useState([PITCH_CENTER, PITCH_CENTER])
  const { status, log, connect, send, failed } = useMidiBridge()

  useEffect(() => { setMounted(true) }, [])

  return (
    <main className="min-h-screen bg-gray-950 text-white px-4 py-6 w-full flex flex-col gap-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-bold flex-shrink-0">どこでもDJ</h1>
        <div className="flex gap-2 flex-shrink-0">
          <LinkButton href="/ar">AR</LinkButton>
          <ConnectButton
            disabled={!mounted || status === 'connecting'}
            status={status}
            onClick={() => connect()}
            mounted={mounted}
          />
        </div>
      </div>

      {/* 接続失敗メッセージ */}
      {failed && (
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-sm text-gray-400 text-center">
          サーバーに接続できませんでした。PC側でサーバーが起動しているか確認してください。
        </div>
      )}

      {/* Turntable */}
      <div className="relative flex justify-center flex-1">
        <div className="w-full max-w-[280px]">
          <Turntable channel={activeDeck} send={send} />
        </div>
        <div className="absolute left-0 bottom-0 flex flex-col gap-2">
          <CuePlayButton channel={activeDeck} send={send} />
          <PlayStopButton channel={activeDeck} send={send} />
        </div>
        <div className="absolute right-0 inset-y-0 py-2">
          <PitchFader
            channel={activeDeck} send={send}
            value={pitchValues[activeDeck]}
            onValueChange={(v) => setPitchValues(prev => { const n=[...prev]; n[activeDeck]=v; return n })}
          />
        </div>
      </div>

      {/* Pads */}
      <div className="grid grid-cols-4 gap-3">
        {PADS.map(({ note, border, activeBg }) => (
          <Pad
            key={note}
            note={note}
            label=""
            border={border}
            activeBg={activeBg}
            onNoteOn={(n) => send({ type: 'note_on',  channel: activeDeck, note: n, velocity: 127 })}
            onNoteOff={(n) => send({ type: 'note_off', channel: activeDeck, note: n })}
          />
        ))}
      </div>

      {/* EQ / Filter */}
      <div className="grid grid-cols-4 gap-3">
        {KNOBS.map(({ id: label, cc }, idx) => (
          <Knob
            key={label} label={label} cc={cc} channel={activeDeck} send={send}
            value={eqValues[activeDeck][idx]}
            onValueChange={(v) => setEqValues(prev => {
              const n = prev.map(row => [...row]); n[activeDeck][idx] = v; return n
            })}
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
