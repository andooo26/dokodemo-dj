'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import { useMidiBridge } from '@/hooks/useMidiBridge'
import type { HandLandmarker } from '@mediapipe/tasks-vision'

// --- MediaPipe config ---

const WASM_PATH  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

// --- PAD config ---

const PINCH_THRESHOLD = 0.07

const PAD_CONFIG = [
  { fingerTip: 8,  note: 36, label: 'PAD 1', color: '#60a5fa' },
  { fingerTip: 12, note: 37, label: 'PAD 2', color: '#34d399' },
  { fingerTip: 16, note: 38, label: 'PAD 3', color: '#f97316' },
  { fingerTip: 20, note: 39, label: 'PAD 4', color: '#a78bfa' },
] as const

const FINGER_NAMES: Record<number, string> = { 8: '人差し指', 12: '中指', 16: '薬指', 20: '小指' }

// MediaPipe hand skeleton connections
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
  const videoRef      = useRef<HTMLVideoElement>(null)
  const canvasRef     = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const rafRef        = useRef<number>(0)
  const activePadsRef = useRef<Set<number>>(new Set())
  const activeDeckRef = useRef(0)

  const [isReady, setIsReady]           = useState(false)
  const [loadingMsg, setLoadingMsg]     = useState('カメラを起動中...')
  const [cameraError, setCameraError]   = useState('')
  const [activeLabels, setActiveLabels] = useState<string[]>([])

  const { status, connect, send } = useMidiBridge()

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
        if (!cancelled) {
          landmarkerRef.current = hl
          setIsReady(true)
          setLoadingMsg('')
        }
      } catch (e) {
        if (!cancelled) setLoadingMsg('MediaPipe の読み込みに失敗しました')
      }
    }
    init()
    return () => { cancelled = true }
  }, [])

  // カメラ起動
  useEffect(() => {
    let stream: MediaStream | null = null
    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        if (videoRef.current) videoRef.current.srcObject = stream
      } catch {
        setCameraError('カメラへのアクセスが拒否されました。HTTPS 環境で開いてください。')
      }
    }
    startCamera()
    return () => { stream?.getTracks().forEach(t => t.stop()) }
  }, [])

  // rAF ループ
  const sendRef = useRef(send)
  useEffect(() => { sendRef.current = send }, [send])

  useEffect(() => {
    if (!isReady) return

    const labelSet = new Set<string>()

    function loop(now: number) {
      rafRef.current = requestAnimationFrame(loop)

      const video     = videoRef.current
      const canvas    = canvasRef.current
      const landmarker = landmarkerRef.current
      if (!video || !canvas || !landmarker || video.readyState < 2) return

      // canvas サイズ同期
      const vw = video.videoWidth  || 640
      const vh = video.videoHeight || 480
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width  = vw
        canvas.height = vh
      }

      const results = landmarker.detectForVideo(video, now)
      const ctx     = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      ctx.save()

      labelSet.clear()

      for (const landmarks of results.landmarks) {
        // スケルトン描画
        ctx.strokeStyle = 'rgba(0,255,255,0.5)'
        ctx.lineWidth   = 2
        for (const [a, b] of CONNECTIONS) {
          ctx.beginPath()
          ctx.moveTo(landmarks[a].x * canvas.width, landmarks[a].y * canvas.height)
          ctx.lineTo(landmarks[b].x * canvas.width, landmarks[b].y * canvas.height)
          ctx.stroke()
        }

        const thumb = landmarks[4] // 親指先端

        // PAD ピンチ検出
        for (const { fingerTip, note, label, color } of PAD_CONFIG) {
          const tip    = landmarks[fingerTip]
          const dist   = Math.hypot(thumb.x - tip.x, thumb.y - tip.y)
          const active = dist < PINCH_THRESHOLD
          const was    = activePadsRef.current.has(note)

          if (active && !was) {
            activePadsRef.current.add(note)
            sendRef.current({ type: 'note_on', channel: activeDeckRef.current, note, velocity: 127 })
          } else if (!active && was) {
            activePadsRef.current.delete(note)
            sendRef.current({ type: 'note_off', channel: activeDeckRef.current, note })
          }

          // 親指〜指先ライン
          ctx.strokeStyle = active ? color : 'rgba(255,255,255,0.15)'
          ctx.lineWidth   = active ? 4 : 1
          ctx.beginPath()
          ctx.moveTo(thumb.x * canvas.width, thumb.y * canvas.height)
          ctx.lineTo(tip.x   * canvas.width, tip.y   * canvas.height)
          ctx.stroke()

          // 指先ドット
          ctx.fillStyle = active ? color : 'rgba(255,255,255,0.3)'
          ctx.beginPath()
          ctx.arc(tip.x * canvas.width, tip.y * canvas.height, active ? 8 : 5, 0, Math.PI * 2)
          ctx.fill()

          // ピンチ中はラベル表示
          if (active) {
            labelSet.add(label)
            ctx.fillStyle = color
            ctx.font      = 'bold 20px sans-serif'
            ctx.fillText(label, tip.x * canvas.width + 10, tip.y * canvas.height - 10)
          }
        }

        // 親指先端ドット
        ctx.fillStyle = 'white'
        ctx.beginPath()
        ctx.arc(thumb.x * canvas.width, thumb.y * canvas.height, 8, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()

      // 手が消えたらすべて note_off
      if (results.landmarks.length === 0 && activePadsRef.current.size > 0) {
        for (const note of activePadsRef.current) {
          sendRef.current({ type: 'note_off', channel: activeDeckRef.current, note })
        }
        activePadsRef.current.clear()
      }

      setActiveLabels([...labelSet])
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [isReady])

  const sockColor = status === 'connected' ? 'text-green-400' : 'text-gray-400'

  return (
    <div className="relative w-screen bg-black overflow-hidden font-sans" style={{ height: '100dvh' }}>

      {/* カメラ映像 */}
      <video
        ref={videoRef}
        autoPlay playsInline muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* canvas オーバーレイ */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
      />

      {/* アクティブジェスチャー */}
      {activeLabels.length > 0 && (
        <div className="absolute top-20 left-0 right-0 flex justify-center pointer-events-none">
          <span className="bg-black/50 text-white text-2xl font-bold px-5 py-2 rounded-2xl">
            {activeLabels.join('  ')}
          </span>
        </div>
      )}

      {/* ヘッダー */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <Link href="/" className="px-3 py-1.5 rounded-xl bg-gray-800/80 text-white text-sm border border-gray-700">
          ← コントローラーに戻る
        </Link>
        <span className="text-white text-sm font-bold">ARモード</span>
      </div>

      {/* フッター */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-t from-black/70 to-transparent">
        <span className={`text-sm ${sockColor}`}>● {status}</span>
        <button
          onClick={connect}
          className="px-3 py-1.5 rounded-xl bg-gray-800/80 text-white text-sm border border-gray-700"
        >
          {status === 'connected' ? '再接続' : '接続'}
        </button>
      </div>

      {/* PAD ガイド */}
      <div className="absolute right-3 bottom-16 space-y-1 pointer-events-none">
        {PAD_CONFIG.map(({ label, color, fingerTip }) => (
          <div key={label} className="flex items-center gap-1.5 text-xs">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-gray-300">{label}: 親指+{FINGER_NAMES[fingerTip]}</span>
          </div>
        ))}
      </div>

      {/* 読み込みオーバーレイ */}
      {(loadingMsg || !isReady) && !cameraError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-3">
          <div className="text-white text-lg">{loadingMsg || '初期化中...'}</div>
          <div className="text-gray-400 text-sm">初回は10秒ほどかかります</div>
        </div>
      )}

      {/* カメラエラー */}
      {cameraError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 gap-4 px-8 text-center">
          <p className="text-red-400 text-base">{cameraError}</p>
          <Link href="/" className="px-4 py-2 rounded-xl bg-gray-800 text-white text-sm border border-gray-700">
            タッチUIに戻る
          </Link>
        </div>
      )}
    </div>
  )
}
