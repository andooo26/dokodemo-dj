// MediaPipe のアセットだけは自前で返す。
// WAN 越しだと素の .wasm は重いので、事前圧縮した .br があればそれを使う。

const { existsSync, statSync, createReadStream } = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'public')
const SERVED = /^\/(mediapipe|models)\//
const TYPES = {
  '.wasm': 'application/wasm',
  '.js':   'text/javascript; charset=utf-8',
  '.task': 'application/octet-stream',
}
const ONE_YEAR = 60 * 60 * 24 * 365

// 返したら true。対象外なら false を返して Next に任せる
function serveAsset(req, res, pathname) {
  if (!SERVED.test(pathname) || pathname.includes('..')) return false

  const file = path.join(ROOT, pathname)
  if (!file.startsWith(ROOT) || !existsSync(file)) return false

  const type = TYPES[path.extname(file)] || 'application/octet-stream'
  const brotli = `${file}.br`
  const useBr = existsSync(brotli) && /\bbr\b/.test(req.headers['accept-encoding'] || '')
  const target = useBr ? brotli : file

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': statSync(target).size,
    'Cache-Control': `public, max-age=${ONE_YEAR}, immutable`,
    ...(useBr ? { 'Content-Encoding': 'br', 'Vary': 'Accept-Encoding' } : {}),
  })
  createReadStream(target).pipe(res)
  return true
}

module.exports = { serveAsset }
