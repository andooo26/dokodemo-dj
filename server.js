// Next.js サーバ + Socket.io リレー。
// 証明書は mkcert があれば自動生成し、無ければ HTTP で起動する。

const { createServer } = require('https')
const { createServer: createHttpServer } = require('http')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs')
const { execFileSync } = require('child_process')
const { parse } = require('url')
const os = require('os')
const path = require('path')
const next = require('next')
const { Server } = require('socket.io')
const { createMidiOut } = require('./server/midi')
const { isAllowed, createRateLimiter } = require('./server/policy')
const { createRoomStore, normalize } = require('./server/rooms')

const dev  = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT || '3000', 10)

const CERT_DIR  = path.join(__dirname, 'certs')
const KEY_FILE  = path.join(CERT_DIR, 'dev-key.pem')
const CERT_FILE = path.join(CERT_DIR, 'dev.pem')
const SANS_FILE = path.join(CERT_DIR, '.sans')

// ネットワーク情報

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
}

const LAN_IPS   = lanAddresses()
const MDNS_NAME = `${os.hostname().replace(/\.local$/i, '')}.local`
const HOST      = LAN_IPS[0] || 'localhost'

// 証明書

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function mkcertCaRoot() {
  try {
    return run('mkcert', ['-CAROOT'])
  } catch {
    return null // mkcert が無い
  }
}

// 証明書に含めるホスト名
function wantedSans() {
  return ['localhost', '127.0.0.1', '::1', MDNS_NAME, ...LAN_IPS]
}

function setupCert() {
  const caRoot = mkcertCaRoot()
  if (!caRoot) return { ok: false, reason: 'mkcert-missing' }

  const rootCA = path.join(caRoot, 'rootCA.pem')
  if (!existsSync(rootCA)) return { ok: false, reason: 'ca-not-installed', caRoot }

  const sans    = wantedSans()
  const current = existsSync(SANS_FILE) ? readFileSync(SANS_FILE, 'utf8') : ''
  const fresh   = existsSync(KEY_FILE) && existsSync(CERT_FILE) && current === sans.join(',')

  if (!fresh) {
    mkdirSync(CERT_DIR, { recursive: true })
    console.log(existsSync(CERT_FILE)
      ? '  IP が変わったため証明書を再発行します...'
      : '  証明書を生成します...')
    run('mkcert', ['-key-file', KEY_FILE, '-cert-file', CERT_FILE, ...sans])
    writeFileSync(SANS_FILE, sans.join(','))
  }

  return {
    ok: true,
    rootCA,
    ssl: { key: readFileSync(KEY_FILE), cert: readFileSync(CERT_FILE) },
  }
}

console.log('\n=== どこでもDJ ===')
const cert   = setupCert()
const scheme = cert.ok ? 'https' : 'http'

// サーバ

const midiOut = createMidiOut()

