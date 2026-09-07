// PC 常駐の MIDI ブリッジ。
// サーバ (ローカルでもクラウドでも) に繋ぎ、届いた MIDI を手元のポートへ出す。
// MIDI を扱うのはこのプロセスだけで、サーバ側はリレーに徹する。

const { io } = require('socket.io-client')
const { createMidiOut } = require('./midi')

const SERVER = process.env.SERVER_URL || 'https://localhost:3000'
const ROOM   = (process.env.DJ_ROOM || '').trim().toUpperCase()

const midiOut = createMidiOut()
const state = () => ({ ...midiOut.state(), ports: midiOut.ports() })

// 自分が鳴らした音を覚えておき、切断時に必ず戻す
const activeNotes  = new Set()
const bentChannels = new Set()
const PITCH_CENTER = 8192

function track(b) {
  const status = b[0] & 0xf0
  const ch = b[0] & 0x0f
  if (status === 0x90 && b[2] > 0) activeNotes.add(`${ch}:${b[1]}`)
  else if (status === 0x90 || status === 0x80) activeNotes.delete(`${ch}:${b[1]}`)
  else if (status === 0xe0) {
    const v = (b[2] << 7) | b[1]
    if (v === PITCH_CENTER) bentChannels.delete(ch)
    else bentChannels.add(ch)
  }
}

// サーバとの接続が切れても、鳴りっぱなしにしない
function panic() {
  if (activeNotes.size === 0 && bentChannels.size === 0) return
  console.log(`  [!] 鳴っている音を戻します (note:${activeNotes.size} bend:${bentChannels.size})`)
  for (const key of activeNotes) {
    const [ch, note] = key.split(':').map(Number)
    midiOut.send(Uint8Array.from([0x80 | ch, note, 0]))
  }
  for (const ch of bentChannels) {
    midiOut.send(Uint8Array.from([0xe0 | ch, PITCH_CENTER & 0x7f, (PITCH_CENTER >> 7) & 0x7f]))
  }
  activeNotes.clear()
  bentChannels.clear()
}

console.log('\n=== どこでもDJ ブリッジ ===')
console.log(`接続先: ${SERVER}`)

const socket = io(SERVER, {
  query: { role: 'bridge', room: ROOM },
  transports: ['websocket'],
  rejectUnauthorized: false,   // ローカルの自己署名証明書
})

socket.on('connect', () => {
  console.log('サーバに接続しました')
  socket.emit('midiport', state())
})

socket.on('room', ({ code, joinUrl }) => {
  // 再接続時も同じルームへ戻る (次のハンドシェイクに持たせる)
  socket.io.opts.query = { ...socket.io.opts.query, room: code }
  console.log(`\nルームコード: ${code}`)
  if (joinUrl) console.log(`モニタ: ${joinUrl}`)
  if (midiOut.portName) {
    console.log(`MIDI 出力: ${midiOut.portName}${midiOut.virtual ? ' (仮想ポート)' : ''}`)
    if (midiOut.virtual) console.log('  DJソフトの MIDI 設定でこのポートを選んでください')
  }
})

socket.on('roomerror', ({ reason }) => {
  console.log(reason === 'busy'
    ? `  [!] ルーム ${ROOM} には既に別のブリッジが繋がっています`
    : `  [!] ルーム ${ROOM} が見つかりません。モニタ画面のコードを確認してください`)
  process.exit(1)
})

socket.on('midi', (msg) => {
  if (!ArrayBuffer.isView(msg)) return
  track(msg)
  midiOut.send(msg)
})

// モニタからのポート操作
socket.on('midiports', () => socket.emit('midiport', state()))

socket.on('setmidiport', (name) => {
  panic()
  try {
    midiOut.open(name || undefined)
    console.log(`MIDI 出力を切り替え: ${midiOut.portName}${midiOut.virtual ? ' (仮想ポート)' : ''}`)
    socket.emit('midiport', state())
  } catch (e) {
    // 開けなかったときは無音にせず仮想ポートへ戻す
    console.log(`  [!] ${e.message}。仮想ポートへ戻します`)
    try { midiOut.open() } catch { /* 仮想ポートも開けない */ }
    socket.emit('midiport', { ...state(), error: e.message })
  }
})

socket.on('disconnect', () => { console.log('サーバから切断しました'); panic() })
socket.on('connect_error', (e) => console.log(`  [!] 接続できません: ${e.message}`))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { panic(); midiOut.close(); process.exit(0) })
}
