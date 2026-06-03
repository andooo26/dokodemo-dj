import Link from 'next/link'
import type { ReactNode } from 'react'

interface LinkButtonProps {
  href: string
  children: ReactNode
  disabled?: boolean
}

export function LinkButton({ href, children, disabled }: LinkButtonProps) {
  return (
    <Link
      href={href}
      className="min-h-[44px] px-5 rounded-xl text-sm font-medium touch-manipulation
                 bg-gray-800 active:bg-gray-600 border border-gray-700 transition-colors
                 flex items-center whitespace-nowrap"
    >
      {children}
    </Link>
  )
}

interface ConnectButtonProps {
  disabled: boolean
  status: 'connecting' | 'connected' | 'disconnected'
  onClick: () => void
  mounted?: boolean
  size?: 'normal' | 'small'
}

export function ConnectButton({ disabled, status, onClick, mounted = true, size = 'normal' }: ConnectButtonProps) {
  const label = !mounted ? '...' : status === 'connecting' ? '接続中...' : status === 'connected' ? '再接続' : '再試行'

  const sizeClass = size === 'small' ? 'px-3 py-1.5 text-xs' : 'min-h-[44px] px-5 text-sm'

  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`${sizeClass} rounded-xl font-medium touch-manipulation
                 bg-gray-800/80 active:bg-gray-600 border border-gray-700
                 disabled:opacity-40 disabled:pointer-events-none transition-colors
                 whitespace-nowrap text-white`}
    >
      {label}
    </button>
  )
}
