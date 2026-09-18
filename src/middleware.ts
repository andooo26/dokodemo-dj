import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const MOBILE_UA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i

// モニタだけPC専用にする。入口の選択はルートの画面が受け持つ
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isMobile = MOBILE_UA.test(request.headers.get('user-agent') ?? '')

  // ルームコードを落とさずに転送する
  const redirect = (to: string) => {
    const url = new URL(to, request.url)
    url.search = request.nextUrl.search
    return NextResponse.redirect(url)
  }

  // モニタはPC専用。スマホで開いたらコントローラへ回す
  if (pathname === '/output' && isMobile) return redirect('/touch')

  return NextResponse.next()
}

export const config = {
  matcher: ['/output'],
}
