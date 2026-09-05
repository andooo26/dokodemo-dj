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

  // MIDIポートとモニタの両方へ送る
  const deliver = (msg) => {
    if (ArrayBuffer.isView(msg)) midiOut.send(msg)
    io.to('output').emit('midi', msg)
    logMidi(msg)
  }

  // 鳴っている音と動かされたベンドを覚えておく
  const activeNotes = new Set()
  const bentChannels = new Set()
  const PITCH_CENTER = 8192

  const track = (b) => {
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

  // スマホが全部切れたら、鳴りっぱなしを解放する
  const releaseAll = () => {
    if (activeNotes.size === 0 && bentChannels.size === 0) return
    console.log(`  [!] 未解放の音を戻します (note:${activeNotes.size} bend:${bentChannels.size})`)

    for (const key of activeNotes) {
      const [ch, note] = key.split(':').map(Number)
      deliver(Uint8Array.from([0x80 | ch, note, 0]))
    }
    for (const ch of bentChannels) {
      deliver(Uint8Array.from([0xe0 | ch, PITCH_CENTER & 0x7f, (PITCH_CENTER >> 7) & 0x7f]))
    }
    activeNotes.clear()
    bentChannels.clear()
  }

  // 3バイトのMIDIでも旧来のJSONでもログに出せるようにする
  const logMidi = (msg) => {
    const b = ArrayBuffer.isView(msg) ? msg : null
    const m = b
      ? { status: b[0] & 0xf0, channel: b[0] & 0x0f, d1: b[1], d2: b[2] }
      : null
    const ch = (m ? m.channel : (msg.channel ?? 0)) + 1

    if (m) {
      if      (m.status === 0x90) console.log(`  ↑ Note On   ch:${ch} note:${m.d1} vel:${m.d2}`)
      else if (m.status === 0x80) console.log(`  ↓ Note Off  ch:${ch} note:${m.d1}`)
      else if (m.status === 0xb0) console.log(`  ~ CC        ch:${ch} cc:${m.d1} val:${m.d2}`)
      else if (m.status === 0xe0) console.log(`  ~ Pitch     ch:${ch} val:${(m.d2 << 7) | m.d1}`)
      return
    }
    if      (msg.type === 'note_on')    console.log(`  ↑ Note On   ch:${ch} note:${msg.note} vel:${msg.velocity}`)
    else if (msg.type === 'note_off')   console.log(`  ↓ Note Off  ch:${ch} note:${msg.note}`)
    else if (msg.type === 'cc')         console.log(`  ~ CC        ch:${ch} cc:${msg.controller} val:${msg.value}`)
    else if (msg.type === 'pitch_bend') console.log(`  ~ Pitch     ch:${ch} val:${msg.value}`)
  }

  // 現在のポートと選べる一覧
  const midiState = () => ({ ...midiOut.state(), ports: midiOut.ports() })

  // controller の接続数を output に通知する
  const controllerCount = () => io.sockets.adapter.rooms.get('controller')?.size ?? 0
  const notifyControllers = () => io.to('output').emit('controllers', controllerCount())

  io.on('connection', (socket) => {
    const role = socket.handshake.query.role || 'unknown'
    console.log(`[+] ${role} connected  (${socket.id})`)
    socket.join(role)
    if (role === 'output') {
      socket.emit('controllers', controllerCount())
      socket.emit('midiport', midiState())
    }
    else notifyControllers()

    // ポート一覧の取り直し (機材を後から挿した場合)
    socket.on('midiports', () => socket.emit('midiport', midiState()))

    // output からのポート切り替え。name が空なら仮想ポート
    socket.on('setmidiport', (name) => {
      releaseAll()
      try {
        midiOut.open(name || undefined)
        console.log(`MIDI 出力を切り替え: ${midiOut.portName}${midiOut.virtual ? ' (仮想ポート)' : ''}`)
        io.to('output').emit('midiport', midiState())
      } catch (e) {
        // 開けなかったときは無音にせず仮想ポートへ戻す
        console.log(`  [!] ${e.message}。仮想ポートへ戻します`)
        try { midiOut.open() } catch { /* 仮想ポートも開けない */ }
        io.to('output').emit('midiport', { ...midiState(), error: e.message })
      }
    })

    socket.on('midi', (msg) => {
      if (ArrayBuffer.isView(msg)) track(msg)
      deliver(msg)
    })

    socket.on('disconnect', () => {
      console.log(`[-] ${role} disconnected (${socket.id})`)
      if (role === 'output') return
      notifyControllers()
      if (controllerCount() === 0) releaseAll()
    })
  })

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { releaseAll(); midiOut.close(); process.exit(0) })
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

    console.log(`\nスマホ (コントローラー): ${scheme}://${HOST}:${port}/touch`)
    console.log(`スマホ (AR モード):      ${scheme}://${HOST}:${port}/ar`)
    console.log(`PC Chrome (モニタ):     ${scheme}://localhost:${port}/output`)

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
