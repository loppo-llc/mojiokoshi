'use client'

import { useState, useRef, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL, fetchFile } from '@ffmpeg/util'
import type { ProcessingStatus, TranscribeOptions, ChunkResult } from '../lib/types'
import { mergeResults } from '../lib/subtitle-merger'

const MAX_DIRECT_SIZE = 25 * 1024 * 1024 // 25MB
const MIN_SEGMENT_SECONDS = 60 // absolute minimum to avoid tiny chunks
const MAX_SEGMENT_SECONDS = 1390 // Whisper API max ~1400s, with margin for -c copy frame rounding
const TARGET_CHUNK_SIZE = 24 * 1024 * 1024 // 24MB (leave 1MB margin under 25MB limit)
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
      let maxSegmentSeconds = MAX_SEGMENT_SECONDS

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
          } else if (/tokens.*too large|too large.*tokens/i.test(msg)) {
            // Token limit exceeded — fall through to ffmpeg split path with reduced segment
            maxSegmentSeconds = Math.min(maxSegmentSeconds, 600)
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

        // Calculate optimal segment duration based on file size and duration
        const totalDuration = await getFileDuration(ffmpeg, inputName)
        const bytesPerSecond = file.size / Math.max(totalDuration, 1)
        const segmentSeconds = Math.min(
          maxSegmentSeconds,
          Math.max(
            MIN_SEGMENT_SECONDS,
            Math.floor(TARGET_CHUNK_SIZE / bytesPerSecond),
          ),
        )

        // Determine split source and parameters
        let splitSource = inputName
        let chunkExt = ext
        let chunkMime = getAudioMimeType(file.name)
        let effectiveSegmentSeconds = segmentSeconds

        if (isCompressedAudio(file.name)) {
          // Test if direct copy extraction works
          const testName = `${prefix}test_chunk${ext}`
          let directCopyOk = false
          try {
            await ffmpeg.exec([
              '-i', inputName, '-ss', '0', '-t', String(segmentSeconds),
              '-c', 'copy', '-y', testName,
            ])
            directCopyOk = true
          } catch { /* direct copy not supported */ }
          try { await ffmpeg.deleteFile(testName) } catch { /* ignore */ }

          if (isCancelled()) throw new Error('error.cancelled')

          if (!directCopyOk) {
            // Fall back: recompress to MP3
            setStatus({ step: 'compressing', detail: 'status.compressingFallback', progress: 0 })

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

            if (compressedBlob.size <= MAX_DIRECT_SIZE) {
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

            splitSource = `${prefix}compressed.mp3`
            chunkExt = '.mp3'
            chunkMime = 'audio/mpeg'
            const compressedBps = compressedBlob.size / Math.max(totalDuration, 1)
            effectiveSegmentSeconds = Math.min(
              maxSegmentSeconds,
              Math.max(MIN_SEGMENT_SECONDS, Math.floor(TARGET_CHUNK_SIZE / compressedBps)),
            )
          }
        } else {
          // Uncompressed audio (wav, flac, etc.): compress first
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

          if (compressedBlob.size <= MAX_DIRECT_SIZE) {
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

          splitSource = `${prefix}compressed.mp3`
          chunkExt = '.mp3'
          chunkMime = 'audio/mpeg'
          const compressedBps = compressedBlob.size / Math.max(totalDuration, 1)
          effectiveSegmentSeconds = Math.min(
            maxSegmentSeconds,
            Math.max(MIN_SEGMENT_SECONDS, Math.floor(TARGET_CHUNK_SIZE / compressedBps)),
          )
        }

        if (isCancelled()) throw new Error('error.cancelled')

        // Interleaved extract + transcribe: extract one chunk, transcribe it, repeat
        const results: string[] = []
        const chunkDurations: number[] = []
        let prevText = options.prompt || ''
        let offset = 0
        let chunkIndex = 0

        while (offset < totalDuration) {
          if (isCancelled()) throw new Error('error.cancelled')

          const estRemaining = Math.ceil(Math.max(0, totalDuration - offset) / effectiveSegmentSeconds)
          const estTotalChunks = Math.max(results.length + estRemaining, results.length + 1)
          setStatus({
            step: 'transcribing',
            detail: 'status.chunkProgress',
            detailParams: { current: results.length + 1, total: estTotalChunks },
            progress: Math.round((offset / totalDuration) * 100),
          })

          // Extract single chunk (frame-level precision is sufficient for transcription)
          const chunkName = `${prefix}chunk_${String(chunkIndex).padStart(3, '0')}${chunkExt}`
          trackedFiles.push(chunkName)

          let chunkData: Uint8Array<ArrayBuffer>
          try {
            await ffmpeg.exec([
              '-i', splitSource,
              '-ss', String(offset),
              '-t', String(effectiveSegmentSeconds),
              '-c', 'copy',
              '-y',
              chunkName,
            ])
            const chunkRaw = await ffmpeg.readFile(chunkName) as Uint8Array
            chunkData = new Uint8Array(chunkRaw) as Uint8Array<ArrayBuffer>
            if (chunkData.length === 0) break
          } catch {
            // Extraction failed — return partial results if any, otherwise fail
            if (results.length > 0) break
            throw new Error('error.splitFailed')
          }

          const dur = await getFileDuration(ffmpeg, chunkName)

          // Skip negligible final chunks (< 1 second) — API often rejects these
          if (dur < 1 && results.length > 0) {
            try { await ffmpeg.deleteFile(chunkName) } catch { /* ignore */ }
            break
          }

          // Save as File for retry
          let chunkFile = new File(
            [new Blob([chunkData], { type: chunkMime })],
            chunkName,
            { type: chunkMime },
          )
          chunkBlobsRef.current[chunkIndex] = chunkFile

          // Free ffmpeg memory
          try { await ffmpeg.deleteFile(chunkName) } catch { /* ignore */ }

          // Handle oversize chunk (rare: high-bitrate compressed audio)
          let chunkBlob: Blob = chunkFile
          let chunkFilename = chunkFile.name

          if (chunkFile.size > MAX_DIRECT_SIZE) {
            const tmpIn = `${prefix}oversize_in${chunkExt}`
            const tmpOut = `${prefix}oversize_out.mp3`
            try {
              await ffmpeg.writeFile(tmpIn, await fetchFile(chunkFile))
              await ffmpeg.exec(['-i', tmpIn, '-b:a', '128k', '-ac', '1', '-y', tmpOut])
              const recompressed = await ffmpeg.readFile(tmpOut) as Uint8Array
              chunkBlob = new Blob([new Uint8Array(recompressed)], { type: 'audio/mpeg' })
              chunkFilename = `chunk_${chunkIndex}.mp3`
              chunkBlobsRef.current[chunkIndex] = new File([chunkBlob], chunkFilename, { type: 'audio/mpeg' })
            } finally {
              try { await ffmpeg.deleteFile(tmpIn) } catch { /* ignore */ }
              try { await ffmpeg.deleteFile(tmpOut) } catch { /* ignore */ }
            }
          }

          // Transcribe with retry (handles token-too-large and corrupted chunk errors)
          let fileToSend = new File([chunkBlob], chunkFilename, { type: chunkBlob.type })
          let result: string | null = null
          let tokenLimitHit = false
          let chunkFailed = false
          for (let retry = 0; retry <= MAX_RETRIES; retry++) {
            try {
              result = await transcribeChunk(fileToSend, chunkFilename, {
                ...options,
                prompt: prevText,
              }, abortController.signal)
              break
            } catch (err) {
              if (isCancelled()) throw new Error('error.cancelled')
              const errMsg = err instanceof Error ? err.message : ''
              if (/tokens.*too large|too large.*tokens/i.test(errMsg)) {
                tokenLimitHit = true
                break
              }
              // Re-encode corrupted chunk and retry (once)
              if (/corrupted|unsupported/i.test(errMsg) && retry === 0) {
                const tmpIn = `${prefix}reencode_in${chunkExt}`
                const tmpOut = `${prefix}reencode_out.mp3`
                try {
                  await ffmpeg.writeFile(tmpIn, await fetchFile(chunkBlob))
                  await ffmpeg.exec(['-i', tmpIn, '-b:a', '128k', '-ac', '1', '-y', tmpOut])
                  const reencoded = await ffmpeg.readFile(tmpOut) as Uint8Array
                  chunkBlob = new Blob([new Uint8Array(reencoded)], { type: 'audio/mpeg' })
                  chunkFilename = `chunk_${chunkIndex}.mp3`
                  fileToSend = new File([chunkBlob], chunkFilename, { type: 'audio/mpeg' })
                  chunkBlobsRef.current[chunkIndex] = new File([chunkBlob], chunkFilename, { type: 'audio/mpeg' })
                } finally {
                  try { await ffmpeg.deleteFile(tmpIn) } catch { /* ignore */ }
                  try { await ffmpeg.deleteFile(tmpOut) } catch { /* ignore */ }
                }
                continue
              }
              if (retry === MAX_RETRIES) {
                chunkFailed = true
                break
              }
              await new Promise((r) => setTimeout(r, 1000 * (retry + 1)))
            }
          }

          if (tokenLimitHit) {
            // Halve segment duration and re-extract from same offset
            const halved = Math.floor(effectiveSegmentSeconds / 2)
            if (halved < MIN_SEGMENT_SECONDS) {
              chunkFailed = true
            } else {
              effectiveSegmentSeconds = halved
              continue
            }
          }

          // Advance offset by actual chunk duration (fall back to segment time if detection failed)
          const advancement = (dur > 0 && dur < effectiveSegmentSeconds * 2) ? dur : effectiveSegmentSeconds

          if (chunkFailed) {
            // Record failed chunk and continue to next
            chunkDurations.push(advancement)
            results.push('')
            offset += advancement

            updateChunkResults((prev) => [
              ...prev,
              {
                index: chunkIndex,
                text: '',
                duration: advancement,
                status: 'error' as const,
                error: 'error.chunkFailed',
              },
            ])
            chunkIndex++
            continue
          }

          chunkDurations.push(advancement)
          results.push(result!)
          prevText = extractLastChars(result!, options.responseFormat, 200)
          offset += advancement

          updateChunkResults((prev) => [
            ...prev,
            {
              index: chunkIndex,
              text: result!,
              duration: advancement,
              status: 'done' as const,
            },
          ])
          chunkIndex++
        }

        if (results.length === 0) throw new Error('error.splitFailed')

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
