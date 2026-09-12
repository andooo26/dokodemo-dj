// サーバと MIDI ブリッジをまとめて起動する (ローカル開発用)
import { spawn } from 'node:child_process'

const procs = [
  { name: 'server', args: ['server.js'] },
  { name: 'bridge', args: ['bridge/index.js'] },
].map(({ name, args }) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
  p.on('exit', (code) => {
    if (code) console.log(`[${name}] 終了しました (code ${code})`)
    shutdown()
  })
  return p
})

let closing = false
function shutdown() {
  if (closing) return
  closing = true
  for (const p of procs) { try { p.kill('SIGINT') } catch { /* 既に終了 */ } }
  setTimeout(() => process.exit(0), 500)
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown)
