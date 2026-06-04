'use client'

import { useEffect, useRef, useState } from 'react'
import { useMidiBridge } from '@/hooks/useMidiBridge'
import { LinkButton, ConnectButton } from '@/components/HeaderButton'
import type { HandLandmarker } from '@mediapipe/tasks-vision'


// --- MediaPipe ---

const WASM_PATH  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

// --- 仮想つまみゾーン (正規化座標) ---
// リアカメラで画面下部に手を向けやすい位置に配置
const KNOB_ZONES = [
  { label: 'HIGH',   cc: 10, nx: 0.20, ny: 0.22 },
  { label: 'MID',    cc: 11, nx: 0.40, ny: 0.22 },
  { label: 'LOW',    cc: 12, nx: 0.60, ny: 0.22 },
  { label: 'FILTER', cc: 13, nx: 0.80, ny: 0.22 },
] as const

const FADER_HALF_H   = 0.14  // フェーダートラック半高（正規化）
const FADER_HIT_X    = 0.06  // 横方向ホバー判定幅（正規化）
const PINCH_THRESH   = 0.07  // ピンチ判定距離
const FADER_SENSI    = 200   // 上下移動感度 (正規化Δy → CC value)
const DECK_HOLD_MS   = 3000  // デッキ切り替えホールド時間(ms)
const FINGER_EXT_THR = 0.04  // 指伸展判定閾値（正規化）

// --- PAD ---
const PAD_CONFIG = [
  { fingerTip: 8,  note: 36, label: 'PAD 1', color: '#60a5fa' },
  { fingerTip: 12, note: 37, label: 'PAD 2', color: '#34d399' },
  { fingerTip: 16, note: 38, label: 'PAD 3', color: '#f97316' },
  { fingerTip: 20, note: 39, label: 'PAD 4', color: '#a78bfa' },
] as const

// 伸展している指の本数（人差し〜小指）
function countExtendedFingers(lm: { x: number; y: number }[]): number {
  return (
    [[8, 5], [12, 9], [16, 13], [20, 17]] as [number, number][]
  ).filter(([tip, mcp]) => lm[tip].y < lm[mcp].y - FINGER_EXT_THR).length
}

// MediaPipe スケルトン接続
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [9,10],[10,11],[11,12],
  [13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
]


// --- Page ---

