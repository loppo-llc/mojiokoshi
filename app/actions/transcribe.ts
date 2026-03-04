'use server'

const ALLOWED_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']
const ALLOWED_FORMATS = ['text', 'json', 'verbose_json', 'srt', 'vtt']
const MAX_FILE_SIZE = 25 * 1024 * 1024

const WHISPER_ONLY_FORMATS = ['srt', 'vtt']

export async function transcribeAudio(
  formData: FormData,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ error?: string; text?: string; [key: string]: any }> {
  const apiKey = formData.get('apiKey') as string
  const file = formData.get('file')
  const model = (formData.get('model') as string) || 'gpt-4o-transcribe'
  const responseFormat = (formData.get('response_format') as string) || 'text'
  const language = formData.get('language') as string
  const prompt = formData.get('prompt') as string

  if (!apiKey) return { error: 'API key を入力してください' }
  if (!file || !(file instanceof File)) return { error: 'オーディオファイルを選択してください' }
  if (file.size > MAX_FILE_SIZE) return { error: 'ファイルサイズは 25MB 以下にしてください' }
  if (!ALLOWED_MODELS.includes(model)) return { error: '無効なモデルです' }
  if (!ALLOWED_FORMATS.includes(responseFormat)) return { error: '無効なフォーマットです' }
  if (WHISPER_ONLY_FORMATS.includes(responseFormat) && model !== 'whisper-1') {
    return { error: `${responseFormat} 形式は Whisper-1 モデルでのみ使用できます` }
  }

  const openaiFormData = new FormData()
  openaiFormData.append('file', file)
  openaiFormData.append('model', model)
  openaiFormData.append('response_format', responseFormat)
  if (language) openaiFormData.append('language', language)
  if (prompt) openaiFormData.append('prompt', prompt)

  try {
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: openaiFormData,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return { error: errorData.error?.message || `API error: ${response.status}` }
    }

    if (responseFormat === 'json' || responseFormat === 'verbose_json') {
      return await response.json()
    } else {
      const text = await response.text()
      return { text }
    }
  } catch {
    return { error: 'リクエストの処理に失敗しました' }
  }
}
