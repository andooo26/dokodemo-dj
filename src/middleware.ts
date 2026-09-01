import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const MOBILE_UA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i

// 端末ごとにページを振り分ける
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isMobile = MOBILE_UA.test(request.headers.get('user-agent') ?? '')
  const home = isMobile ? '/touch' : '/output'

  // ルートは端末に応じた入口へ
  if (pathname === '/') {
    return NextResponse.redirect(new URL(home, request.url))
  }
  // 端末に合わないページは引き戻す
  if (pathname === '/output' && isMobile) {
    return NextResponse.redirect(new URL('/touch', request.url))
  }
  if (pathname === '/touch' && !isMobile) {
    return NextResponse.redirect(new URL('/output', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/touch', '/output'],
}
