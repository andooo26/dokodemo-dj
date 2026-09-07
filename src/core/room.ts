// ルームコードの受け渡し。URLの ?room= を正とし、localStorage は再読込用の控え。

export const ROOM_PARAM = 'room'
const STORAGE_KEY = 'dokodemo-dj:room'

export function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

export function isValidCode(code: string): boolean {
  return /^[A-Z0-9]{4,8}$/.test(code)
}

// URL優先、無ければ前回のコード
export function currentRoom(): string | null {
  if (typeof window === 'undefined') return null
  const fromUrl = new URLSearchParams(window.location.search).get(ROOM_PARAM)
  if (fromUrl && isValidCode(normalizeCode(fromUrl))) return normalizeCode(fromUrl)
  const saved = window.localStorage?.getItem(STORAGE_KEY)
  return saved && isValidCode(saved) ? saved : null
}

// 再読込やページ移動でも同じルームに戻れるようにする
export function rememberRoom(code: string) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(STORAGE_KEY, code) } catch { /* プライベートモード */ }
  const url = new URL(window.location.href)
  if (url.searchParams.get(ROOM_PARAM) !== code) {
    url.searchParams.set(ROOM_PARAM, code)
    window.history.replaceState(null, '', url)
  }
}

// ページ間リンクにコードを引き継ぐ
export function withRoom(href: string, code: string | null): string {
  if (!code) return href
  const [path, query] = href.split('?')
  const params = new URLSearchParams(query)
  params.set(ROOM_PARAM, code)
  return `${path}?${params}`
}
