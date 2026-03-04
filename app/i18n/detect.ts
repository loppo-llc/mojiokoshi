import { LOCALES, DEFAULT_LOCALE, type Locale } from './types'

export function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE

  for (const lang of navigator.languages) {
    if (LOCALES.includes(lang as Locale)) return lang as Locale

    // Map region-based Chinese codes to script-based codes
    if (lang === 'zh-CN' || lang === 'zh-SG') return 'zh-Hans'
    if (lang === 'zh-TW' || lang === 'zh-HK' || lang === 'zh-MO') return 'zh-Hant'
    if (lang.startsWith('zh-Hans')) return 'zh-Hans'
    if (lang.startsWith('zh-Hant')) return 'zh-Hant'
    if (lang === 'zh') return 'zh-Hans'

    // Base language match (e.g., 'en-US' → 'en')
    const base = lang.split('-')[0]
    if (LOCALES.includes(base as Locale)) return base as Locale
  }

  return DEFAULT_LOCALE
}
