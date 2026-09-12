'use client'

import { useState } from 'react'
import { normalizeCode, isValidCode } from '@/core/room'
import type { RoomError } from '@/hooks/useMidiBridge'

interface RoomGateProps {
  reason: RoomError
  onSubmit: (code: string) => void
  overlay?: boolean
}

// ルームコードの入力画面。PC側モニタに出ているコードを入れてもらう
export function RoomGate({ reason, onSubmit, overlay }: RoomGateProps) {
  const [code, setCode] = useState('')
  const ready = isValidCode(code)

  return (
    <div className={`${overlay ? 'absolute' : 'fixed'} inset-0 z-50 bg-gray-950 text-white
                     flex flex-col items-center justify-center gap-6 px-8`}>
      <h1 className="text-lg font-bold">どこでもDJ</h1>
      <p className="text-sm text-gray-400 text-center">
        {reason === 'unknown'
          ? 'このルームは見つかりませんでした。PCのモニタ画面に出ているコードを入れてください。'
          : 'PCのモニタ画面に出ているルームコードを入れてください。'}
      </p>
      <input
        value={code}
        onChange={e => setCode(normalizeCode(e.target.value))}
        inputMode="text"
        autoCapitalize="characters"
        placeholder="ABCD"
        className="w-48 text-center text-3xl tracking-[0.4em] font-mono
                   bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3
                   focus:outline-none focus:border-gray-500"
      />
      <button
        disabled={!ready}
        onClick={() => onSubmit(code)}
        className="min-h-[44px] px-8 rounded-xl font-medium bg-gray-800 active:bg-gray-600
                   border border-gray-700 disabled:opacity-40 disabled:pointer-events-none"
      >
        接続する
      </button>
    </div>
  )
}
