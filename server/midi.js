// Node から MIDI を出力する。
// 既定では仮想ポートを作り、DJソフト側からはそれを選ぶだけで繋がる。

const midi = require('@julusian/midi')

const VIRTUAL_PORT_NAME = 'DokodemoDJ'

function listPorts(out) {
  return Array.from({ length: out.getPortCount() }, (_, i) => out.getPortName(i))
}

// MIDI_PORT が指定されていればそのハードウェアポート、無ければ仮想ポートを開く
function openMidiOut(preferred = process.env.MIDI_PORT) {
  const out = new midi.Output()
  const ports = listPorts(out)

  if (preferred) {
    const idx = ports.findIndex(p => p.includes(preferred))
    if (idx >= 0) {
      out.openPort(idx)
      return { out, portName: ports[idx], virtual: false, ports }
    }
    console.log(`  [!] MIDI ポート "${preferred}" が見つかりません。仮想ポートを開きます`)
  }

  out.openVirtualPort(VIRTUAL_PORT_NAME)
  return { out, portName: VIRTUAL_PORT_NAME, virtual: true, ports }
}

function createMidiOut() {
  let handle = null
  try {
    handle = openMidiOut()
  } catch (e) {
    console.log(`  [!] MIDI ポートを開けませんでした: ${e.message}`)
    return { portName: null, virtual: false, ports: [], send: () => {}, close: () => {} }
  }

  return {
    portName: handle.portName,
    virtual:  handle.virtual,
    ports:    handle.ports,
    send(bytes) {
      if (bytes.length !== 3) return
      handle.out.sendMessage([bytes[0], bytes[1], bytes[2]])
    },
    close() {
      try { handle.out.closePort() } catch { /* 既に閉じている */ }
    },
  }
}

module.exports = { createMidiOut }
