'use client'

import { useState, useRef, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL, fetchFile } from '@ffmpeg/util'
import type { ProcessingStatus, TranscribeOptions, ChunkResult } from '../lib/types'
import { mergeResults } from '../lib/subtitle-merger'

const MAX_DIRECT_SIZE = 25 * 1024 * 1024 // 25MB
const SEGMENT_SECONDS = 600 // 10 minutes
const MAX_RETRIES = 2

const COMPRESSED_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'webm', 'mp4', 'opus', 'mpeg', 'mpga'])

function isCompressedAudio(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return COMPRESSED_EXTENSIONS.has(ext)
}

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  opus: 'audio/ogg',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
}

function getAudioMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return MIME_BY_EXT[ext] || 'audio/mpeg'
}

async function transcribeChunk(
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
  const [chunkResults, setChunkResults] = useState<ChunkResult[]>([])
  const chunkResultsRef = useRef<ChunkResult[]>([])

  const ffmpegRef = useRef<FFmpeg | null>(null)
  const jobIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const chunkBlobsRef = useRef<File[]>([])
  const initialPromptRef = useRef('')
  const jobOptionsRef = useRef<TranscribeOptions | null>(null)

  const updateChunkResults = useCallback((updater: (prev: ChunkResult[]) => ChunkResult[]) => {
    setChunkResults((prev) => {
      const next = updater(prev)
      chunkResultsRef.current = next
      return next
    })
  }, [])

  const clearChunks = useCallback(() => {
    chunkBlobsRef.current = []
    chunkResultsRef.current = []
    jobOptionsRef.current = null
    setChunkResults([])
  }, [])

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

  const retryChunk = useCallback(
    async (index: number): Promise<string> => {
      const opts = jobOptionsRef.current
      if (!opts) throw new Error('error.noOptions')

      const chunkFile = chunkBlobsRef.current[index]
      if (!chunkFile) throw new Error('error.noChunkData')

      const retryJobId = jobIdRef.current
      const abortController = new AbortController()
      abortRef.current = abortController

      // Mark as retrying
      updateChunkResults((prev) =>
        prev.map((c) => (c.index === index ? { ...c, status: 'retrying' as const } : c)),
      )

      try {
        // Build prompt from previous chunk
        let prompt = initialPromptRef.current
        const currentResults = chunkResultsRef.current
        if (index > 0 && currentResults[index - 1]) {
          prompt = extractLastChars(currentResults[index - 1].text, opts.responseFormat, 200)
        }

        const result = await transcribeChunk(chunkFile, chunkFile.name, {
          ...opts,
          prompt,
        }, abortController.signal)

        // Check if job changed during retry
        if (jobIdRef.current !== retryJobId) throw new Error('error.cancelled')

        // Update chunk result
        updateChunkResults((prev) =>
          prev.map((c) =>
            c.index === index ? { ...c, text: result, status: 'done' as const } : c,
          ),
        )

        // Re-merge all results
        const updatedResults = chunkResultsRef.current.map((c) =>
          c.index === index ? { ...c, text: result } : c,
        )
        const texts = updatedResults.map((c) => c.text)
        const durations = updatedResults.map((c) => c.duration)
        return mergeResults(texts, durations, opts.responseFormat)
      } catch (err) {
        // Revert status to done on failure (only if same job)
        if (jobIdRef.current === retryJobId) {
          updateChunkResults((prev) =>
            prev.map((c) => (c.index === index ? { ...c, status: 'done' as const } : c)),
          )
        }
        throw err
      }
    },
    [updateChunkResults],
  )

  const processAndTranscribe = useCallback(
    async (file: File, options: TranscribeOptions): Promise<string> => {
      // Increment job ID to invalidate any previous job
      const currentJobId = ++jobIdRef.current
      const abortController = new AbortController()
      abortRef.current = abortController

      clearChunks()
      initialPromptRef.current = options.prompt || ''
      jobOptionsRef.current = options

      const isCancelled = () => jobIdRef.current !== currentJobId || abortController.signal.aborted

      // Small file: direct transcribe
      if (file.size <= MAX_DIRECT_SIZE) {
        setStatus({ step: 'transcribing', detail: 'status.transcribing', progress: 0 })
        try {
          const result = await transcribeChunk(file, file.name, options, abortController.signal)
          if (isCancelled()) throw new Error('error.cancelled')
          setStatus({ step: 'done', detail: '', progress: 100 })
          return result
        } catch (err) {
          if (isCancelled()) throw new Error('error.cancelled')
          const msg = err instanceof Error ? err.message : 'error.generic'
          setStatus({ step: 'error', detail: msg, progress: 0 })
          throw err
        }
      }

      // Large file: need ffmpeg
      const trackedFiles: string[] = []

      try {
        setStatus({ step: 'loading-ffmpeg', detail: 'status.loadingFfmpeg', progress: 0 })
        const ffmpeg = await loadFFmpeg()

        if (isCancelled()) throw new Error('error.cancelled')

        const prefix = `j${currentJobId}_`
        const ext = getExtension(file.name)
        const inputName = `${prefix}input${ext}`
        trackedFiles.push(inputName)
        await ffmpeg.writeFile(inputName, await fetchFile(file))

        if (isCancelled()) throw new Error('error.cancelled')

        let chunkExt = '.mp3'
        let chunkMime = 'audio/mpeg'

        if (isCompressedAudio(file.name)) {
          // Compressed audio: try splitting directly without recompression
          let directSplitOk = false
          try {
            setStatus({ step: 'splitting', detail: 'status.splitting', progress: 0 })
            await ffmpeg.exec([
              '-i', inputName,
              '-f', 'segment',
              '-segment_time', String(SEGMENT_SECONDS),
              '-c', 'copy',
              '-y',
              `${prefix}chunk_%03d${ext}`,
            ])
            chunkExt = ext
            chunkMime = getAudioMimeType(file.name)
            directSplitOk = true
          } catch {
            // Direct split failed (container quirks, etc.) — clean up partial chunks
            for (let i = 0; i < 999; i++) {
              const name = `${prefix}chunk_${String(i).padStart(3, '0')}${ext}`
              try { await ffmpeg.deleteFile(name) } catch { break }
            }
          }

          if (isCancelled()) throw new Error('error.cancelled')

          if (!directSplitOk) {
            // Fall back: recompress to MP3 then split
            setStatus({ step: 'compressing', detail: 'status.compressingFallback', progress: 0 })

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

            if (isCancelled()) throw new Error('error.cancelled')

            const compressedRaw = await ffmpeg.readFile(`${prefix}compressed.mp3`) as Uint8Array
            const compressedData = new Uint8Array(compressedRaw)
            const compressedBlob = new Blob([compressedData], { type: 'audio/mpeg' })

            if (compressedBlob.size <= MAX_DIRECT_SIZE) {
              setStatus({ step: 'transcribing', detail: 'status.transcribing', progress: 0 })
              const result = await transcribeChunk(
                new File([compressedBlob], 'audio.mp3', { type: 'audio/mpeg' }),
                'audio.mp3',
                options,
                abortController.signal,
              )
              if (isCancelled()) throw new Error('error.cancelled')
              await cleanup(ffmpeg, trackedFiles)
              if (isCancelled()) throw new Error('error.cancelled')
              setStatus({ step: 'done', detail: '', progress: 100 })
              return result
            }

            chunkExt = '.mp3'
            chunkMime = 'audio/mpeg'

            setStatus({ step: 'splitting', detail: 'status.splitting', progress: 0 })
            await ffmpeg.exec([
              '-i', `${prefix}compressed.mp3`,
              '-f', 'segment',
              '-segment_time', String(SEGMENT_SECONDS),
              '-c', 'copy',
              '-y',
              `${prefix}chunk_%03d.mp3`,
            ])
          }
        } else {
          // Uncompressed audio (wav, flac, etc.): compress first
          setStatus({ step: 'compressing', detail: 'status.compressing', progress: 0 })

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

          if (isCancelled()) throw new Error('error.cancelled')

          // Check compressed size
          const compressedRaw = await ffmpeg.readFile(`${prefix}compressed.mp3`) as Uint8Array
          const compressedData = new Uint8Array(compressedRaw)
          const compressedBlob = new Blob([compressedData], { type: 'audio/mpeg' })

          if (compressedBlob.size <= MAX_DIRECT_SIZE) {
            setStatus({ step: 'transcribing', detail: 'status.transcribing', progress: 0 })
            const result = await transcribeChunk(
              new File([compressedBlob], 'audio.mp3', { type: 'audio/mpeg' }),
              'audio.mp3',
              options,
              abortController.signal,
            )
            if (isCancelled()) throw new Error('error.cancelled')
            await cleanup(ffmpeg, trackedFiles)
            if (isCancelled()) throw new Error('error.cancelled')
            setStatus({ step: 'done', detail: '', progress: 100 })
            return result
          }

          // Still too large: split compressed file
          chunkExt = '.mp3'
          chunkMime = 'audio/mpeg'

          setStatus({ step: 'splitting', detail: 'status.splitting', progress: 0 })
          await ffmpeg.exec([
            '-i', `${prefix}compressed.mp3`,
            '-f', 'segment',
            '-segment_time', String(SEGMENT_SECONDS),
            '-c', 'copy',
            '-y',
            `${prefix}chunk_%03d.mp3`,
          ])
        }

        if (isCancelled()) throw new Error('error.cancelled')

        // Find chunk files
        const chunkFiles: string[] = []
        for (let i = 0; i < 999; i++) {
          const name = `${prefix}chunk_${String(i).padStart(3, '0')}${chunkExt}`
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
          throw new Error('error.splitFailed')
        }

        // Get durations for each chunk and save chunk File objects
        const chunkDurations: number[] = []
        for (let i = 0; i < chunkFiles.length; i++) {
          const dur = await getFileDuration(ffmpeg, chunkFiles[i])
          chunkDurations.push(dur)

          // Save chunk as File for retry
          const chunkRaw = await ffmpeg.readFile(chunkFiles[i]) as Uint8Array
          const chunkData = new Uint8Array(chunkRaw)
          const chunkFilename = chunkFiles[i]
          const chunkFile = new File(
            [new Blob([chunkData], { type: chunkMime })],
            chunkFilename,
            { type: chunkMime },
          )
          chunkBlobsRef.current[i] = chunkFile
        }
        // Transcribe each chunk
        setStatus({
          step: 'transcribing',
          detail: 'status.chunkProgress',
          detailParams: { current: 0, total: chunkFiles.length },
          progress: 0,
        })

        const results: string[] = []
        let prevText = options.prompt || ''

        for (let i = 0; i < chunkFiles.length; i++) {
          if (isCancelled()) throw new Error('error.cancelled')

          setStatus({
            step: 'transcribing',
            detail: 'status.chunkProgress',
            detailParams: { current: i + 1, total: chunkFiles.length },
            progress: Math.round(((i) / chunkFiles.length) * 100),
          })

          const chunkFile = chunkBlobsRef.current[i]

          let chunkBlob: Blob = chunkFile
          let chunkFilename = chunkFile.name

          if (chunkFile.size > MAX_DIRECT_SIZE) {
            // Rare: chunk exceeds 25MB (high-bitrate compressed audio)
            const tmpIn = `${prefix}oversize_in${chunkExt}`
            const tmpOut = `${prefix}oversize_out.mp3`
            trackedFiles.push(tmpIn, tmpOut)
            try {
              await ffmpeg.writeFile(tmpIn, await fetchFile(chunkFile))
              await ffmpeg.exec(['-i', tmpIn, '-b:a', '128k', '-ac', '1', '-y', tmpOut])
              const recompressed = await ffmpeg.readFile(tmpOut) as Uint8Array
              chunkBlob = new Blob([new Uint8Array(recompressed)], { type: 'audio/mpeg' })
              chunkFilename = `chunk_${i}.mp3`
              // Update stored blob for retry
              chunkBlobsRef.current[i] = new File([chunkBlob], chunkFilename, { type: 'audio/mpeg' })
            } finally {
              try { await ffmpeg.deleteFile(tmpIn) } catch { /* ignore */ }
              try { await ffmpeg.deleteFile(tmpOut) } catch { /* ignore */ }
            }
          }

          const fileToSend = new File([chunkBlob], chunkFilename, { type: chunkBlob.type })

          let result: string | null = null
          for (let retry = 0; retry <= MAX_RETRIES; retry++) {
            try {
              result = await transcribeChunk(fileToSend, chunkFilename, {
                ...options,
                prompt: prevText,
              }, abortController.signal)
              break
            } catch (err) {
              if (isCancelled()) throw new Error('error.cancelled')
              if (retry === MAX_RETRIES) throw err
              await new Promise((r) => setTimeout(r, 1000 * (retry + 1)))
            }
          }

          results.push(result!)
          prevText = extractLastChars(result!, options.responseFormat, 200)

          // Save chunk result
          updateChunkResults((prev) => [
            ...prev,
            {
              index: i,
              text: result!,
              duration: chunkDurations[i],
              status: 'done' as const,
            },
          ])
        }

        // Merge results
        const merged = mergeResults(results, chunkDurations, options.responseFormat)

        if (isCancelled()) throw new Error('error.cancelled')

        await cleanup(ffmpeg, trackedFiles)
        if (isCancelled()) throw new Error('error.cancelled')
        setStatus({ step: 'done', detail: '', progress: 100 })
        return merged
      } catch (err) {
        // Cleanup on failure
        const ffmpeg = ffmpegRef.current
        if (ffmpeg && trackedFiles.length > 0) {
          await cleanup(ffmpeg, trackedFiles)
        }
        // Normalize AbortError to cancel message
        if (isCancelled()) throw new Error('error.cancelled')
        throw err
      }
    },
    [loadFFmpeg, getFileDuration, clearChunks, updateChunkResults],
  )

  const cancel = useCallback(() => {
    jobIdRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    clearChunks()
    setStatus({ step: 'idle', detail: '', progress: 0 })
  }, [clearChunks])

  return { processAndTranscribe, status, cancel, chunkResults, retryChunk }
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
