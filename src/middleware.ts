import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const MOBILE_UA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i

// 端末ごとにページを振り分ける
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isMobile = MOBILE_UA.test(request.headers.get('user-agent') ?? '')
  const home = isMobile ? '/touch' : '/output'

  // ルームコードを落とさずに転送する
  const redirect = (to: string) => {
    const url = new URL(to, request.url)
    url.search = request.nextUrl.search
    return NextResponse.redirect(url)
  }

  // ルートは端末に応じた入口へ
  if (pathname === '/') return redirect(home)

  // モニタはPC専用。コントローラはどちらでも開ける
  if (pathname === '/output' && isMobile) return redirect('/touch')

  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/touch', '/output'],
}
