import { useState, useRef, useCallback, useEffect } from 'react'
import { io, Socket } from 'socket.io-client'

export type MidiMsg =
  | { type: 'note_on';    channel: number; note: number; velocity: number }
  | { type: 'note_off';   channel: number; note: number }
  | { type: 'cc';         channel: number; controller: number; value: number }
  | { type: 'pitch_bend'; channel: number; value: number }

export type Status = 'disconnected' | 'connecting' | 'connected'

export function useMidiBridge() {
  const [status, setStatus]   = useState<Status>('disconnected')
  const [log, setLog]         = useState<string[]>([])
  const [failed, setFailed]   = useState(false)
  const socketRef             = useRef<Socket | null>(null)

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false })
    setLog((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 30))
  }, [])

  const connect = useCallback(() => {
    socketRef.current?.disconnect()
    setStatus('connecting')
    setFailed(false)
    const s = io({ query: { role: 'controller' }, transports: ['websocket'], timeout: 3000 })
    s.on('connect',       () => { setStatus('connected');    setFailed(false); addLog('接続しました') })
    s.on('disconnect',    () => { setStatus('disconnected'); addLog('切断しました') })
    s.on('connect_error', () => { setStatus('disconnected'); setFailed(true) })
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
    if      (msg.type === 'note_on')    addLog(`Note On  ${msg.note}`)
    else if (msg.type === 'note_off')   addLog(`Note Off ${msg.note}`)
    else if (msg.type === 'cc')         addLog(`CC ${msg.controller}  ${msg.value}`)
    else if (msg.type === 'pitch_bend') addLog(`Pitch Bend ${msg.value}`)
  }, [addLog])

  // マウント時に自動接続
  useEffect(() => { connect() }, [connect])

  useEffect(() => () => { socketRef.current?.disconnect() }, [])

  return { status, log, connect, send, failed }
}
