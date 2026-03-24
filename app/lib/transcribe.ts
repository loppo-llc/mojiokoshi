import type { TranscribeOptions } from './types'

export async function transcribeChunk(
  file: File | Blob,
  filename: string,
  options: TranscribeOptions,
  signal?: AbortSignal,
): Promise<string> {
  const formData = new FormData()
  formData.append('file', file, filename)
  formData.append('model', options.model)
  formData.append('response_format', options.responseFormat)
  if (options.language) formData.append('language', options.language)
  if (options.prompt) formData.append('prompt', options.prompt)

  const res = await fetch('/api/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: formData,
    signal,
  })

  if (!res.ok) {
    let msg = `API error: ${res.status}`
    try {
      const body = await res.text()
      const err = JSON.parse(body)
      if (err.error?.message) msg = err.error.message
    } catch { /* use default msg */ }
    throw new Error(msg)
  }

  if (options.responseFormat === 'json' || options.responseFormat === 'verbose_json') {
    const data = await res.json()
    return JSON.stringify(data, null, 2)
  }
  return await res.text()
}

export function extractLastChars(text: string, format: string, count: number): string {
  if (format === 'json' || format === 'verbose_json') {
    try {
      const parsed = JSON.parse(text)
      return (parsed.text || '').slice(-count)
    } catch {
      return ''
    }
  }
  const plain = text
    .replace(/\d+\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\n/g, '')
    .replace(/WEBVTT\n/g, '')
    .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\n/g, '')
    .replace(/^\d+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return plain.slice(-count)
}
