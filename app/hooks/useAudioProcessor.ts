'use client'

import { useState, useRef, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL, fetchFile } from '@ffmpeg/util'
import type { ProcessingStatus, TranscribeOptions, ChunkResult } from '../lib/types'
import { mergeResults } from '../lib/subtitle-merger'
import { transcribeChunk, extractLastChars } from '../lib/transcribe'
import {
  compressAudio,
  splitIntoChunks,
  recoverCorruptChunk,
  getFileDuration,
  getExtension,
  cleanupFiles,
  type ChunkInfo,
} from '../lib/ffmpeg-pipeline'

const MAX_DIRECT_SIZE = 25 * 1024 * 1024 // 25MB
const MIN_SEGMENT_SECONDS = 60
const MAX_SEGMENT_SECONDS = 1390
const TARGET_CHUNK_SIZE = 24 * 1024 * 1024
const MAX_RETRIES = 2

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

  const retryChunk = useCallback(
    async (index: number): Promise<string> => {
      const opts = jobOptionsRef.current
      if (!opts) throw new Error('error.noOptions')

      const chunkFile = chunkBlobsRef.current[index]
      if (!chunkFile) throw new Error('error.noChunkData')

      const retryJobId = jobIdRef.current
      const abortController = new AbortController()

      const origChunk = chunkResultsRef.current.find((c) => c.index === index)
      const origStatus = origChunk?.status || 'error'

      updateChunkResults((prev) =>
        prev.map((c) => (c.index === index ? { ...c, status: 'retrying' as const } : c)),
      )

      try {
        let prompt = initialPromptRef.current
        const prevChunk = chunkResultsRef.current.find((c) => c.index === index - 1)
        if (prevChunk?.text) {
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
          if (!/corrupted|unsupported/i.test(errMsg)) throw firstErr

          try {
            const ffmpeg = await loadFFmpeg()
            fileToSend = await recoverCorruptChunk(ffmpeg, fileToSend, index, Date.now())
          } catch {
            throw firstErr
          }

          if (jobIdRef.current !== retryJobId) throw new Error('error.cancelled')
          chunkBlobsRef.current[index] = fileToSend
          result = await transcribeChunk(fileToSend, fileToSend.name, {
            ...opts,
            prompt,
          }, abortController.signal)
        }

        if (jobIdRef.current !== retryJobId) throw new Error('error.cancelled')

        let merged = ''
        updateChunkResults((prev) => {
          const next = prev.map((c) =>
            c.index === index ? { ...c, text: result, status: 'done' as const, error: undefined } : c,
          )
          const texts = next.map((c) => c.text)
          const durations = next.map((c) => c.duration)
          const starts = next.map((c) => c.startTime)
          try {
            merged = mergeResults(texts, durations, opts.responseFormat, starts)
          } catch {
            merged = texts.join('\n')
          }
          return next
        })
        return merged
      } catch (err) {
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
      const currentJobId = ++jobIdRef.current
      const abortController = new AbortController()
      abortRef.current = abortController

      clearChunks()
      initialPromptRef.current = options.prompt || ''
      jobOptionsRef.current = options

      const isCancelled = () => jobIdRef.current !== currentJobId || abortController.signal.aborted
      let maxSegmentSeconds = MAX_SEGMENT_SECONDS
      let mustSplit = false

      // Small file: try direct transcribe
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
          const durationMatch = msg.match(/duration\s+[\d.]+\s+seconds\s+is\s+longer\s+than\s+([\d.]+)\s+seconds/i)
          if (durationMatch) {
            maxSegmentSeconds = Math.max(MIN_SEGMENT_SECONDS, Math.floor(parseFloat(durationMatch[1])) - 10)
            mustSplit = true
          } else if (/tokens.*too large|too large.*tokens/i.test(msg)) {
            maxSegmentSeconds = Math.min(maxSegmentSeconds, 600)
            mustSplit = true
          } else {
            setStatus({ step: 'error', detail: msg || 'error.generic', progress: 0 })
            throw err
          }
        }
      }

      // Large file: FFmpeg pipeline
      const trackedFiles: string[] = []

      try {
        setStatus({ step: 'loading-ffmpeg', detail: 'status.loadingFfmpeg', progress: 0 })
        const ffmpeg = await loadFFmpeg()
        if (isCancelled()) throw new Error('error.cancelled')

        const prefix = `j${currentJobId}_`
        const inputName = `${prefix}input${getExtension(file.name)}`
        trackedFiles.push(inputName)
        await ffmpeg.writeFile(inputName, await fetchFile(file))
        if (isCancelled()) throw new Error('error.cancelled')

        const totalDuration = await getFileDuration(ffmpeg, inputName)
        const OUTPUT_BPS = 128000 / 8
        const effectiveSegmentSeconds = Math.min(
          maxSegmentSeconds,
          Math.max(MIN_SEGMENT_SECONDS, Math.floor(TARGET_CHUNK_SIZE / OUTPUT_BPS)),
        )

        // Compress
        setStatus({ step: 'compressing', detail: 'status.compressing', progress: 0 })
        const compressedName = `${prefix}compressed.mp3`
        trackedFiles.push(compressedName)
        const compressedBlob = await compressAudio(ffmpeg, inputName, compressedName, (p) => {
          if (!isCancelled()) setStatus((prev) => ({ ...prev, progress: Math.round(p * 100) }))
        })
        if (isCancelled()) throw new Error('error.cancelled')

        // If compressed fits, send directly
        if (!mustSplit && compressedBlob.size <= MAX_DIRECT_SIZE && totalDuration <= maxSegmentSeconds) {
          setStatus({ step: 'transcribing', detail: 'status.transcribing', progress: 0 })
          const result = await transcribeChunk(
            new File([compressedBlob], 'audio.mp3', { type: 'audio/mpeg' }),
            'audio.mp3', options, abortController.signal,
          )
          if (isCancelled()) throw new Error('error.cancelled')
          await cleanupFiles(ffmpeg, trackedFiles)
          setStatus({ step: 'done', detail: '', progress: 100 })
          return result
        }
        if (isCancelled()) throw new Error('error.cancelled')

        // Split
        setStatus({ step: 'transcribing', detail: 'status.splitting', progress: 0 })
        const chunks = await splitIntoChunks(ffmpeg, compressedName, prefix, effectiveSegmentSeconds)
        if (isCancelled()) throw new Error('error.cancelled')
        if (chunks.length === 0) throw new Error('error.splitFailed')

        // Store blobs for retry
        chunks.forEach((c, i) => { chunkBlobsRef.current[i] = c.file })

        // Transcribe chunks sequentially
        const merged = await transcribeAllChunks(
          chunks, options, abortController.signal, isCancelled,
          setStatus, updateChunkResults,
        )

        if (isCancelled()) throw new Error('error.cancelled')
        await cleanupFiles(ffmpeg, trackedFiles)
        setStatus({ step: 'done', detail: '', progress: 100 })
        return merged
      } catch (err) {
        const ffmpeg = ffmpegRef.current
        if (ffmpeg && trackedFiles.length > 0) await cleanupFiles(ffmpeg, trackedFiles)
        if (isCancelled()) throw new Error('error.cancelled')
        const errMsg = err instanceof Error ? err.message : 'error.generic'
        setStatus({ step: 'error', detail: errMsg, progress: 0 })
        throw err
      }
    },
    [loadFFmpeg, clearChunks, updateChunkResults],
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