export default function ARPage() {
  const videoRef       = useRef<HTMLVideoElement>(null)
  const canvasRef      = useRef<HTMLCanvasElement>(null)
  const landmarkerRef  = useRef<HandLandmarker | null>(null)
  const rafRef         = useRef<number>(0)

  // PAD 状態
  const activePadsRef  = useRef<Set<number>>(new Set())
  const [activeDeck, setActiveDeck] = useState(0)
  const activeDeckRef  = useRef(0)

  // デッキ切り替えジェスチャー
  const deckGestureRef      = useRef<'none' | 'holding' | 'completed'>('none')
  const deckGestureStartRef = useRef<number | null>(null)  // 開始タイムスタンプ

  // つまみ状態
  const knobValuesRef  = useRef<number[]>([64, 64, 64, 64])
  const grabbedKnobRef = useRef<number>(-1)   // -1 = none
  const lastYRef       = useRef<number | null>(null)

  const [isReady, setIsReady]         = useState(false)
  const [loadingMsg, setLoadingMsg]   = useState('カメラを起動中...')
  const [cameraError, setCameraError] = useState('')
  const [activeLabels, setActiveLabels] = useState<string[]>([])

  const { status, connect, send, failed } = useMidiBridge()
  useEffect(() => { activeDeckRef.current = activeDeck }, [activeDeck])

  const sendRef = useRef(send)
  useEffect(() => { sendRef.current = send }, [send])

  // MediaPipe 初期化
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        setLoadingMsg('MediaPipe を読み込み中...')
        const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision')
        const fileset = await FilesetResolver.forVisionTasks(WASM_PATH)
        const hl = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
        })
        if (!cancelled) { landmarkerRef.current = hl; setIsReady(true); setLoadingMsg('') }
      } catch {
        if (!cancelled) setLoadingMsg('MediaPipe の読み込みに失敗しました')
      }
    }
    init()
    return () => { cancelled = true }
  }, [])

  // カメラ起動
  useEffect(() => {
    let stream: MediaStream | null = null
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        if (videoRef.current) videoRef.current.srcObject = stream
      } catch {
        setCameraError('カメラへのアクセスが拒否されました。HTTPS 環境で開いてください。')
      }
    }
    start()
    return () => { stream?.getTracks().forEach(t => t.stop()) }
  }, [])

  // rAF ループ
  useEffect(() => {
    if (!isReady) return

    const labelSet = new Set<string>()

    function drawFaders(ctx: CanvasRenderingContext2D, w: number, h: number, hoveredIdx: number) {
      for (let i = 0; i < KNOB_ZONES.length; i++) {
        const { label, nx, ny } = KNOB_ZONES[i]
        const cx       = nx * w
        const trackTop = (ny - FADER_HALF_H) * h
        const trackBot = (ny + FADER_HALF_H) * h
        const trackH   = trackBot - trackTop
        const val      = knobValuesRef.current[i]
        const grabbed  = grabbedKnobRef.current === i
        const hovered  = hoveredIdx === i

        const thumbY = trackTop + (1 - val / 127) * trackH
        const centerY = (trackTop + trackBot) / 2

        // トラック
        ctx.beginPath()
        ctx.moveTo(cx, trackTop)
        ctx.lineTo(cx, trackBot)
        ctx.strokeStyle = grabbed ? 'rgba(255,255,255,0.8)' : hovered ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)'
        ctx.lineWidth   = 2
        ctx.stroke()

        // センターマーク
        ctx.beginPath()
        ctx.moveTo(cx - 8, centerY)
        ctx.lineTo(cx + 8, centerY)
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'
        ctx.lineWidth   = 1
        ctx.stroke()

        // サム（横長の角丸バー）
        const tw = grabbed ? 22 : hovered ? 18 : 14
        const th = 8
        ctx.fillStyle   = grabbed ? 'rgba(210,210,210,0.95)' : hovered ? 'rgba(180,180,180,0.75)' : 'rgba(150,150,150,0.45)'
        ctx.strokeStyle = grabbed ? 'white' : hovered ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)'
        ctx.lineWidth   = 1
        ctx.beginPath()
        ctx.roundRect(cx - tw, thumbY - th, tw * 2, th * 2, 4)
        ctx.fill()
        ctx.stroke()

        // ラベル
        ctx.font      = 'bold 11px sans-serif'
        ctx.fillStyle = grabbed ? 'white' : hovered ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)'
        ctx.textAlign = 'center'
        ctx.fillText(label, cx, trackBot + 16)

        // グラブ中は値を表示
        if (grabbed) {
          ctx.font      = '11px sans-serif'
          ctx.fillStyle = '#93c5fd'
          ctx.fillText(String(val), cx, trackTop - 8)
        }
      }
    }

    function loop(now: number) {
      rafRef.current = requestAnimationFrame(loop)

      const video      = videoRef.current
      const canvas     = canvasRef.current
      const landmarker = landmarkerRef.current
      if (!video || !canvas || !landmarker || video.readyState < 2) return

      const vw = video.videoWidth  || 640
      const vh = video.videoHeight || 480
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw; canvas.height = vh
      }

      const results = landmarker.detectForVideo(video, now)
      const ctx     = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      labelSet.clear()
      let hoveredKnob = -1

      // 手が1本も検出されなければ全リセット
      if (results.landmarks.length === 0) {
        for (const note of activePadsRef.current)
          sendRef.current({ type: 'note_off', channel: activeDeckRef.current, note })
        activePadsRef.current.clear()
        if (grabbedKnobRef.current >= 0) {
          grabbedKnobRef.current = -1
          lastYRef.current       = null
        }
        deckGestureRef.current      = 'none'
        deckGestureStartRef.current = null
      }

      for (const landmarks of results.landmarks) {
        const thumb = landmarks[4]
        const index = landmarks[8]  // 人差し指先端

        // --- フェーダーホバー判定（人差し指先端がトラック矩形内） ---
        for (let i = 0; i < KNOB_ZONES.length; i++) {
          const { nx, ny } = KNOB_ZONES[i]
          if (
            Math.abs(index.x - nx) < FADER_HIT_X &&
            index.y > ny - FADER_HALF_H &&
            index.y < ny + FADER_HALF_H
          ) { hoveredKnob = i; break }
        }

        // --- 親指+人差し指ピンチ判定 ---
        const indexPinch = Math.hypot(thumb.x - index.x, thumb.y - index.y) < PINCH_THRESH

        if (indexPinch && hoveredKnob >= 0) {
          // つまみをグラブ
          if (grabbedKnobRef.current !== hoveredKnob) {
            grabbedKnobRef.current = hoveredKnob
            lastYRef.current       = index.y
          }
          // 上移動 → 増加、下移動 → 減少
          const delta = lastYRef.current !== null ? (lastYRef.current - index.y) * FADER_SENSI : 0
          lastYRef.current = index.y

          let v = Math.round(knobValuesRef.current[hoveredKnob] + delta)
          v = Math.max(0, Math.min(127, v))
          if (Math.abs(v - 64) <= 3) v = 64
          knobValuesRef.current[hoveredKnob] = v
          sendRef.current({ type: 'cc', channel: activeDeckRef.current, controller: KNOB_ZONES[hoveredKnob].cc, value: v })
          labelSet.add(KNOB_ZONES[hoveredKnob].label)
        } else {
          // ピンチ解除またはゾーン外ならグラブ解放
          if (!indexPinch && grabbedKnobRef.current >= 0) {
            grabbedKnobRef.current = -1
            lastYRef.current       = null
          }

          // --- PAD ピンチ検出（knob grab 中・グー状態では無効） ---
          if (grabbedKnobRef.current < 0) {
            // グーのポーズではPAD完全無効
            const isFist = countExtendedFingers(landmarks) === 0
            // フェーダーエリア（y < 0.4）ではPAD完全無効
            const inFaderZone = index.y < 0.4

            // 最も深いピンチ1本だけ選択（グー中・フェーダーゾーンなら -1 固定）
            let bestNote = -1, bestDist = PINCH_THRESH
            if (!isFist && !inFaderZone) {
              for (const { fingerTip, note } of PAD_CONFIG) {
                const dist = Math.hypot(thumb.x - landmarks[fingerTip].x, thumb.y - landmarks[fingerTip].y)
                if (dist < bestDist) { bestDist = dist; bestNote = note }
              }
            }

            // note_on / note_off（bestNote = -1 なら全解放）
            for (const { note, label } of PAD_CONFIG) {
              const isActive = note === bestNote
              const was      = activePadsRef.current.has(note)
              if (isActive && !was) {
                activePadsRef.current.add(note)
                sendRef.current({ type: 'note_on', channel: activeDeckRef.current, note, velocity: 127 })
              } else if (!isActive && was) {
                activePadsRef.current.delete(note)
                sendRef.current({ type: 'note_off', channel: activeDeckRef.current, note })
              }
              if (isActive) labelSet.add(label)
            }
          }
        }

        // --- デッキ切り替えジェスチャー検出（グー3秒でトグル） ---
        // PAD/つまみ操作中は無視
        if (activePadsRef.current.size === 0 && grabbedKnobRef.current < 0) {
          const isFist = countExtendedFingers(landmarks) === 0
          if (isFist) {
            if (deckGestureRef.current === 'none') {
              deckGestureRef.current      = 'holding'
              deckGestureStartRef.current = now
            }
          } else {
            // グー解放 → 状態リセット
            deckGestureRef.current      = 'none'
            deckGestureStartRef.current = null
          }
        }

        // スケルトン描画
        ctx.save()
        ctx.strokeStyle = 'rgba(0,255,255,0.5)'
        ctx.lineWidth   = 2
        for (const [a, b] of CONNECTIONS) {
          ctx.beginPath()
          ctx.moveTo(landmarks[a].x * canvas.width, landmarks[a].y * canvas.height)
          ctx.lineTo(landmarks[b].x * canvas.width, landmarks[b].y * canvas.height)
          ctx.stroke()
        }

        // 人差し指先端ドット（ホバー中は強調）
        ctx.beginPath()
        ctx.arc(index.x * canvas.width, index.y * canvas.height, hoveredKnob >= 0 ? 10 : 5, 0, Math.PI * 2)
        ctx.fillStyle = hoveredKnob >= 0 ? 'white' : 'rgba(255,255,255,0.5)'
        ctx.fill()

        // 親指先端ドット
        ctx.beginPath()
        ctx.arc(thumb.x * canvas.width, thumb.y * canvas.height, 7, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.7)'
        ctx.fill()

        // PAD ピンチライン描画（グー・フェーダーゾーン外でのみ）
        const drawIsFist = countExtendedFingers(landmarks) === 0
        if (!drawIsFist && index.y >= 0.4) {
          let drawBestNote = -1, drawBestDist = PINCH_THRESH
          for (const { fingerTip, note } of PAD_CONFIG) {
            const dist = Math.hypot(thumb.x - landmarks[fingerTip].x, thumb.y - landmarks[fingerTip].y)
            if (dist < drawBestDist) { drawBestDist = dist; drawBestNote = note }
          }
          for (const { fingerTip, note, color } of PAD_CONFIG) {
            const tip    = landmarks[fingerTip]
            const active = note === drawBestNote
            ctx.strokeStyle = active ? color : 'rgba(255,255,255,0.1)'
            ctx.lineWidth   = active ? 3 : 1
            ctx.beginPath()
            ctx.moveTo(thumb.x * canvas.width, thumb.y * canvas.height)
            ctx.lineTo(tip.x   * canvas.width, tip.y   * canvas.height)
            ctx.stroke()
          }
        }
        ctx.restore()
      }

      // 仮想フェーダー描画（毎フレーム）
      drawFaders(ctx, canvas.width, canvas.height, hoveredKnob)

      // デッキ切り替えプログレス描画（'holding' または 'completed'）
      if (deckGestureRef.current !== 'none' && deckGestureStartRef.current !== null) {
        const nextDeck = activeDeckRef.current === 0 ? 1 : 0
        const elapsed  = now - deckGestureStartRef.current
        const progress = Math.min(1, elapsed / DECK_HOLD_MS)
        const cx = canvas.width  * 0.5
        const cy = canvas.height * 0.5
        const r  = 48

        // 背景円
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.fill()

        // プログレスアーク
        ctx.beginPath()
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress)
        ctx.strokeStyle = '#fbbf24'
        ctx.lineWidth   = 5
        ctx.stroke()

        // ラベル
        ctx.font      = 'bold 15px sans-serif'
        ctx.fillStyle = 'white'
        ctx.textAlign = 'center'
        ctx.fillText(`→ DECK ${nextDeck + 1}`, cx, cy - 6)
        ctx.font      = '11px sans-serif'
        ctx.fillStyle = 'rgba(255,255,255,0.7)'
        if (deckGestureRef.current === 'completed') {
          ctx.fillText('✓ 完了', cx, cy + 12)
        } else {
          ctx.fillText(`${Math.ceil((DECK_HOLD_MS - elapsed) / 1000)}s`, cx, cy + 12)
        }

        // 3秒経過で確定（'holding' → 'completed'）
        if (deckGestureRef.current === 'holding' && elapsed >= DECK_HOLD_MS) {
          activeDeckRef.current = nextDeck
          setActiveDeck(nextDeck)
          deckGestureRef.current = 'completed'
        }
      }

      // デッキインジケーター（左下）
      ctx.font      = 'bold 17px sans-serif'
      ctx.fillStyle = 'rgba(251,191,36,0.9)'
      ctx.textAlign = 'left'
      ctx.fillText(`DECK ${activeDeckRef.current + 1}`, 12, canvas.height - 12)

      setActiveLabels([...labelSet])
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [isReady])

  return (
    <div className="relative w-screen bg-black overflow-hidden font-sans" style={{ height: '100dvh' }}>

      <video ref={videoRef} autoPlay playsInline muted
        className="absolute inset-0 w-full h-full object-cover" />

      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* アクティブ表示 */}
      {activeLabels.length > 0 && (
        <div className="absolute top-20 left-0 right-0 flex justify-center pointer-events-none">
          <span className="bg-black/50 text-white text-2xl font-bold px-5 py-2 rounded-2xl">
            {activeLabels.join('  ')}
          </span>
        </div>
      )}

      {/* ヘッダー */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <LinkButton href="/">← コントローラーに戻る</LinkButton>
        <span className="text-white text-sm font-bold">ARモード</span>
      </div>

      {/* フッター */}
      <div className="absolute bottom-0 left-0 right-0 px-4 py-3 bg-gradient-to-t from-black/70 to-transparent">
        {failed && (
          <p className="text-center text-xs text-red-400 mb-2">
            サーバーに接続できませんでした
          </p>
        )}
        <div className="flex flex-col items-center gap-3">
          <ARControlButtons activeDeck={activeDeck} send={send} />
          <ConnectButton
            disabled={status === 'connecting'}
            status={status}
            onClick={connect}
            size="small"
          />
        </div>
      </div>

      {/* 読み込み */}
      {(loadingMsg || !isReady) && !cameraError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-3">
          <div className="text-white text-lg">{loadingMsg || '初期化中...'}</div>
          <div className="text-gray-400 text-sm">初回は10秒ほどかかります</div>
        </div>
      )}

      {/* カメラエラー */}
      {cameraError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 gap-4 px-8 text-center">
          <p className="text-red-400">{cameraError}</p>
          <LinkButton href="/">タッチUIに戻る</LinkButton>
        </div>
      )}
    </div>
  )
}

