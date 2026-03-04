export type ProcessingStep =
  | 'idle'
  | 'loading-ffmpeg'
  | 'compressing'
  | 'splitting'
  | 'transcribing'
  | 'done'
  | 'error'

export interface ProcessingStatus {
  step: ProcessingStep
  detail: string
  detailParams?: Record<string, string | number>
  progress: number // 0-100
}

export interface TranscribeOptions {
  apiKey: string
  model: string
  responseFormat: string
  language: string
  prompt: string
}

export interface ChunkResult {
  index: number
  text: string
  duration: number
  status: 'done' | 'retrying'
}