async function transcribeAllChunks(
  chunks: ChunkInfo[],
  options: TranscribeOptions,
  signal: AbortSignal,
  isCancelled: () => boolean,
  setStatus: (s: ProcessingStatus | ((prev: ProcessingStatus) => ProcessingStatus)) => void,
  updateChunkResults: (updater: (prev: ChunkResult[]) => ChunkResult[]) => void,
): Promise<string> {
  const results: string[] = []
  const chunkDurations: number[] = []
  let prevText = options.prompt || ''

  for (let i = 0; i < chunks.length; i++) {
    if (isCancelled()) throw new Error('error.cancelled')

    const { file: chunkFile, duration: dur, startTime, endTime } = chunks[i]

    setStatus({
      step: 'transcribing',
      detail: 'status.chunkProgress',
      detailParams: { current: i + 1, total: chunks.length },
      progress: Math.round(((i + 1) / chunks.length) * 100),
    })

    const result = await transcribeWithRetry(chunkFile, prevText, options, signal, isCancelled)
    chunkDurations.push(dur)

    if (result === null) {
      results.push('')
      updateChunkResults((prev) => [
        ...prev,
        { index: i, text: '', duration: dur, startTime, endTime, status: 'error' as const, error: 'error.chunkFailed' },
      ])
    } else {
      results.push(result)
      prevText = extractLastChars(result, options.responseFormat, 200)
      updateChunkResults((prev) => [
        ...prev,
        { index: i, text: result, duration: dur, startTime, endTime, status: 'done' as const },
      ])
    }
  }

  if (results.every((r) => r === '')) throw new Error('error.splitFailed')

  const chunkStartTimes = chunks.map((c) => c.startTime)
  return mergeResults(results, chunkDurations, options.responseFormat, chunkStartTimes)
}

async function transcribeWithRetry(
  chunkFile: File,
  prompt: string,
  options: TranscribeOptions,
  signal: AbortSignal,
  isCancelled: () => boolean,
): Promise<string | null> {
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    try {
      return await transcribeChunk(chunkFile, chunkFile.name, {
        ...options,
        prompt,
      }, signal)
    } catch (err) {
      if (isCancelled()) throw new Error('error.cancelled')
      if (retry === MAX_RETRIES) return null
      await new Promise((r) => setTimeout(r, 1000 * (retry + 1)))
    }
  }
  return null
}
