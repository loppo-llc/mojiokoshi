'use client'

import { useState, useRef, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL, fetchFile } from '@ffmpeg/util'
import type { ProcessingStatus, TranscribeOptions } from '../lib/types'
import { mergeResults } from '../lib/subtitle-merger'

const MAX_DIRECT_SIZE = 25 * 1024 * 1024 // 25MB
const SEGMENT_SECONDS = 600 // 10 minutes
const MAX_RETRIES = 2

async function transcribeChunk(
  file: File | Blob,
  filename: string,
  options: TranscribeOptions,
  signal?: AbortSignal,
): Promise<string> {
  const formData = new FormData()
  formData.append('file', file, filename)
  formData.append('apiKey', options.apiKey)
  formData.append('model', options.model)
  formData.append('response_format', options.responseFormat)
  if (options.language) formData.append('language', options.language)
  if (options.prompt) formData.append('prompt', options.prompt)

  const res = await fetch('/api/transcribe', {
    method: 'POST',
    body: formData,
    signal,
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `API error: ${res.status}`)

  if (options.responseFormat === 'json' || options.responseFormat === 'verbose_json') {
    return JSON.stringify(data, null, 2)
  }
  return data.text || JSON.stringify(data, null, 2)
}

function extractLastChars(text: string, format: string, count: number): string {
  // For JSON formats, extract the text field
  if (format === 'json' || format === 'verbose_json') {
    try {
      const parsed = JSON.parse(text)
      return (parsed.text || '').slice(-count)
    } catch {
      return ''
    }
  }
  // For SRT/VTT, strip timestamps and indices
  const plain = text
    .replace(/\d+\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\n/g, '')
    .replace(/WEBVTT\n/g, '')
    .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\n/g, '')
    .replace(/^\d+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return plain.slice(-count)
}

export function useAudioProcessor() {
  const [status, setStatus] = useState<ProcessingStatus>({
    step: 'idle',
    detail: '',
    progress: 0,
  })

  const ffmpegRef = useRef<FFmpeg | null>(null)
  const jobIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current) return ffmpegRef.current

    const ffmpeg = new FFmpeg()
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'

    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    })

    ffmpegRef.current = ffmpeg
    return ffmpeg
  }, [])

  const getFileDuration = useCallback(async (ffmpeg: FFmpeg, filename: string): Promise<number> => {
    let logOutput = ''
    const logHandler = ({ message }: { message: string }) => {
      logOutput += message + '\n'
    }
    ffmpeg.on('log', logHandler)

    try {
      await ffmpeg.exec(['-i', filename, '-f', 'null', '-'])
    } catch {
      // ffmpeg may return non-zero but still prints duration
    }

    ffmpeg.off('log', logHandler)

    const match = logOutput.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
    if (match) {
      return (
        parseInt(match[1]) * 3600 +
        parseInt(match[2]) * 60 +
        parseInt(match[3]) +
        parseInt(match[4]) / 100
      )
    }
    return SEGMENT_SECONDS // fallback
  }, [])

  const processAndTranscribe = useCallback(
    async (file: File, options: TranscribeOptions): Promise<string> => {
      // Increment job ID to invalidate any previous job
      const currentJobId = ++jobIdRef.current
      const abortController = new AbortController()
      abortRef.current = abortController

      const isCancelled = () => jobIdRef.current !== currentJobId || abortController.signal.aborted

      // Small file: direct transcribe
      if (file.size <= MAX_DIRECT_SIZE) {
        setStatus({ step: 'transcribing', detail: '文字起こし中...', progress: 0 })
        try {
          const result = await transcribeChunk(file, file.name, options, abortController.signal)
          if (isCancelled()) throw new Error('キャンセルされました')
          setStatus({ step: 'done', detail: '', progress: 100 })
          return result
        } catch (err) {
          if (isCancelled()) throw new Error('キャンセルされました')
          const msg = err instanceof Error ? err.message : 'エラーが発生しました'
          setStatus({ step: 'error', detail: msg, progress: 0 })
          throw err
        }
      }

      // Large file: need ffmpeg
      const trackedFiles: string[] = []

      try {
        setStatus({ step: 'loading-ffmpeg', detail: 'FFmpeg を読み込み中...', progress: 0 })
        const ffmpeg = await loadFFmpeg()

        if (isCancelled()) throw new Error('キャンセルされました')

        // Compress to MP3 128kbps mono
        setStatus({ step: 'compressing', detail: '音声を圧縮中...', progress: 0 })
        const prefix = `j${currentJobId}_`
        const inputName = `${prefix}input${getExtension(file.name)}`
        trackedFiles.push(inputName)
        await ffmpeg.writeFile(inputName, await fetchFile(file))

        const progressHandler = ({ progress }: { progress: number }) => {
          if (isCancelled()) return
          setStatus((prev) => ({
            ...prev,
            progress: Math.round(progress * 100),
          }))
        }
        ffmpeg.on('progress', progressHandler)

        try {
          await ffmpeg.exec([
            '-i', inputName,
            '-b:a', '128k',
            '-ac', '1',
            '-y',
            `${prefix}compressed.mp3`,
          ])
        } finally {
          ffmpeg.off('progress', progressHandler)
        }
        trackedFiles.push(`${prefix}compressed.mp3`)

        if (isCancelled()) throw new Error('キャンセルされました')

        // Check compressed size
        const compressedRaw = await ffmpeg.readFile(`${prefix}compressed.mp3`) as Uint8Array
        const compressedData = new Uint8Array(compressedRaw)
        const compressedBlob = new Blob([compressedData], { type: 'audio/mpeg' })

        if (compressedBlob.size <= MAX_DIRECT_SIZE) {
          setStatus({ step: 'transcribing', detail: '文字起こし中...', progress: 0 })
          const result = await transcribeChunk(
            new File([compressedBlob], 'audio.mp3', { type: 'audio/mpeg' }),
            'audio.mp3',
            options,
            abortController.signal,
          )
          if (isCancelled()) throw new Error('キャンセルされました')
          await cleanup(ffmpeg, trackedFiles)
          if (isCancelled()) throw new Error('キャンセルされました')
          setStatus({ step: 'done', detail: '', progress: 100 })
          return result
        }

        // Need to split
        setStatus({ step: 'splitting', detail: '音声を分割中...', progress: 0 })
        await ffmpeg.exec([
          '-i', `${prefix}compressed.mp3`,
          '-f', 'segment',
          '-segment_time', String(SEGMENT_SECONDS),
          '-c', 'copy',
          '-y',
          `${prefix}chunk_%03d.mp3`,
        ])

        if (isCancelled()) throw new Error('キャンセルされました')

        // Find chunk files
        const chunkFiles: string[] = []
        for (let i = 0; i < 999; i++) {
          const name = `${prefix}chunk_${String(i).padStart(3, '0')}.mp3`
          try {
            const data = await ffmpeg.readFile(name)
            if (data instanceof Uint8Array && data.length > 0) {
              chunkFiles.push(name)
              trackedFiles.push(name)
            } else {
              break
            }
          } catch {
            break
          }
        }

        if (chunkFiles.length === 0) {
          throw new Error('音声の分割に失敗しました')
        }

        // Get durations for each chunk
        const chunkDurations: number[] = []
        for (const name of chunkFiles) {
          const dur = await getFileDuration(ffmpeg, name)
          chunkDurations.push(dur)
        }

        // Transcribe each chunk
        setStatus({
          step: 'transcribing',
          detail: `0 / ${chunkFiles.length} チャンク`,
          progress: 0,
        })

        const results: string[] = []
        let prevText = options.prompt || ''

        for (let i = 0; i < chunkFiles.length; i++) {
          if (isCancelled()) throw new Error('キャンセルされました')

          setStatus({
            step: 'transcribing',
            detail: `${i + 1} / ${chunkFiles.length} チャンク`,
            progress: Math.round(((i) / chunkFiles.length) * 100),
          })

          const chunkRaw = await ffmpeg.readFile(chunkFiles[i]) as Uint8Array
          const chunkData = new Uint8Array(chunkRaw)
          const chunkBlob = new Blob([chunkData], { type: 'audio/mpeg' })
          const chunkFile = new File([chunkBlob], chunkFiles[i], { type: 'audio/mpeg' })

          let result: string | null = null
          for (let retry = 0; retry <= MAX_RETRIES; retry++) {
            try {
              result = await transcribeChunk(chunkFile, chunkFiles[i], {
                ...options,
                prompt: prevText,
              }, abortController.signal)
              break
            } catch (err) {
              if (isCancelled()) throw new Error('キャンセルされました')
              if (retry === MAX_RETRIES) throw err
              await new Promise((r) => setTimeout(r, 1000 * (retry + 1)))
            }
          }

          results.push(result!)
          prevText = extractLastChars(result!, options.responseFormat, 200)
        }

        // Merge results
        const merged = mergeResults(results, chunkDurations, options.responseFormat)

        if (isCancelled()) throw new Error('キャンセルされました')

        await cleanup(ffmpeg, trackedFiles)
        if (isCancelled()) throw new Error('キャンセルされました')
        setStatus({ step: 'done', detail: '', progress: 100 })
        return merged
      } catch (err) {
        // Cleanup on failure
        const ffmpeg = ffmpegRef.current
        if (ffmpeg && trackedFiles.length > 0) {
          await cleanup(ffmpeg, trackedFiles)
        }
        // Normalize AbortError to cancel message
        if (isCancelled()) throw new Error('キャンセルされました')
        throw err
      }
    },
    [loadFFmpeg, getFileDuration],
  )

  const cancel = useCallback(() => {
    jobIdRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    setStatus({ step: 'idle', detail: '', progress: 0 })
  }, [])

  return { processAndTranscribe, status, cancel }
}

function getExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  return ext ? `.${ext}` : '.bin'
}

async function cleanup(ffmpeg: FFmpeg, files: string[]) {
  for (const f of files) {
    try {
      await ffmpeg.deleteFile(f)
    } catch {
      // ignore
    }
  }
}
