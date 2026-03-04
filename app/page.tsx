'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useAudioProcessor } from './hooks/useAudioProcessor'
import type { ProcessingStep } from './lib/types'

const MODELS = [
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
  { value: 'whisper-1', label: 'Whisper-1' },
]

const FORMATS = [
  { value: 'text', label: 'text' },
  { value: 'json', label: 'json' },
  { value: 'verbose_json', label: 'verbose_json' },
  { value: 'srt', label: 'srt', whisperOnly: true },
  { value: 'vtt', label: 'vtt', whisperOnly: true },
]

const LANGUAGES = [
  { value: '', label: '自動検出' },
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'pt', label: 'Português' },
  { value: 'it', label: 'Italiano' },
  { value: 'ru', label: 'Русский' },
]

const MAX_FILE_SIZE = 500 * 1024 * 1024 // 500MB
const ACCEPTED_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/x-m4a', 'audio/mp3', 'audio/ogg', 'video/mp4', 'video/webm', 'audio/x-wav', 'audio/aac', 'audio/flac']
const ACCEPTED_EXTENSIONS = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac']

const STEP_LABELS: Record<ProcessingStep, string> = {
  idle: '',
  'loading-ffmpeg': 'FFmpeg を読み込み中...',
  compressing: '音声を圧縮中...',
  splitting: '音声を分割中...',
  transcribing: '文字起こし中...',
  done: '完了',
  error: 'エラー',
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return `ファイルサイズが大きすぎます（${formatFileSize(file.size)}）。最大 500MB です`
  }
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  const typeOk = ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.includes(ext)
  if (!typeOk) {
    return '対応していないファイル形式です'
  }
  return null
}

