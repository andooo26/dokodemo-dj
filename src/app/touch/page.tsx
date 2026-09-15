'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useMidiBridge } from '@/hooks/useMidiBridge'
import { useDjEngine } from '@/hooks/useDjEngine'
import type { DeckIndex, DeckState } from '@/core/audio'
import { RoomGate } from '@/components/RoomGate'
import { withRoom } from '@/core/room'
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

// BPMに合わせてジョグを前後に振る。信号はタンテを手で回したときと同じ
function ScratchButton({ channel, bpm, send }: {
  channel: number
  bpm: number
  send: (msg: MidiMsg) => void
}) {
  const [pressed, setPressed] = useState(false)
  const frameRef = useRef(0)

  const stop = () => {
    if (!frameRef.current) return
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    setPressed(false)
    send({ type: 'pitch_bend', channel, value: PITCH_CENTER })
    send({ type: 'note_off', channel, note: TURNTABLE_STOP_NOTE })
  }

  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }, [])

  const start = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setPressed(true)
    send({ type: 'note_on', channel, note: TURNTABLE_STOP_NOTE, velocity: 127 })

    const beat = 60000 / (bpm || 120)
    const began = performance.now()
    const loop = () => {
      // 1拍で1往復。位相は経過時間から出すので、駒落ちしてもずれない
      const phase = ((performance.now() - began) % beat) / beat
      const swing = Math.sin(phase * 2 * Math.PI) * SCRATCH_DEPTH
      send({ type: 'pitch_bend', channel, value: Math.round(PITCH_CENTER + swing * 4096) })
      frameRef.current = requestAnimationFrame(loop)
    }
    loop()
  }

  return (
    <button
      className={`w-12 h-12 rounded-full text-[10px] font-semibold select-none touch-none border border-gray-700
                  transition-all duration-75
                  ${pressed ? 'bg-gray-400 scale-95 text-gray-950' : 'bg-gray-800 text-gray-200'}`}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
    >
      擦る
    </button>
  )
}

function Pad({ note, label, border, activeBg, armed, onNoteOn, onNoteOff }: {
  note: number; label: string; border: string; activeBg: string
  armed: boolean
  onNoteOn: (n: number) => void
  onNoteOff: (n: number) => void
}) {
  const [pressed, setPressed] = useState(false)
  const borderColor = border

  return (
    <button
      className={`rounded-2xl aspect-square font-semibold text-2xl select-none touch-none
                  transition-all duration-75 border bg-black
                  ${pressed ? `${activeBg} scale-95 text-gray-950`
                    : armed ? `${borderColor} ${activeBg}/25 text-gray-300`
                    : `${borderColor} text-gray-600`}`}
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

const CUE_COLOR = '#f59e0b'
const SCRATCH_DEPTH = 0.8   // 自動スクラッチの振り幅

// 全体波形。再生位置と頭出し点、ホットキューを重ねる
function Waveform({ deck, state, position, peaks, onSeek }: {
  deck: number
  state: DeckState
  position: (deck: DeckIndex) => number
  peaks: (deck: DeckIndex) => Float32Array | null
  onSeek: (to: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let frame = 0
    let lastAt = -1

    const draw = () => {
      frame = requestAnimationFrame(draw)
      const at = position(deck as DeckIndex)
      if (at === lastAt && frame > 2) return   // 止まっている間は描き直さない
      lastAt = at

      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      const g = canvas.getContext('2d')
      if (!g) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)

      const mid  = h / 2
      const data = peaks(deck as DeckIndex)
      if (!data || !state.duration) {
        g.fillStyle = '#374151'
        g.fillRect(0, mid - 0.5, w, 1)
        return
      }

      const ratio = Math.min(1, at / state.duration)
      const barW  = w / data.length
      const bars  = (from: number, to: number, color: string) => {
        g.beginPath()
        for (let i = from; i < to; i++) {
          const y = Math.max(1, data[i] * mid * 0.95)
          g.rect(i * barW, mid - y, Math.max(1, barW - 0.5), y * 2)
        }
        g.fillStyle = color
        g.fill()
      }
      const played = Math.round(ratio * data.length)
      bars(0, played, '#9ca3af')
      bars(played, data.length, '#4b5563')

      const xOf = (t: number) => (t / state.duration) * w

      // ホットキューは下端にチップ。番号で見分ける
      state.cues.forEach((t, i) => {
        if (t === null) return
        const x = xOf(t)
        g.fillStyle = PADS[i].hex
        g.fillRect(x - 1, 0, 2, h)
        g.fillRect(x - 1, h - 11, 11, 11)
        g.fillStyle = '#0a0a0a'
        g.font = 'bold 8px ui-monospace, monospace'
        g.fillText(String(i + 1), x + 2, h - 3)
      })

      // CUE点は上端に旗。DJソフトと同じ見た目に寄せる
      const cueX = xOf(state.cue)
      g.fillStyle = CUE_COLOR
      g.fillRect(cueX - 1, 0, 2, h)
      g.beginPath()
      g.moveTo(cueX - 1, 0)
      g.lineTo(cueX + 10, 0)
      g.lineTo(cueX - 1, 11)
      g.closePath()
      g.fill()

      g.fillStyle = '#ffffff'
      g.fillRect(ratio * w - 1, 0, 2, h)
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [deck, state.duration, state.cue, state.cues, state.name, position, peaks])

  const seekFromPointer = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas || !state.duration) return
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(ratio * state.duration)
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-16 select-none touch-none cursor-pointer"
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); seekFromPointer(e) }}
      onPointerMove={e => { if (e.buttons || e.pointerType === 'touch') seekFromPointer(e) }}
    />
  )
}

