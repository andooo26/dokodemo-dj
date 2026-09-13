import { useState, useRef, useCallback, useEffect } from 'react'
import { io, Socket } from 'socket.io-client'
import { encode, dedupKey, valueOf } from '@/core/codec'
import type { MidiMsg } from '@/core/codec'
import { currentRoom, rememberRoom } from '@/core/room'

export type { MidiMsg }

export type Status = 'disconnected' | 'connecting' | 'connected'
export type RoomError = 'missing' | 'unknown' | null

// local を渡すと、サーバに繋がっていなくてもその出口へ流す
export function useMidiBridge(local?: (msg: MidiMsg) => void) {
  const [status, setStatus]   = useState<Status>('disconnected')
  const [log, setLog]         = useState<string[]>([])
  const [failed, setFailed]   = useState(false)
  const [room, setRoom]       = useState<string | null>(null)
  const [roomError, setRoomError] = useState<RoomError>(null)
  const [standalone, setStandalone] = useState(false)   // コード無しで、この端末だけで鳴らす
  const socketRef             = useRef<Socket | null>(null)
  const lastSentRef           = useRef<Map<string, number>>(new Map())
  const localRef              = useRef<((msg: MidiMsg) => void) | undefined>(undefined)

  useEffect(() => { localRef.current = local }, [local])

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false })
    setLog((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 30))
  }, [])

  // code を渡すと、そのルームへ入り直す
  const connect = useCallback((code?: string) => {
    const target = code ?? currentRoom()
    socketRef.current?.disconnect()
    setStatus('connecting')
    setFailed(false)
    setRoomError(null)
    lastSentRef.current.clear()

    // コードが無くてもローカル音源があれば1台で完結できる
    if (!target) {
      setStatus('disconnected')
      if (localRef.current) { setStandalone(true); addLog('この端末だけで鳴らします') }
      else setRoomError('missing')
      return
    }
    setStandalone(false)

    const s = io({ query: { role: 'controller', room: target }, transports: ['websocket'], timeout: 3000 })
    s.on('connect',       () => { setStatus('connected');    setFailed(false); addLog('接続しました') })
    s.on('disconnect',    () => { setStatus('disconnected'); addLog('切断しました') })
    s.on('connect_error', () => { setStatus('disconnected'); setFailed(true) })
    s.on('room', (p: { code: string }) => {
      // 再接続時も同じルームへ戻る
      s.io.opts.query = { ...s.io.opts.query, room: p.code }
      setRoom(p.code)
      setRoomError(null)
      rememberRoom(p.code)
      addLog(`ルーム ${p.code} に参加しました`)
    })
    s.on('roomerror', (p: { reason: 'missing' | 'unknown' }) => {
      setStatus('disconnected')
      setRoomError(p.reason)
      addLog(p.reason === 'unknown' ? 'ルームが見つかりません' : 'ルームコードが必要です')
      s.disconnect()
    })
    socketRef.current = s
  }, [addLog])

  const send = useCallback((msg: MidiMsg) => {
    // 値が変わっていない連続値は送らない
    const key = dedupKey(msg)
    if (key !== null) {
      if (lastSentRef.current.get(key) === valueOf(msg)) return
      lastSentRef.current.set(key, valueOf(msg))
    }

    // ローカル音源は接続の有無に関わらず鳴らす
    localRef.current?.(msg)

    if (socketRef.current?.connected) {
      socketRef.current.emit('midi', encode(msg))
    } else if (!localRef.current) {
      // 送り先がどこにも無いときだけ、繋ぐよう促す
      if      (msg.type === 'note_on')    addLog(`サーバに接続してください: note_on ${msg.note} ${msg.velocity}`)
      else if (msg.type === 'note_off')   addLog(`サーバに接続してください: note_off ${msg.note}`)
      else if (msg.type === 'cc')         addLog(`サーバに接続してください: cc ${msg.controller} ${msg.value}`)
      else if (msg.type === 'pitch_bend') addLog(`サーバに接続してください: pitch_bend ${msg.value}`)
      return
    }

    if      (msg.type === 'note_on')    addLog(`Note On  ${msg.note}`)
    else if (msg.type === 'note_off')   addLog(`Note Off ${msg.note}`)
    else if (msg.type === 'cc')         addLog(`CC ${msg.controller}  ${msg.value}`)
    else if (msg.type === 'pitch_bend') addLog(`Pitch Bend ${msg.value}`)
  }, [addLog])

  // マウント時に接続
  useEffect(() => { connect() }, [connect])

  useEffect(() => () => { socketRef.current?.disconnect() }, [])

  return { status, log, connect, send, failed, room, roomError, standalone }
}
