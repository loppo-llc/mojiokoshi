import { useState } from 'react'

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

const LANGUAGES: { value: string; label?: string; labelKey?: string }[] = [
  { value: '', labelKey: 'lang.auto' },
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

export { FORMATS }

interface ConfigFormProps {
  apiKey: string
  onApiKeyChange: (key: string) => void
  model: string
  onModelChange: (model: string) => void
  language: string
  onLanguageChange: (lang: string) => void
  responseFormat: string
  onFormatChange: (format: string) => void
  prompt: string
  onPromptChange: (prompt: string) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

export function ConfigForm({
  apiKey, onApiKeyChange,
  model, onModelChange,
  language, onLanguageChange,
  responseFormat, onFormatChange,
  prompt, onPromptChange,
  t,
}: ConfigFormProps) {
  const [showApiKey, setShowApiKey] = useState(false)
  const isWhisper = model === 'whisper-1'

  return (
    <div className="space-y-5 mb-8">
      {/* API Key */}
      <div>
        <label className="block text-xs text-text-secondary mb-2 tracking-wide">
          {t('label.apiKey')}
        </label>
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="sk-..."
            className="w-full bg-surface-card border border-border rounded-lg px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary font-mono pr-20"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary text-xs font-mono transition-colors"
          >
            {showApiKey ? t('apiKey.hide') : t('apiKey.show')}
          </button>
        </div>
      </div>

      {/* Model & Language */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-text-secondary mb-2 tracking-wide">
            {t('label.model')}
          </label>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="w-full bg-surface-card border border-border rounded-lg px-4 py-3 text-sm text-text-primary cursor-pointer"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-secondary mb-2 tracking-wide">
            {t('label.language')}
          </label>
          <select
            value={language}
            onChange={(e) => onLanguageChange(e.target.value)}
            className="w-full bg-surface-card border border-border rounded-lg px-4 py-3 text-sm text-text-primary cursor-pointer"
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{l.labelKey ? t(l.labelKey) : l.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Response Format */}
      <div>
        <label className="block text-xs text-text-secondary mb-2 tracking-wide">
          {t('label.format')}
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
                onChange={(e) => onFormatChange(e.target.value)}
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
          {t('label.prompt')}
          <span className="text-text-tertiary ml-2">{t('label.optional')}</span>
        </label>
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder={t('prompt.placeholder')}
          rows={2}
          className="w-full bg-surface-card border border-border rounded-lg px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary resize-y min-h-[60px]"
        />
      </div>
    </div>
  )
}
