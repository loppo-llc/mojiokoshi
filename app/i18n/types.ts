export const LOCALES = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'pt', 'it'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'ja'

export const LOCALE_LABELS: Record<Locale, string> = {
  ja: '日本語',
  en: 'English',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
}
