import type { ProcessingStatus } from '../lib/types'

interface ProcessingIndicatorProps {
  status: ProcessingStatus
  t: (key: string, params?: Record<string, string | number>) => string
}

export function ProcessingIndicator({ status, t }: ProcessingIndicatorProps) {
  return (
    <div className="mt-4 result-appear">
      <div className="flex items-center gap-3 mb-2">
        <span className="flex items-center gap-[3px] h-5">
          {[...Array(7)].map((_, i) => (
            <span
              key={i}
              className="waveform-bar w-[3px] bg-accent/60 rounded-full"
            />
          ))}
        </span>
        <span className="text-sm text-text-secondary">
          {t(status.detail, status.detailParams)}
        </span>
      </div>
      {status.progress > 0 && (
        <div className="w-full h-1 bg-surface-card rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-300"
            style={{ width: `${status.progress}%` }}
          />
        </div>
      )}
    </div>
  )
}
