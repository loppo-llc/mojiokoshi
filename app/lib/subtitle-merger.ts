/**
 * Merge transcription results from multiple chunks.
 * Handles timestamp offsetting for SRT/VTT formats.
 */

export function mergeResults(
  results: string[],
  chunkDurations: number[],
  format: string,
): string {
  if (results.length === 0) return ''
  if (results.length === 1) return results[0]

  switch (format) {
    case 'text':
      return mergeText(results)
    case 'json':
      return mergeJson(results)
    case 'verbose_json':
      return mergeVerboseJson(results, chunkDurations)
    case 'srt':
      return mergeSrt(results, chunkDurations)
    case 'vtt':
      return mergeVtt(results, chunkDurations)
    default:
      return mergeText(results)
  }
}

function mergeText(results: string[]): string {
  return results.join('\n')
}

function mergeJson(results: string[]): string {
  const texts = results.map((r) => {
    try {
      return JSON.parse(r).text as string
    } catch {
      return r
    }
  })
  return JSON.stringify({ text: texts.join('\n') }, null, 2)
}

function mergeVerboseJson(results: string[], chunkDurations: number[]): string {
  let fullText = ''
  const allSegments: unknown[] = []
  let timeOffset = 0

  for (let i = 0; i < results.length; i++) {
    try {
      const data = JSON.parse(results[i])
      fullText += (fullText ? '\n' : '') + (data.text || '')

      if (Array.isArray(data.segments)) {
        for (const seg of data.segments) {
          allSegments.push({
            ...seg,
            start: seg.start + timeOffset,
            end: seg.end + timeOffset,
          })
        }
      }
    } catch {
      fullText += (fullText ? '\n' : '') + results[i]
    }
    timeOffset += chunkDurations[i] || 0
  }

  return JSON.stringify({ text: fullText, segments: allSegments }, null, 2)
}

function mergeSrt(results: string[], chunkDurations: number[]): string {
  let indexCounter = 1
  let timeOffset = 0
  const blocks: string[] = []

  for (let i = 0; i < results.length; i++) {
    const entries = parseSrtEntries(results[i])
    for (const entry of entries) {
      const start = offsetSrtTime(entry.start, timeOffset)
      const end = offsetSrtTime(entry.end, timeOffset)
      blocks.push(`${indexCounter}\n${start} --> ${end}\n${entry.text}`)
      indexCounter++
    }
    timeOffset += chunkDurations[i] || 0
  }

  return blocks.join('\n\n') + '\n'
}

function mergeVtt(results: string[], chunkDurations: number[]): string {
  let timeOffset = 0
  const cues: string[] = []

  for (let i = 0; i < results.length; i++) {
    const lines = results[i].split('\n')
    let inCue = false
    let cueLines: string[] = []

    for (const line of lines) {
      if (line.startsWith('WEBVTT') || line.startsWith('NOTE') || line.trim() === '') {
        if (inCue && cueLines.length > 0) {
          cues.push(processCueLines(cueLines, timeOffset))
          cueLines = []
          inCue = false
        }
        continue
      }

      if (line.includes('-->')) {
        if (inCue && cueLines.length > 0) {
          cues.push(processCueLines(cueLines, timeOffset))
          cueLines = []
        }
        inCue = true
      }

      if (inCue) {
        cueLines.push(line)
      }
    }

    if (inCue && cueLines.length > 0) {
      cues.push(processCueLines(cueLines, timeOffset))
    }

    timeOffset += chunkDurations[i] || 0
  }

  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n'
}

// --- SRT helpers ---

interface SrtEntry {
  start: string
  end: string
  text: string
}

function parseSrtEntries(srt: string): SrtEntry[] {
  const entries: SrtEntry[] = []
  const blocks = srt.trim().split(/\n\n+/)

  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.length < 2) continue

    // Find the timestamp line
    let tsLineIdx = -1
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].includes('-->')) {
        tsLineIdx = j
        break
      }
    }
    if (tsLineIdx === -1) continue

    const tsParts = lines[tsLineIdx].split('-->')
    if (tsParts.length !== 2) continue

    entries.push({
      start: tsParts[0].trim(),
      end: tsParts[1].trim(),
      text: lines.slice(tsLineIdx + 1).join('\n'),
    })
  }

  return entries
}

function offsetSrtTime(timeStr: string, offsetSeconds: number): string {
  // SRT format: HH:MM:SS,mmm
  const total = parseSrtTimestamp(timeStr) + offsetSeconds
  return formatSrtTimestamp(total)
}

function parseSrtTimestamp(ts: string): number {
  const match = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!match) return 0
  return (
    parseInt(match[1]) * 3600 +
    parseInt(match[2]) * 60 +
    parseInt(match[3]) +
    parseInt(match[4]) / 1000
  )
}

function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000)
  const h = Math.floor(totalMs / 3600000)
  const m = Math.floor((totalMs % 3600000) / 60000)
  const s = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`
}

// --- VTT helpers ---

function processCueLines(lines: string[], offsetSeconds: number): string {
  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('-->')) {
      const parts = lines[i].split('-->')
      const start = offsetVttTime(parts[0].trim(), offsetSeconds)
      const end = offsetVttTime(parts[1].trim(), offsetSeconds)
      result.push(`${start} --> ${end}`)
    } else {
      result.push(lines[i])
    }
  }
  return result.join('\n')
}

function offsetVttTime(timeStr: string, offsetSeconds: number): string {
  const total = parseVttTimestamp(timeStr) + offsetSeconds
  return formatVttTimestamp(total)
}

function parseVttTimestamp(ts: string): number {
  // VTT format: HH:MM:SS.mmm or MM:SS.mmm
  const match = ts.match(/(?:(\d+):)?(\d+):(\d+)\.(\d+)/)
  if (!match) return 0
  return (
    (parseInt(match[1] || '0') * 3600) +
    parseInt(match[2]) * 60 +
    parseInt(match[3]) +
    parseInt(match[4]) / 1000
  )
}

function formatVttTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000)
  const h = Math.floor(totalMs / 3600000)
  const m = Math.floor((totalMs % 3600000) / 60000)
  const s = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0')
}
