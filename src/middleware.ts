import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const MOBILE_UA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isMobile = MOBILE_UA.test(request.headers.get('user-agent') ?? '')

  if (pathname === '/' && !isMobile) {
    return NextResponse.redirect(new URL('/output', request.url))
  }
  if (pathname === '/output' && isMobile) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/output'],
}
