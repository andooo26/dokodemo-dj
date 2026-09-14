// ルームコードの受け渡し。URLの ?room= だけを正とする。
// 端末に覚えさせると、コード無しで開いたときに消えたルームを掴んでしまう。

export const ROOM_PARAM = 'room'
const STORAGE_KEY = 'dokodemo-dj:room'   // 以前の版が残した値を消すためだけに残す

export function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

export function isValidCode(code: string): boolean {
  return /^[A-Z0-9]{4,8}$/.test(code)
}

// URLにあるコードだけを見る
export function currentRoom(): string | null {
  if (typeof window === 'undefined') return null
  const fromUrl = new URLSearchParams(window.location.search).get(ROOM_PARAM)
  if (!fromUrl) return null
  const code = normalizeCode(fromUrl)
  return isValidCode(code) ? code : null
}

// 再読込やページ移動でも同じルームに戻れるよう、URLへ書き戻す
export function rememberRoom(code: string) {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* プライベートモード */ }
  const url = new URL(window.location.href)
  if (url.searchParams.get(ROOM_PARAM) !== code) {
    url.searchParams.set(ROOM_PARAM, code)
    window.history.replaceState(null, '', url)
  }
}

// 覚えているコードを捨てる。消えたルームを掴んだままにしないため
export function forgetRoom() {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* プライベートモード */ }
  const url = new URL(window.location.href)
  url.searchParams.delete(ROOM_PARAM)
  window.history.replaceState(null, '', url)
}

// ページ間リンクにコードを引き継ぐ
export function withRoom(href: string, code: string | null): string {
  if (!code) return href
  const [path, query] = href.split('?')
  const params = new URLSearchParams(query)
  params.set(ROOM_PARAM, code)
  return `${path}?${params}`
}
