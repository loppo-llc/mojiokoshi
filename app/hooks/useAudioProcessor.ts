'use client'

import { useState, useRef, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL, fetchFile } from '@ffmpeg/util'
import type { ProcessingStatus, TranscribeOptions, ChunkResult } from '../lib/types'
import { mergeResults } from '../lib/subtitle-merger'

const MAX_DIRECT_SIZE = 25 * 1024 * 1024 // 25MB
const MIN_SEGMENT_SECONDS = 60 // absolute minimum to avoid tiny chunks
const MAX_SEGMENT_SECONDS = 1390 // Whisper API max ~1400s, with safety margin
const TARGET_CHUNK_SIZE = 24 * 1024 * 1024 // 24MB (leave 1MB margin under 25MB limit)
const MAX_RETRIES = 2

const COMPRESSED_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'webm', 'mp4', 'opus', 'mpeg', 'mpga'])

function isCompressedAudio(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return COMPRESSED_EXTENSIONS.has(ext)
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
        parseInt(match[4]) / Math.pow(10, match[4].length)
      )
    }
    return 600 // fallback: assume 10 minutes if duration detection fails
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

      // Save original status before marking as retrying
      const origChunk = chunkResultsRef.current.find((c) => c.index === index)
      const origStatus = origChunk?.status || 'error'

      // Mark as retrying
      updateChunkResults((prev) =>
        prev.map((c) => (c.index === index ? { ...c, status: 'retrying' as const } : c)),
      )

      try {
        // Build prompt from previous chunk (find by index, not array position)
        let prompt = initialPromptRef.current
        const currentResults = chunkResultsRef.current
        const prevChunk = currentResults.find((c) => c.index === index - 1)
        if (prevChunk && prevChunk.text) {
          prompt = extractLastChars(prevChunk.text, opts.responseFormat, 200)
        }

        let fileToSend: File = chunkFile
        let result: string
        try {
          result = await transcribeChunk(fileToSend, fileToSend.name, {
            ...opts,
            prompt,
          }, abortController.signal)
        } catch (firstErr) {
          if (jobIdRef.current !== retryJobId) throw new Error('error.cancelled')
          const errMsg = firstErr instanceof Error ? firstErr.message : ''
          // Re-encode corrupted chunk via ffmpeg and retry once
          if (!/corrupted|unsupported/i.test(errMsg)) throw firstErr

          // Re-encode to MP3; on failure rethrow the original API error
          let reencoded = false
          const nonce = Date.now()
          const tmpIn = `retry_${retryJobId}_${index}_${nonce}_in${getExtension(fileToSend.name)}`
          const tmpOut = `retry_${retryJobId}_${index}_${nonce}_out.mp3`
          let ffmpeg: FFmpeg | null = null
          try {
            ffmpeg = await loadFFmpeg()
            await ffmpeg.writeFile(tmpIn, await fetchFile(fileToSend))
            await ffmpeg.exec(['-i', tmpIn, '-b:a', '128k', '-ac', '1', '-y', tmpOut])
            const raw = await ffmpeg.readFile(tmpOut) as Uint8Array
            const blob = new Blob([new Uint8Array(raw)], { type: 'audio/mpeg' })
            const name = `chunk_${index}.mp3`
            fileToSend = new File([blob], name, { type: 'audio/mpeg' })
            reencoded = true
          } catch {
            throw firstErr
          } finally {
            if (ffmpeg) {
              try { await ffmpeg.deleteFile(tmpIn) } catch { /* ignore */ }
              try { await ffmpeg.deleteFile(tmpOut) } catch { /* ignore */ }
            }
          }

          if (jobIdRef.current !== retryJobId) throw new Error('error.cancelled')
          if (reencoded) chunkBlobsRef.current[index] = fileToSend
          result = await transcribeChunk(fileToSend, fileToSend.name, {
            ...opts,
            prompt,
          }, abortController.signal)
        }

        // Check if job changed during retry
        if (jobIdRef.current !== retryJobId) throw new Error('error.cancelled')

        // Update chunk result and re-merge. mergeResults runs inside the
        // updater so it always sees the latest prev state. try-catch
        // prevents a merge exception from crashing React's render phase.
        let merged = ''
        updateChunkResults((prev) => {
          const next = prev.map((c) =>
            c.index === index ? { ...c, text: result, status: 'done' as const, error: undefined } : c,
          )
          const texts = next.map((c) => c.text)
          const durations = next.map((c) => c.duration)
          try {
            merged = mergeResults(texts, durations, opts.responseFormat)
          } catch {
            merged = texts.join('\n')
          }
          return next
        })
        return merged
      } catch (err) {
        // Revert to original status on failure (only if same job)
        if (jobIdRef.current === retryJobId) {
          updateChunkResults((prev) =>
            prev.map((c) => (c.index === index ? { ...c, status: origStatus } : c)),
          )
        }
        throw err
      }
    },
    [updateChunkResults, loadFFmpeg],
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
      let maxSegmentSeconds = MAX_SEGMENT_SECONDS
      let mustSplit = false // set when initial direct transcribe fails with token/duration limit

      // Small file: try direct transcribe, fall through to split if duration exceeded
      if (file.size <= MAX_DIRECT_SIZE) {
        setStatus({ step: 'transcribing', detail: 'status.transcribing', progress: 0 })
        try {
          const result = await transcribeChunk(file, file.name, options, abortController.signal)
          if (isCancelled()) throw new Error('error.cancelled')
          setStatus({ step: 'done', detail: '', progress: 100 })
          return result
        } catch (err) {
          if (isCancelled()) throw new Error('error.cancelled')
          const msg = err instanceof Error ? err.message : ''
          // Detect duration-exceeded error: "audio duration X seconds is longer than Y seconds ..."
          const durationMatch = msg.match(/duration\s+[\d.]+\s+seconds\s+is\s+longer\s+than\s+([\d.]+)\s+seconds/i)
          if (durationMatch) {
            // Extract model-specific max duration and fall through to ffmpeg split path
            maxSegmentSeconds = Math.max(MIN_SEGMENT_SECONDS, Math.floor(parseFloat(durationMatch[1])) - 10)
            mustSplit = true
          } else if (/tokens.*too large|too large.*tokens/i.test(msg)) {
            // Token limit exceeded — fall through to ffmpeg split path with reduced segment
            maxSegmentSeconds = Math.min(maxSegmentSeconds, 600)
            mustSplit = true
          } else {
            setStatus({ step: 'error', detail: msg || 'error.generic', progress: 0 })
            throw err
          }
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

        // Calculate total duration and segment size
        const totalDuration = await getFileDuration(ffmpeg, inputName)
        const OUTPUT_BPS = 128000 / 8 // 16000 bytes/second for 128kbps mono MP3
        const effectiveSegmentSeconds = Math.min(
          maxSegmentSeconds,
          Math.max(MIN_SEGMENT_SECONDS, Math.floor(TARGET_CHUNK_SIZE / OUTPUT_BPS)),
        )

        // For uncompressed audio, re-encode to MP3 first (reduces size for
        // the "fits in 25MB" shortcut and for the segment muxer source).
        // For compressed audio, use the original file directly.
        let segmentSource = inputName
        if (!isCompressedAudio(file.name)) {
          setStatus({ step: 'compressing', detail: 'status.compressing', progress: 0 })
          const progressHandler = ({ progress }: { progress: number }) => {
            if (isCancelled()) return
            setStatus((prev) => ({ ...prev, progress: Math.round(progress * 100) }))
          }
          ffmpeg.on('progress', progressHandler)
          try {
            await ffmpeg.exec([
              '-i', inputName, '-b:a', '128k', '-ac', '1', '-y', `${prefix}compressed.mp3`,
            ])
          } finally {
            ffmpeg.off('progress', progressHandler)
          }
          trackedFiles.push(`${prefix}compressed.mp3`)
          if (isCancelled()) throw new Error('error.cancelled')

          const compressedRaw = await ffmpeg.readFile(`${prefix}compressed.mp3`) as Uint8Array
          const compressedBlob = new Blob([new Uint8Array(compressedRaw)], { type: 'audio/mpeg' })

          if (!mustSplit && compressedBlob.size <= MAX_DIRECT_SIZE && totalDuration <= maxSegmentSeconds) {
            setStatus({ step: 'transcribing', detail: 'status.transcribing', progress: 0 })
            const result = await transcribeChunk(
              new File([compressedBlob], 'audio.mp3', { type: 'audio/mpeg' }),
              'audio.mp3', options, abortController.signal,
            )
            if (isCancelled()) throw new Error('error.cancelled')
            await cleanup(ffmpeg, trackedFiles)
            setStatus({ step: 'done', detail: '', progress: 100 })
            return result
          }
          segmentSource = `${prefix}compressed.mp3`
        }

        if (isCancelled()) throw new Error('error.cancelled')

        // Split using segment muxer — reads linearly, no seeking.
        // -ss/-t seeking in ffmpeg WASM is broken (wrong offsets or silence).
        // -segment_list gives exact start/end times (getFileDuration is
        // unreliable for MP3 chunks created by the segment muxer).
        setStatus({ step: 'transcribing', detail: 'status.chunkProgress', detailParams: { current: 0, total: '?' }, progress: 0 })
        const chunkPattern = `${prefix}chunk_%03d.mp3`
        const segListFile = `${prefix}segments.csv`
        await ffmpeg.exec([
          '-i', segmentSource,
          '-f', 'segment',
          '-segment_time', String(effectiveSegmentSeconds),
          '-segment_list', segListFile,
          '-segment_list_type', 'csv',
          '-b:a', '128k', '-ac', '1',
          '-y', chunkPattern,
        ])

        if (isCancelled()) throw new Error('error.cancelled')

        // Parse segment list for timing info (each line: filename,start,end)
        const segListRaw = await ffmpeg.readFile(segListFile) as Uint8Array
        const segListText = new TextDecoder().decode(segListRaw)
        const segLines = segListText.trim().split('\n').filter(Boolean)
        try { await ffmpeg.deleteFile(segListFile) } catch { /* ignore */ }

        // Read chunks into JS memory using segment list for timing
        type ChunkInfo = { file: File; duration: number; startTime: number; endTime: number }
        const chunks: ChunkInfo[] = []
        for (let i = 0; i < segLines.length; i++) {
          const parts = segLines[i].split(',')
          const name = parts[0] || `${prefix}chunk_${String(i).padStart(3, '0')}.mp3`
          const segStart = parseFloat(parts[1]) || 0
          const segEnd = parseFloat(parts[2]) || 0
          const dur = segEnd - segStart

          // Skip negligible final chunks (< 1 second)
          if (dur < 1 && chunks.length > 0) {
            try { await ffmpeg.deleteFile(name) } catch { /* ignore */ }
            continue
          }

          let raw: Uint8Array
          try {
            raw = await ffmpeg.readFile(name) as Uint8Array
          } catch { break }
          if (raw.length === 0) {
            try { await ffmpeg.deleteFile(name) } catch { /* ignore */ }
            break
          }

          const chunkFile = new File(
            [new Blob([new Uint8Array(raw)], { type: 'audio/mpeg' })],
            name,
            { type: 'audio/mpeg' },
          )
          chunks.push({ file: chunkFile, duration: dur, startTime: segStart, endTime: segEnd })
          if (!isCancelled()) chunkBlobsRef.current[chunks.length - 1] = chunkFile
          trackedFiles.push(name)
          try { await ffmpeg.deleteFile(name) } catch { /* ignore */ }
        }

        if (chunks.length === 0) throw new Error('error.splitFailed')

        // Transcribe chunks sequentially
        const results: string[] = []
        const chunkDurations: number[] = []
        let prevText = options.prompt || ''

        for (let i = 0; i < chunks.length; i++) {
          if (isCancelled()) throw new Error('error.cancelled')

          const { file: chunkFile, duration: dur, startTime: chunkStart, endTime: chunkEnd } = chunks[i]

          setStatus({
            step: 'transcribing',
            detail: 'status.chunkProgress',
            detailParams: { current: i + 1, total: chunks.length },
            progress: Math.round(((i + 1) / chunks.length) * 100),
          })

          let result: string | null = null
          let chunkFailed = false
          try {
            for (let retry = 0; retry <= MAX_RETRIES; retry++) {
              try {
                result = await transcribeChunk(chunkFile, chunkFile.name, {
                  ...options,
                  prompt: prevText,
                }, abortController.signal)
                break
              } catch (err) {
                if (isCancelled()) throw new Error('error.cancelled')
                if (retry === MAX_RETRIES) { chunkFailed = true; break }
                await new Promise((r) => setTimeout(r, 1000 * (retry + 1)))
              }
            }
          } catch (err) {
            if (isCancelled()) throw new Error('error.cancelled')
            chunkFailed = true
          }

          chunkDurations.push(dur)

          if (chunkFailed) {
            results.push('')
            updateChunkResults((prev) => [
              ...prev,
              { index: i, text: '', duration: dur, startTime: chunkStart, endTime: chunkEnd, status: 'error' as const, error: 'error.chunkFailed' },
            ])
          } else {
            results.push(result!)
            prevText = extractLastChars(result!, options.responseFormat, 200)
            updateChunkResults((prev) => [
              ...prev,
              { index: i, text: result!, duration: dur, startTime: chunkStart, endTime: chunkEnd, status: 'done' as const },
            ])
          }
        }

        if (results.every((r) => r === '')) throw new Error('error.splitFailed')

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