export default function Home() {
  const [apiKey, setApiKey] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [model, setModel] = useState('gpt-4o-transcribe')
  const [responseFormat, setResponseFormat] = useState('text')
  const isWhisper = model === 'whisper-1'
  const [language, setLanguage] = useState('')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const submitIdRef = useRef(0)
  const { processAndTranscribe, status, cancel } = useAudioProcessor()

  useEffect(() => {
    const saved = localStorage.getItem('mojiokoshi_api_key')
    if (saved) setApiKey(saved)
  }, [])

  useEffect(() => {
    if (apiKey) {
      localStorage.setItem('mojiokoshi_api_key', apiKey)
    } else {
      localStorage.removeItem('mojiokoshi_api_key')
    }
  }, [apiKey])

  useEffect(() => {
    const fmt = FORMATS.find((f) => f.value === responseFormat)
    if (fmt && 'whisperOnly' in fmt && fmt.whisperOnly && !isWhisper) {
      setResponseFormat('text')
    }
  }, [model, responseFormat, isWhisper])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const setFileWithValidation = useCallback((f: File) => {
    const err = validateFile(f)
    if (err) {
      setFile(null)
      setError(err)
      return
    }
    setFile(f)
    setError(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const droppedFile = e.dataTransfer.files[0]
    if (droppedFile) setFileWithValidation(droppedFile)
  }, [setFileWithValidation])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) setFileWithValidation(selectedFile)
  }, [setFileWithValidation])

  const handleSubmit = async () => {
    if (!apiKey) {
      setError('API key を入力してください')
      return
    }
    if (!file) {
      setError('オーディオファイルを選択してください')
      return
    }

    const currentSubmitId = ++submitIdRef.current
    setIsLoading(true)
    setError(null)
    setResult('')

    // Guard: force text if whisperOnly format on non-whisper model
    const fmt = FORMATS.find((f) => f.value === responseFormat)
    const safeFormat = (fmt && 'whisperOnly' in fmt && fmt.whisperOnly && model !== 'whisper-1')
      ? 'text'
      : responseFormat

    try {
      const text = await processAndTranscribe(file, {
        apiKey,
        model,
        responseFormat: safeFormat,
        language,
        prompt,
      })
      if (submitIdRef.current !== currentSubmitId) return
      setResult(text)
    } catch (err) {
      if (submitIdRef.current !== currentSubmitId) return
      const msg = err instanceof Error ? err.message : 'エラーが発生しました'
      if (msg !== 'キャンセルされました') {
        setError(msg)
      }
    } finally {
      if (submitIdRef.current === currentSubmitId) {
        setIsLoading(false)
      }
    }
  }

  const handleCancel = () => {
    submitIdRef.current++
    cancel()
    setIsLoading(false)
  }

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(result)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('クリップボードへのコピーに失敗しました')
    }
  }

  const isProcessing = isLoading && status.step !== 'idle' && status.step !== 'done' && status.step !== 'error'

  return (
    <>
      <div className="noise-overlay" />

      <main className="min-h-screen flex flex-col items-center px-4 py-12 md:py-20">
        {/* Header */}
        <header className="text-center mb-12 md:mb-16">
          <h1 className="font-display text-4xl md:text-6xl tracking-tight mb-3 text-text-primary">
            文字起こし
          </h1>
          <p className="font-mono text-[11px] tracking-[0.35em] uppercase text-text-tertiary">
            Audio Transcription
          </p>
        </header>

        {/* Main */}
        <div className="w-full max-w-2xl">
          {/* Upload Zone */}
          <div
            role="button"
            tabIndex={0}
            className={`upload-zone rounded-xl p-8 md:p-12 text-center cursor-pointer mb-8 ${isDragOver ? 'drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
            aria-label="オーディオファイルをアップロード"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm,.ogg,.flac"
              onChange={handleFileSelect}
              className="hidden"
            />

            {file ? (
              <div className="result-appear">
                <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                  </svg>
                </div>
                <p className="text-text-primary font-medium text-sm mb-1">{file.name}</p>
                <p className="text-text-tertiary text-xs">{formatFileSize(file.size)}</p>
              </div>
            ) : (
              <>
                <div className="w-10 h-10 rounded-full border border-border flex items-center justify-center mx-auto mb-4">
                  <svg className="w-5 h-5 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
                <p className="text-text-secondary text-sm mb-1">
                  ドラッグ＆ドロップ または クリックで選択
                </p>
                <p className="text-text-tertiary text-xs">
                  mp3, wav, m4a, mp4, webm &mdash; 最大 500MB
                </p>
              </>
            )}
          </div>

          {/* Configuration */}
          <div className="space-y-5 mb-8">
            {/* API Key */}
            <div>
              <label className="block text-xs text-text-secondary mb-2 tracking-wide">
                API Key
              </label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full bg-surface-card border border-border rounded-lg px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary font-mono pr-20"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary text-xs font-mono transition-colors"
                >
                  {showApiKey ? 'hide' : 'show'}
                </button>
              </div>
            </div>

            {/* Model & Language */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-secondary mb-2 tracking-wide">
                  Model
                </label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-surface-card border border-border rounded-lg px-4 py-3 text-sm text-text-primary cursor-pointer"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-2 tracking-wide">
                  Language
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full bg-surface-card border border-border rounded-lg px-4 py-3 text-sm text-text-primary cursor-pointer"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Response Format */}
            <div>
              <label className="block text-xs text-text-secondary mb-2 tracking-wide">
                Format
              </label>
              <div className="flex flex-wrap gap-2">
                {FORMATS.map((f) => {
                  const disabled = 'whisperOnly' in f && f.whisperOnly && !isWhisper
                  return (
                  <div key={f.value} className={`format-option ${disabled ? 'opacity-30 pointer-events-none' : ''}`}>
                    <input
                      type="radio"
                      name="format"
                      id={`format-${f.value}`}
                      value={f.value}
                      checked={responseFormat === f.value}
                      disabled={disabled}
                      onChange={(e) => setResponseFormat(e.target.value)}
                    />
                    <label htmlFor={`format-${f.value}`}>
                      {f.label}
                    </label>
                  </div>
                  )
                })}
              </div>
            </div>

            {/* Prompt */}
            <div>
              <label className="block text-xs text-text-secondary mb-2 tracking-wide">
                Prompt
                <span className="text-text-tertiary ml-2">optional</span>
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="固有名詞や専門用語のヒントを入力..."
                rows={2}
                className="w-full bg-surface-card border border-border rounded-lg px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary resize-none"
              />
            </div>
          </div>

          {/* Submit */}
          <button
            onClick={isLoading ? handleCancel : handleSubmit}
            disabled={!isLoading && (!file || !apiKey)}
            className={`btn-primary w-full font-medium py-3.5 rounded-lg text-sm tracking-wide transition-all ${
              isLoading
                ? 'bg-red-500/80 hover:bg-red-500 text-white'
                : 'bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-surface-primary'
            }`}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-3">
                キャンセル
              </span>
            ) : (
              '文字起こしを開始'
            )}
          </button>

          {/* Processing Status */}
          {isProcessing && (
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
                  {status.detail || STEP_LABELS[status.step]}
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
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm result-appear">
              {error}
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="mt-8 result-appear">
              <div className="divider-accent mb-6" />
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                  <span className="text-xs text-text-secondary tracking-wide">結果</span>
                </div>
                <button
                  onClick={copyToClipboard}
                  className="text-xs text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1.5 font-mono"
                >
                  {copied ? (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      copied
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      copy
                    </>
                  )}
                </button>
              </div>
              <div className="bg-surface-card border border-border rounded-xl p-5 max-h-[28rem] overflow-y-auto">
                <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap leading-relaxed break-words">
                  {result}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="mt-16 text-center space-y-1">
          <p className="text-text-tertiary text-[11px] font-mono tracking-wide">
            Powered by OpenAI Speech-to-Text API
          </p>
          {process.env.NEXT_PUBLIC_COMMIT_HASH && (
            <p className="text-text-tertiary/50 text-[10px] font-mono">
              {process.env.NEXT_PUBLIC_COMMIT_HASH}
            </p>
          )}
        </footer>
      </main>
    </>
  )
}
