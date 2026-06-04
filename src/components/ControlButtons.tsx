import { useState, ReactNode } from 'react'
import type { MidiMsg } from '@/hooks/useMidiBridge'

interface ButtonProps {
  channel: number
  send?: (msg: MidiMsg) => void
  active?: boolean
}

export function CuePlayButton({ channel, send, active = false }: ButtonProps) {
  const [pressed, setPressed] = useState(false)

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!send) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setPressed(true)
    send({ type: 'note_on', channel, note: 47, velocity: 127 })
  }

  const handlePointerUp = () => {
    if (!send) return
    setPressed(false)
    send({ type: 'note_off', channel, note: 47 })
  }

  const handlePointerCancel = () => {
    if (!send) return
    setPressed(false)
    send({ type: 'note_off', channel, note: 47 })
  }

  return (
    <button
      className={`w-12 h-12 rounded-full text-xs font-semibold select-none touch-none border border-gray-700
                  transition-all duration-75
                  ${pressed ? 'bg-gray-400 scale-95 text-gray-950' : active ? 'bg-gray-600 text-gray-100' : 'bg-gray-800 text-gray-200'}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      CUE
    </button>
  )
}

export function PlayStopButton({ channel, send, active = false }: ButtonProps) {
  const [pressed, setPressed] = useState(false)

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!send) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setPressed(true)
    send({ type: 'note_on', channel, note: 0, velocity: 127 })
  }

  const handlePointerUp = () => {
    if (!send) return
    setPressed(false)
    send({ type: 'note_off', channel, note: 0 })
  }

  const handlePointerCancel = () => {
    if (!send) return
    setPressed(false)
    send({ type: 'note_off', channel, note: 0 })
  }

  return (
    <button
      className={`w-12 h-12 rounded-full text-sm font-semibold select-none touch-none border border-gray-700
                  transition-all duration-75
                  ${pressed ? 'bg-gray-400 scale-95 text-gray-950' : active ? 'bg-gray-600 text-gray-100' : 'bg-gray-800 text-gray-200'}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      ▷/‖
    </button>
  )
}
