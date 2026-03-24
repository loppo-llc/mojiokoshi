import { useState } from 'react'
import type { ChunkResult } from '../lib/types'

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

interface ResultPanelProps {
  result: string
  chunkResults: ChunkResult[]
  retryingIndex: number | null
  onRetryChunk: (index: number) => void
  onCopy: () => void
  copied: boolean
  t: (key: string, params?: Record<string, string | number>) => string
}

export function ResultPanel({
  result, chunkResults, retryingIndex,
  onRetryChunk, onCopy, copied, t,
}: ResultPanelProps) {
  const [showChunks, setShowChunks] = useState(false)

  return (
    <div className="mt-8 result-appear">
      <div className="divider-accent mb-6" />
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-accent" />
          <span className="text-xs text-text-secondary tracking-wide">{t('result.title')}</span>
        </div>
        <button
          onClick={onCopy}
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1.5 font-mono"
        >
          {copied ? (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {t('result.copied')}
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {t('result.copy')}
            </>
          )}
        </button>
      </div>
      <div className="bg-surface-card border border-border rounded-xl p-5 max-h-[28rem] overflow-y-auto">
        <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap leading-relaxed break-words">
          {result}
        </pre>
      </div>

      {/* Chunk Details */}
      {chunkResults.length >= 1 && (
        <div className="mt-4">
          <button
            onClick={() => setShowChunks(!showChunks)}
            className="flex items-center gap-2 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showChunks ? '' : '-rotate-90'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            <span className="font-mono tracking-wide">
              {t('chunk.details')} ({chunkResults.length})
            </span>
          </button>

          {showChunks && (
            <div className="mt-3 bg-surface-card border border-border rounded-xl divide-y divide-border overflow-hidden">
              {chunkResults.map((chunk, arrayIndex) => (
                <div key={chunk.index} className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-text-secondary font-mono">
                      {t('chunk.label', { current: arrayIndex + 1, total: chunkResults.length })}
                      <span className="ml-2 text-text-tertiary">
                        {formatTime(chunk.startTime)}–{formatTime(chunk.endTime)}
                      </span>
                    </span>
                    {chunk.status === 'retrying' || retryingIndex === chunk.index ? (
                      <span className="flex items-center gap-1.5 text-xs text-accent font-mono">
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        {t('chunk.retrying')}
                      </span>
                    ) : (
                      <button
                        onClick={() => onRetryChunk(chunk.index)}
                        disabled={retryingIndex !== null}
                        className={`text-xs transition-colors font-mono disabled:opacity-30 disabled:cursor-not-allowed ${chunk.status === 'error' ? 'text-red-400 hover:text-red-300' : 'text-text-tertiary hover:text-accent'}`}
                      >
                        {t('chunk.retry')}
                      </button>
                    )}
                  </div>
                  <div className="max-h-40 overflow-y-auto">
                    {chunk.status === 'error' ? (
                      <p className="font-mono text-xs text-red-400/70">
                        {t(chunk.error || 'error.chunkFailed')}
                      </p>
                    ) : (
                      <pre className="font-mono text-xs text-text-primary/70 whitespace-pre-wrap leading-relaxed break-words">
                        {chunk.text}
                      </pre>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
