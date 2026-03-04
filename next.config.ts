import type { NextConfig } from 'next'
import { execSync } from 'child_process'

const commitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
})()

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_COMMIT_HASH: commitHash,
  },
  async rewrites() {
    return [
      {
        source: '/api/openai/v1/audio/transcriptions',
        destination: 'https://api.openai.com/v1/audio/transcriptions',
      },
    ]
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
        ],
      },
    ]
  },
}

export default nextConfig
