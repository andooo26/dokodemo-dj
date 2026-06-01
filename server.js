// Custom Next.js server with embedded Socket.io relay.
// MIDI output happens in the PC browser via Web MIDI API (/output page).

const { createServer } = require('https')
const { createServer: createHttpServer } = require('http')
const { readFileSync } = require('fs')
const { parse } = require('url')
const path = require('path')
const next = require('next')
const { Server } = require('socket.io')

const dev  = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT || '3000', 10)

const ssl = {
  key:  readFileSync(path.join(__dirname, 'localhost+1-key.pem')),
  cert: readFileSync(path.join(__dirname, 'localhost+1.pem')),
}

const app    = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const httpsServer = createServer(ssl, (req, res) => {
    handle(req, res, parse(req.url, true))
  })

  // HTTP → HTTPS リダイレクト
  createHttpServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host?.replace(/:\d+$/, '')}:${port}${req.url}` })
    res.end()
  }).listen(port + 1, '0.0.0.0')

  const io = new Server(httpsServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  })

  io.on('connection', (socket) => {
    const role = socket.handshake.query.role || 'unknown'
    console.log(`[+] ${role} connected  (${socket.id})`)
    socket.join(role)

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
    })
  })

  httpsServer.listen(port, '0.0.0.0', () => {
    console.log(`\n=== どこでもDJ ===`)
    console.log(`スマホ (コントローラー): https://<PC の IP>:${port}/`)
    console.log(`スマホ (AR モード):      https://<PC の IP>:${port}/ar`)
    console.log(`PC Chrome (MIDI 出力):  https://localhost:${port}/output`)
    console.log(`\nPC の IP: ifconfig | grep "inet " | grep -v 127\n`)
  })
})
