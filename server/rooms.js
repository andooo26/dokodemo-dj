// セッション (ルーム) の管理。
// 1ルーム = 1つのDJセット。スマホとモニタは同じコードを持つ者だけが入れる。

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  // 紛らわしい文字は除く
const CODE_LEN   = 4
const EMPTY_TTL  = 10 * 60 * 1000  // 誰も居なくなってから保持する時間

function randomCode() {
  return Array.from({ length: CODE_LEN }, () =>
    CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
}

// 入力されたコードを正規化する。形式が違えば null
function normalize(value) {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return /^[A-Z0-9]{4,8}$/.test(code) ? code : null
}

function createRoomStore() {
  const rooms = new Map()

  const newRoom = (code) => ({
    code,
    bridge:       null,        // MIDIを出すPC側のプロセス
    midiport:     null,        // ブリッジから届いた最新のポート状態
    activeNotes:  new Set(),   // 鳴りっぱなし防止用
    bentChannels: new Set(),
    emptySince:   Date.now(),
  })

  function create() {
    let code = randomCode()
    while (rooms.has(code)) code = randomCode()
    rooms.set(code, newRoom(code))
    return rooms.get(code)
  }

  // 掃除。誰も居ないまま EMPTY_TTL を過ぎた部屋を消す
  function sweep(isEmpty) {
    const now = Date.now()
    for (const [code, room] of rooms) {
      if (!isEmpty(code)) { room.emptySince = 0; continue }
      if (!room.emptySince) { room.emptySince = now; continue }
      if (now - room.emptySince > EMPTY_TTL) rooms.delete(code)
    }
  }

  return {
    create,
    get:  (code) => rooms.get(code) ?? null,
    has:  (code) => rooms.has(code),
    size: () => rooms.size,
    codes: () => Array.from(rooms.keys()),
    sweep,
  }
}

module.exports = { createRoomStore, normalize, randomCode, CODE_LEN, EMPTY_TTL }
