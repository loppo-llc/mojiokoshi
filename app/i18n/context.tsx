'use client'

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { Locale } from './types'
import { LOCALES, DEFAULT_LOCALE } from './types'
import { detectLocale } from './detect'

import ja from './locales/ja.json'
import en from './locales/en.json'
import zhHans from './locales/zh-Hans.json'
import zhHant from './locales/zh-Hant.json'
import ko from './locales/ko.json'
import fr from './locales/fr.json'
import de from './locales/de.json'
import es from './locales/es.json'
import pt from './locales/pt.json'
import it from './locales/it.json'

const messages: Record<Locale, Record<string, string>> = {
  ja, en, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ko, fr, de, es, pt, it,
}

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

const STORAGE_KEY = 'mojiokoshi_locale'

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && LOCALES.includes(saved as Locale)) {
      setLocaleState(saved as Locale)
    } else {
      setLocaleState(detectLocale())
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    localStorage.setItem(STORAGE_KEY, newLocale)
  }, [])

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    if (!key) return ''
    const msg = messages[locale]?.[key] ?? messages[DEFAULT_LOCALE]?.[key] ?? key
    if (!params) return msg
    return msg.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`))
  }, [locale])

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useTranslation() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useTranslation must be used within I18nProvider')
  return ctx
}
