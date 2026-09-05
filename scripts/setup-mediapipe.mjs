// MediaPipeのWASMとモデルをpublic/へ配置する (ARのオフライン動作用)
import { cp, mkdir, stat } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'

const WASM_SRC  = 'node_modules/@mediapipe/tasks-vision/wasm'
const WASM_DEST = 'public/mediapipe/wasm'
const MODEL_DEST = 'public/models/hand_landmarker.task'
const MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const exists = async (p) => stat(p).then(() => true, () => false)

if (!(await exists(WASM_SRC))) {
  console.error('[mediapipe] @mediapipe/tasks-vision が見つかりません。npm install を先に実行してください')
  process.exit(0)
}

await mkdir(WASM_DEST, { recursive: true })
await cp(WASM_SRC, WASM_DEST, { recursive: true })
console.log(`[mediapipe] WASMを配置: ${WASM_DEST}`)

if (await exists(MODEL_DEST)) {
  console.log('[mediapipe] モデルは配置済み')
} else {
  await mkdir('public/models', { recursive: true })
  console.log('[mediapipe] モデルをダウンロード中...')
  const res = await fetch(MODEL_URL)
  if (!res.ok) {
    console.error(`[mediapipe] ダウンロード失敗 (${res.status})。ネット接続時に再実行してください`)
    process.exit(1)
  }
  await writeFile(MODEL_DEST, Buffer.from(await res.arrayBuffer()))
  console.log(`[mediapipe] モデルを配置: ${MODEL_DEST}`)
}
