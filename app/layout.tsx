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

const title = '文字起こし — mojiokoshi'
const description = 'OpenAI Speech-to-Text による音声文字起こし'

const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'http://localhost:3000'

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl),
  title,
  description,
  openGraph: {
    title,
    description,
    url: '/',
    type: 'website',
    locale: 'ja_JP',
    images: [{ url: '/og.jpg', width: 1200, height: 1346 }],
  },
  twitter: {
    card: 'summary',
    title,
    description,
    images: ['/og.jpg'],
  },
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
