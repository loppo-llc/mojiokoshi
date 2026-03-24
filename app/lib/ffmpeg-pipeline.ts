import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'

export interface ChunkInfo {
  file: File
  duration: number
  startTime: number
  endTime: number
}

export async function compressAudio(
  ffmpeg: FFmpeg,
  inputName: string,
  compressedName: string,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const progressHandler = onProgress
    ? ({ progress }: { progress: number }) => onProgress(progress)
    : undefined

  if (progressHandler) ffmpeg.on('progress', progressHandler)
  try {
    await ffmpeg.exec([
      '-i', inputName, '-b:a', '128k', '-ac', '1', '-y', compressedName,
    ])
  } finally {
    if (progressHandler) ffmpeg.off('progress', progressHandler)
  }

  const raw = await ffmpeg.readFile(compressedName) as Uint8Array
  return new Blob([new Uint8Array(raw)], { type: 'audio/mpeg' })
}

export async function splitIntoChunks(
  ffmpeg: FFmpeg,
  compressedName: string,
  prefix: string,
  segmentSeconds: number,
): Promise<ChunkInfo[]> {
  const chunkPattern = `${prefix}chunk_%03d.mp3`
  const segListFile = `${prefix}segments.csv`

  await ffmpeg.exec([
    '-i', compressedName,
    '-f', 'segment',
    '-segment_time', String(segmentSeconds),
    '-segment_list', segListFile,
    '-segment_list_type', 'csv',
    '-c', 'copy',
    '-y', chunkPattern,
  ])

  const segListRaw = await ffmpeg.readFile(segListFile) as Uint8Array
  const segListText = new TextDecoder().decode(segListRaw)
  const segLines = segListText.trim().split('\n').filter(Boolean)
  try { await ffmpeg.deleteFile(segListFile) } catch { /* ignore */ }

  const chunks: ChunkInfo[] = []
  for (let i = 0; i < segLines.length; i++) {
    const parts = segLines[i].split(',')
    const name = parts[0] || `${prefix}chunk_${String(i).padStart(3, '0')}.mp3`
    const segStart = parseFloat(parts[1]) || 0
    const segEnd = parseFloat(parts[2]) || 0
    const dur = segEnd - segStart

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
    try { await ffmpeg.deleteFile(name) } catch { /* ignore */ }
  }

  return chunks
}

export async function recoverCorruptChunk(
  ffmpeg: FFmpeg,
  chunkFile: File,
  index: number,
  nonce: number,
): Promise<File> {
  const ext = '.' + (chunkFile.name.split('.').pop()?.toLowerCase() || 'bin')
  const tmpIn = `recover_${index}_${nonce}_in${ext}`
  const tmpOut = `recover_${index}_${nonce}_out.mp3`

  try {
    await ffmpeg.writeFile(tmpIn, await fetchFile(chunkFile))
    await ffmpeg.exec(['-i', tmpIn, '-b:a', '128k', '-ac', '1', '-y', tmpOut])
    const raw = await ffmpeg.readFile(tmpOut) as Uint8Array
    const blob = new Blob([new Uint8Array(raw)], { type: 'audio/mpeg' })
    return new File([blob], `chunk_${index}.mp3`, { type: 'audio/mpeg' })
  } finally {
    try { await ffmpeg.deleteFile(tmpIn) } catch { /* ignore */ }
    try { await ffmpeg.deleteFile(tmpOut) } catch { /* ignore */ }
  }
}

export async function getFileDuration(ffmpeg: FFmpeg, filename: string): Promise<number> {
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
  return 600
}

export function getExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  return ext ? `.${ext}` : '.bin'
}

export async function cleanupFiles(ffmpeg: FFmpeg, files: string[]) {
  for (const f of files) {
    try {
      await ffmpeg.deleteFile(f)
    } catch {
      // ignore
    }
  }
}