function formatTime(sec: number) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// 読み込んだ曲と再生位置。再生中だけ自前で時計を回す
function TrackStrip({ deck, state, position, peaks, rate, onLoad, onSeek, onBpm, onKeylock }: {
  deck: number
  state: DeckState
  position: (deck: DeckIndex) => number
  peaks: (deck: DeckIndex) => Float32Array | null
  rate: (deck: DeckIndex) => number
  onLoad: (file: File) => void
  onSeek: (to: number) => void
  onBpm: (bpm: number) => void
  onKeylock: (on: boolean) => void
}) {
  const [at, setAt] = useState(0)
  const [tempo, setTempo] = useState(1)
  const inputRef = useRef<HTMLInputElement>(null)

  // 同じ値なら再描画されないので、止まっていても回しておいてよい
  useEffect(() => {
    const id = setInterval(() => {
      setAt(position(deck as DeckIndex))
      setTempo(rate(deck as DeckIndex))
    }, 100)
    return () => clearInterval(id)
  }, [deck, position, rate])

  return (
    <div className="bg-gray-900 rounded-2xl px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500 uppercase tracking-widest shrink-0">
          Deck {deck + 1}
        </span>
        <span className="text-sm truncate flex-1 min-w-0">
          {state.loading ? '読み込み中...' : state.name ?? '曲が未選択です'}
        </span>
        <span className="shrink-0 font-mono text-sm text-gray-300 tabular-nums">
          {state.bpm ? (state.bpm * tempo).toFixed(1) : '--.-'}
          <span className="text-xs text-gray-500 ml-1">BPM</span>
        </span>
        {/* テンポを変えてもピッチを保つ */}
        <button
          onClick={() => onKeylock(!state.keylock)}
          className={`shrink-0 text-xs px-2.5 py-1.5 rounded-lg border ${
            state.keylock
              ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
              : 'bg-gray-800 border-gray-700 text-gray-400'
          }`}
        >
          KEY
        </button>
        <button
          onClick={() => inputRef.current?.click()}
          className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-200"
        >
          曲を選ぶ
        </button>
        <input
          id={`track-file-${deck}`}
          ref={inputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) onLoad(file)
            e.target.value = ''
          }}
        />
      </div>

      <Waveform deck={deck} state={state} position={position} peaks={peaks} onSeek={onSeek} />

      <div className="flex items-center justify-between text-xs text-gray-500 font-mono">
        <span>{formatTime(at)}</span>

        {/* 倍や半分で拾ったときに直す */}
        {state.bpm !== null && (
          <span className="flex gap-1">
            {([['×2', 2], ['÷2', 0.5]] as const).map(([label, ratio]) => (
              <button
                key={label}
                onClick={() => onBpm((state.bpm ?? 0) * ratio)}
                className="px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-400"
              >
                {label}
              </button>
            ))}
          </span>
        )}

        {state.error
          ? <span className="text-red-400 font-sans">{state.error}</span>
          : <span>
              {Math.abs(tempo - 1) > 0.0005 && (
                <span className="text-gray-400 mr-2">
                  {tempo > 1 ? '+' : ''}{((tempo - 1) * 100).toFixed(1)}%
                </span>
              )}
              {formatTime(state.duration)}
            </span>}
      </div>
    </div>
  )
}