const app    = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const handler = (req, res) => {
    // スマホ用にルート CA を配る
    if (cert.ok && parse(req.url).pathname === '/rootCA.pem') {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="rootCA.pem"',
      })
      res.end(readFileSync(cert.rootCA))
      return
    }
    handle(req, res, parse(req.url, true))
  }

  const server = cert.ok ? createServer(cert.ssl, handler) : createHttpServer(handler)

  // HTTPS のときだけリダイレクトを用意する
  if (cert.ok) {
    createHttpServer((req, res) => {
      const host = (req.headers.host || HOST).replace(/:\d+$/, '')
      res.writeHead(301, { Location: `https://${host}:${port}${req.url}` })
      res.end()
    }).listen(port + 1, '0.0.0.0')
  }

  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  })

  const rooms = createRoomStore()
  const PITCH_CENTER = 8192

  // MIDIポートと、同じルームのモニタへ送る
  const deliver = (room, msg) => {
    if (ArrayBuffer.isView(msg)) midiOut.send(msg)
    io.to(`${room.code}:output`).emit('midi', msg)
    logMidi(room, msg)
  }

  // 鳴っている音と動かされたベンドをルームごとに覚えておく
  const track = (room, b) => {
    const status = b[0] & 0xf0
    const ch = b[0] & 0x0f
    if (status === 0x90 && b[2] > 0) room.activeNotes.add(`${ch}:${b[1]}`)
    else if (status === 0x90 || status === 0x80) room.activeNotes.delete(`${ch}:${b[1]}`)
    else if (status === 0xe0) {
      const v = (b[2] << 7) | b[1]
      if (v === PITCH_CENTER) room.bentChannels.delete(ch)
      else room.bentChannels.add(ch)
    }
  }

  // そのルームのスマホが全部切れたら、鳴りっぱなしを解放する
  const releaseAll = (room) => {
    if (room.activeNotes.size === 0 && room.bentChannels.size === 0) return
    console.log(`  [!] 未解放の音を戻します [${room.code}] (note:${room.activeNotes.size} bend:${room.bentChannels.size})`)

    for (const key of room.activeNotes) {
      const [ch, note] = key.split(':').map(Number)
      deliver(room, Uint8Array.from([0x80 | ch, note, 0]))
    }
    for (const ch of room.bentChannels) {
      deliver(room, Uint8Array.from([0xe0 | ch, PITCH_CENTER & 0x7f, (PITCH_CENTER >> 7) & 0x7f]))
    }
    room.activeNotes.clear()
    room.bentChannels.clear()
  }

  const releaseEverything = () => rooms.codes().forEach(c => releaseAll(rooms.get(c)))

  // 3バイトのMIDIでも旧来のJSONでもログに出せるようにする
  const logMidi = (room, msg) => {
    const b = ArrayBuffer.isView(msg) ? msg : null
    const m = b
      ? { status: b[0] & 0xf0, channel: b[0] & 0x0f, d1: b[1], d2: b[2] }
      : null
    const ch = (m ? m.channel : (msg.channel ?? 0)) + 1
    const tag = `[${room.code}]`

    if (m) {
      if      (m.status === 0x90) console.log(`  ${tag} ↑ Note On   ch:${ch} note:${m.d1} vel:${m.d2}`)
      else if (m.status === 0x80) console.log(`  ${tag} ↓ Note Off  ch:${ch} note:${m.d1}`)
      else if (m.status === 0xb0) console.log(`  ${tag} ~ CC        ch:${ch} cc:${m.d1} val:${m.d2}`)
      else if (m.status === 0xe0) console.log(`  ${tag} ~ Pitch     ch:${ch} val:${(m.d2 << 7) | m.d1}`)
      return
    }
    if      (msg.type === 'note_on')    console.log(`  ${tag} ↑ Note On   ch:${ch} note:${msg.note} vel:${msg.velocity}`)
    else if (msg.type === 'note_off')   console.log(`  ${tag} ↓ Note Off  ch:${ch} note:${msg.note}`)
    else if (msg.type === 'cc')         console.log(`  ${tag} ~ CC        ch:${ch} cc:${msg.controller} val:${msg.value}`)
    else if (msg.type === 'pitch_bend') console.log(`  ${tag} ~ Pitch     ch:${ch} val:${msg.value}`)
  }

  // 現在のポートと選べる一覧
  const midiState = () => ({ ...midiOut.state(), ports: midiOut.ports() })

  // ルーム内の controller の接続数を、同じルームの output に通知する
  const memberCount = (code, role) => io.sockets.adapter.rooms.get(`${code}:${role}`)?.size ?? 0
  const notifyControllers = (code) => io.to(`${code}:output`).emit('controllers', memberCount(code, 'controller'))

  // 誰も居ないルームを片付ける
  setInterval(() => rooms.sweep(code =>
    memberCount(code, 'controller') === 0 && memberCount(code, 'output') === 0), 60 * 1000).unref()

  io.on('connection', (socket) => {
    const role = socket.handshake.query.role || 'unknown'
    const asked = normalize(socket.handshake.query.room)

    // モニタはルームを持っていなければ発行する。スマホは既存ルームにしか入れない
    let room = asked ? rooms.get(asked) : null
    if (!room && role === 'output') room = rooms.create()

    if (!room) {
      console.log(`[x] ${role} rejected  (${socket.id}) room=${asked ?? '(なし)'}`)
      socket.emit('roomerror', { reason: asked ? 'unknown' : 'missing' })
      return
    }

    console.log(`[+] ${role} connected  (${socket.id}) [${room.code}]`)
    socket.join(`${room.code}:${role}`)
    socket.emit('room', { code: room.code })

    if (role === 'output') {
      socket.emit('controllers', memberCount(room.code, 'controller'))
      socket.emit('midiport', midiState())
    }
    else notifyControllers(room.code)

    // ポート一覧の取り直し (機材を後から挿した場合)
    socket.on('midiports', () => socket.emit('midiport', midiState()))

    // output からのポート切り替え。name が空なら仮想ポート
    socket.on('setmidiport', (name) => {
      if (role !== 'output') return
      releaseEverything()
      try {
        midiOut.open(name || undefined)
        console.log(`MIDI 出力を切り替え: ${midiOut.portName}${midiOut.virtual ? ' (仮想ポート)' : ''}`)
        io.emit('midiport', midiState())
      } catch (e) {
        // 開けなかったときは無音にせず仮想ポートへ戻す
        console.log(`  [!] ${e.message}。仮想ポートへ戻します`)
        try { midiOut.open() } catch { /* 仮想ポートも開けない */ }
        io.emit('midiport', { ...midiState(), error: e.message })
      }
    })

    // 想定外のバイト列と流し込みを入口で止める
    const allowRate = createRateLimiter()
    let dropped = 0
    const drop = (why) => {
      dropped += 1
      if (dropped === 1 || dropped % 500 === 0) console.log(`  [!] ${why} (${socket.id} 累計${dropped}件)`)
    }

    socket.on('midi', (msg) => {
      if (role !== 'controller') return
      if (!isAllowed(msg)) return drop('未対応のMIDIを破棄しました')
      if (!allowRate())    return drop('MIDIの送信が多すぎるため破棄しました')
      track(room, msg)
      deliver(room, msg)
    })

    socket.on('disconnect', () => {
      console.log(`[-] ${role} disconnected (${socket.id}) [${room.code}]`)
      if (role === 'output') return
      notifyControllers(room.code)
      if (memberCount(room.code, 'controller') === 0) releaseAll(room)
    })
  })

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { releaseEverything(); midiOut.close(); process.exit(0) })
  }

  server.listen(port, '0.0.0.0', () => {
    if (!cert.ok) {
      console.log(cert.reason === 'mkcert-missing'
        ? '\n  [!] mkcert が見つからないため HTTP で起動しました。'
        : `\n  [!] mkcert のルート CA が未インストールのため HTTP で起動しました。\n      ${'mkcert -install'} を実行してから再起動してください。`)
      console.log('      HTTP ではスマホのカメラが使えません。次のどちらかで HTTPS 化してください:')
      console.log('        brew install mkcert && mkcert -install   … LAN 内で完結 (推奨)')
      console.log(`        cloudflared tunnel --url http://localhost:${port}   … 証明書のインストール不要`)
    }

    console.log(`\nPC Chrome (モニタ):     ${scheme}://localhost:${port}/output`)
    console.log('  モニタを開くとルームコードとQRが出ます。スマホはそれを読んで接続してください')
    console.log(`スマホ (コントローラー): ${scheme}://${HOST}:${port}/touch?room=コード`)
    console.log(`スマホ (AR モード):      ${scheme}://${HOST}:${port}/ar?room=コード`)

    if (midiOut.portName) {
      console.log(`\nMIDI 出力: ${midiOut.portName}${midiOut.virtual ? ' (仮想ポート)' : ''}`)
      if (midiOut.virtual) console.log('  DJソフトの MIDI 設定でこのポートを選んでください')
      const ports = midiOut.ports()
      if (ports.length) console.log(`  既存ポート: ${ports.join(', ')}`)
      console.log('  別のポートに出す場合: モニタ画面のプルダウン、または MIDI_PORT="ポート名の一部" npm run dev')
    }

    if (cert.ok) {
      console.log(`\nスマホで警告が出る場合はルート CA をインストール:`)
      console.log(`  ${scheme}://${HOST}:${port}/rootCA.pem`)
      console.log(`  (iOS: 開いた後 設定 → 一般 → VPN とデバイス管理 → プロファイル、`)
      console.log(`        さらに 設定 → 一般 → 情報 → 証明書信頼設定 で有効化)`)
      if (LAN_IPS.length) console.log(`\nIP が変わっても使える名前: ${scheme}://${MDNS_NAME}:${port}/`)
    }
    console.log('')
  })
})
