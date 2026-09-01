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

  // controller の接続数を output に通知する
  const controllerCount = () => io.sockets.adapter.rooms.get('controller')?.size ?? 0
  const notifyControllers = () => io.to('output').emit('controllers', controllerCount())

  io.on('connection', (socket) => {
    const role = socket.handshake.query.role || 'unknown'
    console.log(`[+] ${role} connected  (${socket.id})`)
    socket.join(role)
    if (role === 'output') socket.emit('controllers', controllerCount())
    else notifyControllers()

    socket.on('midi', (msg) => {
      io.to('output').emit('midi', msg)

      const ch = ((msg.channel ?? 0) + 1)
      if      (msg.type === 'note_on')    console.log(`  ↑ Note On   ch:${ch} note:${msg.note} vel:${msg.velocity}`)
      else if (msg.type === 'note_off')   console.log(`  ↓ Note Off  ch:${ch} note:${msg.note}`)
      else if (msg.type === 'cc')         console.log(`  ~ CC        ch:${ch} cc:${msg.controller} val:${msg.value}`)
      else if (msg.type === 'pitch_bend') console.log(`  ~ Pitch     ch:${ch} val:${msg.value}`)
    })

    socket.on('disconnect', () => {
      console.log(`[-] ${role} disconnected (${socket.id})`)
      if (role !== 'output') notifyControllers()
    })
  })

  server.listen(port, '0.0.0.0', () => {
    if (!cert.ok) {
      console.log(cert.reason === 'mkcert-missing'
        ? '\n  [!] mkcert が見つからないため HTTP で起動しました。'
        : `\n  [!] mkcert のルート CA が未インストールのため HTTP で起動しました。\n      ${'mkcert -install'} を実行してから再起動してください。`)
      console.log('      HTTP ではスマホのカメラ / Web MIDI が使えません。次のどちらかで HTTPS 化してください:')
      console.log('        brew install mkcert && mkcert -install   … LAN 内で完結 (推奨)')
      console.log(`        cloudflared tunnel --url http://localhost:${port}   … 証明書のインストール不要`)
    }

    console.log(`\nスマホ (コントローラー): ${scheme}://${HOST}:${port}/touch`)
    console.log(`スマホ (AR モード):      ${scheme}://${HOST}:${port}/ar`)
    console.log(`PC Chrome (MIDI 出力):  ${scheme}://localhost:${port}/output`)

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
