export const MODELS = [
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
  { value: 'whisper-1', label: 'Whisper-1' },
]

export const FORMATS = [
  { value: 'text', label: 'text' },
  { value: 'json', label: 'json' },
  { value: 'verbose_json', label: 'verbose_json' },
  { value: 'srt', label: 'srt', whisperOnly: true },
  { value: 'vtt', label: 'vtt', whisperOnly: true },
]

export const LANGUAGES: { value: string; label?: string; labelKey?: string }[] = [
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