// --- Page ---

export default function Controller() {
  const [mounted, setMounted]   = useState(false)
  const [activeDeck, setActiveDeck] = useState(0)
  const [eqValues, setEqValues]   = useState([[64,64,64,64],[64,64,64,64]])
  const [pitchValues, setPitchValues] = useState([PITCH_CENTER, PITCH_CENTER])
  const dj = useDjEngine()
  const { status, log, connect, send, failed, room, roomError, standalone } = useMidiBridge(dj.handle)

  useEffect(() => { setMounted(true) }, [])

  if (roomError) return <RoomGate reason={roomError} onSubmit={connect} />

  return (
    <main
      className="min-h-screen bg-gray-950 text-white w-full mx-auto flex flex-col
                 px-4 py-6 gap-6 max-w-md
                 landscape:py-3 landscape:gap-3 landscape:max-w-4xl"
      onPointerDown={() => dj.resume()}
    >

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-bold flex-shrink-0">どこでもDJ</h1>
        <div className="flex gap-2 flex-shrink-0 items-center">
          {standalone && (
            <span className="text-xs px-2 py-1 rounded-lg bg-gray-900 border border-gray-700 text-gray-400">
              ローカル
            </span>
          )}
          <LinkButton href={withRoom('/ar', room)}>AR</LinkButton>
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

      {/* Track */}
      <TrackStrip
        deck={activeDeck}
        state={dj.decks[activeDeck]}
        position={dj.position}
        peaks={dj.peaks}
        rate={dj.rate}
        onLoad={(file) => dj.load(activeDeck as DeckIndex, file)}
        onSeek={(to) => dj.seek(activeDeck as DeckIndex, to)}
        onBpm={(bpm) => dj.setBpm(activeDeck as DeckIndex, bpm)}
        onKeylock={(on) => dj.setKeylock(activeDeck as DeckIndex, on)}
      />

      {/* 操作面。横画面では左にタンテ、右にPADとEQを置く */}
      <div className="flex flex-col gap-6 flex-1 min-h-0 landscape:flex-row landscape:gap-6 landscape:items-center">

      {/* Turntable */}
      <div className="relative flex justify-center flex-1 landscape:h-full landscape:items-center">
        <div className="w-full max-w-[280px] landscape:max-w-[min(280px,46vh)]">
          <Turntable channel={activeDeck} send={send} />
        </div>
        <div className="absolute left-0 bottom-0 flex flex-col gap-2">
          <CuePlayButton channel={activeDeck} send={send} />
          <PlayStopButton channel={activeDeck} send={send} />
          <ScratchButton
            channel={activeDeck}
            bpm={(dj.decks[activeDeck].bpm ?? 0) * dj.rate(activeDeck as DeckIndex)}
            send={send}
          />
        </div>
        <div className="absolute right-0 inset-y-0 py-2">
          <PitchFader
            channel={activeDeck} send={send}
            value={pitchValues[activeDeck]}
            onValueChange={(v) => setPitchValues(prev => { const n=[...prev]; n[activeDeck]=v; return n })}
          />
        </div>
      </div>

      <div className="flex flex-col gap-6 landscape:flex-1 landscape:gap-3">

      {/* Pads */}
      <div className="grid grid-cols-4 gap-3">
        {PADS.map(({ note, border, activeBg }, i) => (
          <Pad
            key={note}
            note={note}
            label=""
            border={border}
            activeBg={activeBg}
            armed={dj.decks[activeDeck].cues[i] !== null}
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

      </div>
      </div>

      {/* Log */}
      <div className="flex-1 bg-gray-900 rounded-2xl p-3 overflow-y-auto font-mono text-xs space-y-0.5 min-h-[160px] landscape:hidden">
        {log.length === 0
          ? <p className="text-gray-600">-log-</p>
          : log.map((l, i) => <p key={i} className="text-gray-400 leading-5">{l}</p>)}
      </div>

    </main>
  )
}
