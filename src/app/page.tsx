import Link from 'next/link'
import { headers } from 'next/headers'
import { normalizeCode, isValidCode, withRoom } from '@/core/room'

// 端末から入口を決め打ちせず、どちらで使うかを選んでもらう。
// PCでコントローラを開きたい場面があるため。推奨の印だけ端末から出す
const MOBILE_UA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function Home({ searchParams }: Props) {
  const params = await searchParams
  const raw = typeof params.room === 'string' ? params.room : ''
  const code = isValidCode(normalizeCode(raw)) ? normalizeCode(raw) : null

  const ua = (await headers()).get('user-agent') ?? ''
  const isMobile = MOBILE_UA.test(ua)

  const choices = [
    {
      href: withRoom('/touch', code),
      title: 'スタンドアローン',
      lead: 'スマホやPCのみで使用する場合はこちら',
      recommended: isMobile,
    },
    {
      href: withRoom('/output', code),
      title: 'MIDIモード',
      lead: 'DJソフトなどを別途使用する場合はこちら',
      recommended: !isMobile,
    },
  ]

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center
                     gap-8 px-6 py-10">
      <h1 className="text-2xl font-bold">どこでもDJ</h1>

      <div className="w-full max-w-md flex flex-col gap-4 sm:max-w-3xl sm:flex-row">
        {choices.map(c => (
          <Link
            key={c.href}
            href={c.href}
            className="flex-1 flex flex-col gap-2 rounded-2xl border border-gray-700 bg-gray-900
                       px-5 py-5 active:bg-gray-800 hover:border-gray-500 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">{c.title}</span>
              {c.recommended && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/20
                                 border border-sky-500 text-sky-300">
                  この端末におすすめ
                </span>
              )}
            </div>
            <span className="text-sm text-gray-300">{c.lead}</span>
          </Link>
        ))}
      </div>

      {code && (
        <p className="text-xs text-gray-500">
          ルーム <span className="font-mono text-gray-300">{code}</span> に参加します
        </p>
      )}
    </main>
  )
}
