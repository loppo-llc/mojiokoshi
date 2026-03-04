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
  progress: number // 0-100
}

export interface TranscribeOptions {
  apiKey: string
  model: string
  responseFormat: string
  language: string
  prompt: string
}
