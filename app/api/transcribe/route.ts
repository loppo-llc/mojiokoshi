import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 120

const ALLOWED_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']
const ALLOWED_FORMATS = ['text', 'json', 'verbose_json', 'srt', 'vtt']
const MAX_FILE_SIZE = 25 * 1024 * 1024

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()

    const apiKey = formData.get('apiKey') as string
    const file = formData.get('file')
    const model = (formData.get('model') as string) || 'gpt-4o-transcribe'
    const responseFormat = (formData.get('response_format') as string) || 'text'
    const language = formData.get('language') as string
    const prompt = formData.get('prompt') as string

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key を入力してください' },
        { status: 400 },
      )
    }

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'オーディオファイルを選択してください' },
        { status: 400 },
      )
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: 'ファイルサイズは 25MB 以下にしてください' },
        { status: 400 },
      )
    }

    if (!ALLOWED_MODELS.includes(model)) {
      return NextResponse.json(
        { error: '無効なモデルです' },
        { status: 400 },
      )
    }

    if (!ALLOWED_FORMATS.includes(responseFormat)) {
      return NextResponse.json(
        { error: '無効なフォーマットです' },
        { status: 400 },
      )
    }

    const openaiFormData = new FormData()
    openaiFormData.append('file', file)
    openaiFormData.append('model', model)
    openaiFormData.append('response_format', responseFormat)

    if (language) openaiFormData.append('language', language)
    if (prompt) openaiFormData.append('prompt', prompt)

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: openaiFormData,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return NextResponse.json(
        { error: errorData.error?.message || `API error: ${response.status}` },
        { status: response.status },
      )
    }

    // json / verbose_json -> return as JSON
    // text / srt / vtt -> return as { text: "..." }
    if (responseFormat === 'json' || responseFormat === 'verbose_json') {
      const data = await response.json()
      return NextResponse.json(data)
    } else {
      const text = await response.text()
      return NextResponse.json({ text })
    }
  } catch {
    return NextResponse.json(
      { error: 'リクエストの処理に失敗しました' },
      { status: 500 },
    )
  }
}
