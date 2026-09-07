// Node から MIDI を出力する。
// 既定では仮想ポートを作り、DJソフト側からはそれを選ぶだけで繋がる。
// output 画面からの指示で既存ポートへ開き直せる。

const midi = require('@julusian/midi')

const VIRTUAL_PORT_NAME = 'DokodemoDJ'

function readPorts(out) {
  return Array.from({ length: out.getPortCount() }, (_, i) => out.getPortName(i))
}

// 接続中のポートとは別に、その時点の一覧を取り直す
function listPorts() {
  const probe = new midi.Output()
  try { return readPorts(probe) }
  finally { try { probe.closePort() } catch { /* 未オープン */ } }
}

function createMidiOut() {
  let out = null
  let portName = null
  let virtual = false

  const state = () => ({ name: portName, virtual })

  function close() {
    if (!out) return
    try { out.closePort() } catch { /* 既に閉じている */ }
    out = null
    portName = null
    virtual = false
  }

  // name を省略すると仮想ポートを開く
  function open(name) {
    close()
    const next = new midi.Output()
    try {
      if (name) {
        const ports = readPorts(next)
        const idx = ports.indexOf(name)
        const hit = idx >= 0 ? idx : ports.findIndex(p => p.includes(name))
        if (hit < 0) throw new Error(`MIDI ポート "${name}" が見つかりません`)
        next.openPort(hit)
        portName = ports[hit]
        virtual = false
      } else {
        next.openVirtualPort(VIRTUAL_PORT_NAME)
        portName = VIRTUAL_PORT_NAME
        virtual = true
      }
    } catch (e) {
      try { next.closePort() } catch { /* 未オープン */ }
      throw e
    }
    out = next
    return state()
  }

  // 起動時は MIDI_PORT があればそれ、駄目なら仮想ポートへ落とす
  try {
    open(process.env.MIDI_PORT)
  } catch (e) {
    console.log(`  [!] ${e.message}。仮想ポートを開きます`)
    try { open() } catch (e2) { console.log(`  [!] MIDI ポートを開けませんでした: ${e2.message}`) }
  }

  return {
    get portName() { return portName },
    get virtual()  { return virtual },
    state,
    ports: listPorts,
    open,
    close,
    send(bytes) {
      if (!out || bytes.length !== 3) return
      out.sendMessage([bytes[0], bytes[1], bytes[2]])
    },
  }
}

module.exports = { createMidiOut, VIRTUAL_PORT_NAME }
