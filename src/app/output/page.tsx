'use client'

import { useEffect, useRef, useState } from 'react'
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

// --- Main Page ---

// スマホのパッドに対応するノート番号
const PAD_NOTES = [36, 37, 38, 39]

export default function OutputPage() {
  const [midiPorts, setMidiPorts]       = useState<string[]>([])
  const [selectedPort, setSelectedPort] = useState('')
  const [midiStatus, setMidiStatus]     = useState('初期化中...')
  const [sockStatus, setSockStatus]     = useState<'disconnected' | 'connected'>('disconnected')
  const [log, setLog]                   = useState<string[]>([])
  const [activePads, setActivePads]     = useState<Set<number>>(new Set())

  // useRef で最新値をコールバック内から参照
  const outputsRef = useRef<Map<string, MIDIOutput>>(new Map())
  const selectedRef = useRef('')

  const addLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false })
    setLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 40))
  }

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
        setActivePads(prev => new Set(prev).add(msg.note))
      } else if (msg.type === 'note_off' && PAD_NOTES.includes(msg.note)) {
        setActivePads(prev => { const s = new Set(prev); s.delete(msg.note); return s })
      }

      // MIDI 出力
      const out = outputsRef.current.get(selectedRef.current)
      if (!out) {
        addLog('⚠ MIDI ポート未選択')
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

  const sockColor = sockStatus === 'connected' ? 'text-green-400' : 'text-gray-500'
  const midiColor = midiPorts.length > 0 ? 'text-green-400' : 'text-yellow-400'

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6 max-w-lg mx-auto space-y-6 font-sans">

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">どこでもDJ — MIDI Output</h1>
          <p className="text-sm text-gray-400 mt-1">
            このページを PC の Chrome / Edge で開いたままにしてください
          </p>
        </div>
        <Link
          href="/"
          className="shrink-0 px-4 py-2 rounded-xl text-sm font-medium
                     bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors"
        >
          スマホ版
        </Link>
      </div>

      {/* Status */}
      <section className="bg-gray-900 rounded-2xl p-4 space-y-2 text-sm">
        <div className={sockColor}>
          ● Socket: {sockStatus === 'connected' ? 'スマホからの接続待機中' : '切断 — server.js が起動しているか確認'}
        </div>
        <div className={midiColor}>
          ♪ MIDI: {midiStatus}
        </div>
      </section>

      {/* Pad monitor */}
      <section className="space-y-2">
        <label className="text-xs text-gray-400 uppercase tracking-widest">Pad Monitor</label>
        <div className="grid grid-cols-4 gap-3">
          {PAD_NOTES.map((note, i) => (
            <div
              key={note}
              className={`rounded-2xl h-20 flex items-center justify-center text-xl font-semibold
                          border transition-all duration-75
                          ${activePads.has(note)
                            ? 'bg-white text-gray-950 border-white scale-95'
                            : 'bg-gray-800 text-gray-600 border-gray-700'}`}
            >
              {i + 1}
            </div>
          ))}
        </div>
      </section>

      {/* MIDI port selector */}
      <section className="space-y-2">
        <label className="text-xs text-gray-400 uppercase tracking-widest">MIDI 出力ポート</label>
        {midiPorts.length === 0 ? (
          <p className="text-sm text-yellow-400">
            MIDI デバイスが見つかりません。DJ ソフトの仮想ポートを有効にしてください。
          </p>
        ) : (
          <select
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm
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
      </section>

      {/* Log */}
      <section className="space-y-2">
        <label className="text-xs text-gray-400 uppercase tracking-widest">MIDI ログ</label>
        <div className="bg-gray-900 rounded-2xl p-3 h-56 overflow-y-auto font-mono text-xs space-y-0.5">
          {log.length === 0
            ? <p className="text-gray-600">スマホから操作するとここにログが流れます</p>
            : log.map((l, i) => <p key={i} className="text-green-400 leading-5">{l}</p>)}
        </div>
      </section>

    </main>
  )
}
