// Custom Next.js server with embedded Socket.io relay.
// MIDI output happens in the PC browser via Web MIDI API (/output page).

const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const { Server } = require('socket.io')

const dev = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT || '3000', 10)

const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res, parse(req.url, true))
  })

  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  })

  io.on('connection', (socket) => {
    const role = socket.handshake.query.role || 'unknown'
    console.log(`[+] ${role} connected  (${socket.id})`)
    socket.join(role)

    // controller (スマホ) から届いた MIDI イベントを output (PC ブラウザ) に中継
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

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`\n=== どこでもDJ ===`)
    console.log(`スマホ (コントローラー): http://<PC の IP>:${port}/`)
    console.log(`PC Chrome (MIDI 出力):  http://localhost:${port}/output`)
    console.log(`\nPC の IP: ifconfig | grep "inet " | grep -v 127\n`)
  })
})
