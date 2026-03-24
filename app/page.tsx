'use client'

import { useState, useRef, useEffect } from 'react'
import { useAudioProcessor } from './hooks/useAudioProcessor'
import { useTranslation } from './i18n/context'
import { LOCALES, LOCALE_LABELS } from './i18n/types'
import type { Locale } from './i18n/types'
import { UploadZone } from './components/UploadZone'
import { ConfigForm, FORMATS } from './components/ConfigForm'
import { ProcessingIndicator } from './components/ProcessingIndicator'
import { ResultPanel } from './components/ResultPanel'

const TERMS_LINK_URL = 'https://openai.com/policies/terms-of-use'

function renderTermsWithLink(text: string) {
  const parts = text.split('__LINK__')
  if (parts.length !== 3) return text
  return (
    <>
      {parts[0]}
      <a href={TERMS_LINK_URL} target="_blank" rel="noopener noreferrer" className="text-accent/60 hover:text-accent transition-colors">
        {parts[1]}
      </a>
      {parts[2]}
    </>
  )
}

export default function Home() {
  const { t, locale, setLocale } = useTranslation()

  const [apiKey, setApiKey] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [model, setModel] = useState('gpt-4o-transcribe')
  const [responseFormat, setResponseFormat] = useState('text')
  const [language, setLanguage] = useState('')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null)

  const promptRestoredRef = useRef(false)
  const { processAndTranscribe, status, cancel, chunkResults, retryChunk } = useAudioProcessor()

  // Persistence
  useEffect(() => {
    const saved = localStorage.getItem('mojiokoshi_api_key')
    if (saved) setApiKey(saved)
    const savedPrompt = localStorage.getItem('mojiokoshi_prompt')
    if (savedPrompt) setPrompt(savedPrompt)
  }, [])

  useEffect(() => {
    if (apiKey) {
      localStorage.setItem('mojiokoshi_api_key', apiKey)
    } else {
      localStorage.removeItem('mojiokoshi_api_key')
    }
  }, [apiKey])

  useEffect(() => {
    if (!promptRestoredRef.current) {
      promptRestoredRef.current = true
      return
    }
    if (prompt) {
      localStorage.setItem('mojiokoshi_prompt', prompt)
    } else {
      localStorage.removeItem('mojiokoshi_prompt')
    }
  }, [prompt])

  // Reset whisper-only format when switching model
  const isWhisper = model === 'whisper-1'
  useEffect(() => {
    const fmt = FORMATS.find((f) => f.value === responseFormat)
    if (fmt && 'whisperOnly' in fmt && fmt.whisperOnly && !isWhisper) {
      setResponseFormat('text')
    }
  }, [model, responseFormat, isWhisper])

  const handleSubmit = async () => {
    if (!apiKey) { setError(t('error.noApiKey')); return }
    if (!file) { setError(t('error.noFile')); return }

    setIsLoading(true)
    setError(null)
    setResult('')

    const fmt = FORMATS.find((f) => f.value === responseFormat)
    const safeFormat = (fmt && 'whisperOnly' in fmt && fmt.whisperOnly && model !== 'whisper-1')
      ? 'text'
      : responseFormat

    try {
      const text = await processAndTranscribe(file, {
        apiKey, model, responseFormat: safeFormat, language, prompt,
      })
      setResult(text)
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'error.generic'
      if (rawMsg !== 'error.cancelled') setError(t(rawMsg))
    } finally {
      setIsLoading(false)
    }
  }

  const handleCancel = () => {
    cancel()
    setIsLoading(false)
  }

  const handleRetryChunk = async (index: number) => {
    if (retryingIndex !== null) return
    setError(null)
    setRetryingIndex(index)
    try {
      const merged = await retryChunk(index)
      setResult(merged)
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'error.generic'
      if (rawMsg !== 'error.cancelled') setError(t(rawMsg))
    } finally {
      setRetryingIndex(null)
    }
  }

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(result)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError(t('error.copyFailed'))
    }
  }

  const isProcessing = isLoading && status.step !== 'idle' && status.step !== 'done' && status.step !== 'error'

  return (
    <>
      <div className="noise-overlay" />

      <main className="min-h-screen flex flex-col items-center px-4 py-12 md:py-20">
        <header className="text-center mb-12 md:mb-16">
          <h1 className="font-display text-4xl md:text-6xl tracking-tight mb-3 text-text-primary">
            {t('header.title')}
          </h1>
          <p className="font-mono text-[11px] tracking-[0.35em] uppercase text-text-tertiary">
            {t('header.subtitle')}
          </p>
        </header>

        <div className="w-full max-w-2xl">
          <UploadZone
            file={file}
            onFileChange={setFile}
            onError={(msg) => setError(msg || null)}
            t={t}
          />

          <ConfigForm
            apiKey={apiKey} onApiKeyChange={setApiKey}
            model={model} onModelChange={setModel}
            language={language} onLanguageChange={setLanguage}
            responseFormat={responseFormat} onFormatChange={setResponseFormat}
            prompt={prompt} onPromptChange={setPrompt}
            t={t}
          />

          {/* Submit */}
          <button
            onClick={isLoading ? handleCancel : handleSubmit}
            disabled={retryingIndex !== null || (!isLoading && (!file || !apiKey))}
            className={`btn-primary w-full font-medium py-3.5 rounded-lg text-sm tracking-wide transition-all ${
              isLoading
                ? 'bg-red-500/80 hover:bg-red-500 text-white'
                : 'bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-surface-primary'
            }`}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-3">
                {t('button.cancel')}
              </span>
            ) : (
              t('button.start')
            )}
          </button>

          {isProcessing && <ProcessingIndicator status={status} t={t} />}

          {error && (
            <div className="mt-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm result-appear">
              {error}
            </div>
          )}

          {result && (
            <ResultPanel
              result={result}
              chunkResults={chunkResults}
              retryingIndex={retryingIndex}
              onRetryChunk={handleRetryChunk}
              onCopy={copyToClipboard}
              copied={copied}
              t={t}
            />
          )}
        </div>

        {/* Footer */}
        <footer className="mt-20 w-full max-w-2xl">
          <div className="divider-accent mb-6" />
          <div className="mb-6">
            <p className="font-mono text-[9px] tracking-[0.3em] uppercase text-text-tertiary mb-4">
              {t('terms.title')}
            </p>
            <ol className="list-none space-y-1.5 text-[10px] leading-[1.6] text-text-tertiary font-mono">
              {(['01', '02', '03', '04', '05', '06'] as const).map((num) => (
                <li key={num} className="flex gap-2">
                  <span className="text-accent/40 select-none shrink-0">{num}</span>
                  <span>
                    {num === '05' ? renderTermsWithLink(t('terms.05')) : t(`terms.${num}`)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="divider-accent mb-6" />

          <p className="text-center text-text-tertiary text-[11px] font-mono tracking-wide mb-4">
            {t('footer.poweredBy')}
          </p>

          <div className="flex items-center justify-center gap-3 mb-4">
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              className="text-[10px] font-mono text-text-tertiary/50 bg-transparent border-none cursor-pointer outline-none"
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>{LOCALE_LABELS[l]}</option>
              ))}
            </select>
          </div>

          {process.env.NEXT_PUBLIC_COMMIT_HASH && (
            <p className="text-center text-[9px] font-mono">
              <a href="https://github.com/loppo-llc/mojiokoshi" target="_blank" rel="noopener noreferrer" className="text-text-tertiary/40 hover:text-text-tertiary transition-colors">
                {process.env.NEXT_PUBLIC_COMMIT_HASH}
              </a>
            </p>
          )}
        </footer>
      </main>
    </>
  )
}