function ARControlButtons({ activeDeck, send }: { activeDeck: number; send: (msg: any) => void }) {
  const [cuePressedRef, setCuePressed] = useState(false)
  const [playPressedRef, setPlayPressed] = useState(false)

  return (
    <div className="flex gap-3">
      <button
        className={`w-12 h-12 rounded-full text-xs font-semibold select-none touch-none border border-gray-700
                    transition-all duration-75
                    ${cuePressedRef ? 'bg-gray-400 scale-95 text-gray-950' : 'bg-gray-800 text-gray-200'}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setCuePressed(true)
          send({ type: 'note_on', channel: activeDeck, note: 47, velocity: 127 })
        }}
        onPointerUp={() => { setCuePressed(false); send({ type: 'note_off', channel: activeDeck, note: 47 }) }}
        onPointerCancel={() => { setCuePressed(false); send({ type: 'note_off', channel: activeDeck, note: 47 }) }}
      >
        CUE
      </button>
      <button
        className={`w-12 h-12 rounded-full text-sm font-semibold select-none touch-none border border-gray-700
                    transition-all duration-75
                    ${playPressedRef ? 'bg-gray-400 scale-95 text-gray-950' : 'bg-gray-800 text-gray-200'}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setPlayPressed(true)
          send({ type: 'note_on', channel: activeDeck, note: 0, velocity: 127 })
        }}
        onPointerUp={() => { setPlayPressed(false); send({ type: 'note_off', channel: activeDeck, note: 0 }) }}
        onPointerCancel={() => { setPlayPressed(false); send({ type: 'note_off', channel: activeDeck, note: 0 }) }}
      >
        START
      </button>
    </div>
  )
}
