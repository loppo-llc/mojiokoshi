import type { Metadata } from 'next'
import { Playfair_Display, Outfit, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: '文字起こし — mojiokoshi',
  description: 'OpenAI Speech-to-Text による音声文字起こし',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja" className={`${playfair.variable} ${outfit.variable} ${jetbrainsMono.variable}`}>
      <body className="font-body bg-surface-primary text-text-primary antialiased">
        {children}
      </body>
    </html>
  )
}
