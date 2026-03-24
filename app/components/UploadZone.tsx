import { useRef, useCallback, useState } from 'react'

const MAX_FILE_SIZE = 500 * 1024 * 1024
const ACCEPTED_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/x-m4a', 'audio/mp3', 'audio/ogg', 'video/mp4', 'video/webm', 'audio/x-wav', 'audio/aac', 'audio/flac']
const ACCEPTED_EXTENSIONS = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac']

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function validateFile(file: File): { key: string; params?: Record<string, string | number> } | null {
  if (file.size > MAX_FILE_SIZE) {
    return { key: 'error.fileTooLarge', params: { size: formatFileSize(file.size) } }
  }
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  const typeOk = ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.includes(ext)
  if (!typeOk) {
    return { key: 'error.unsupportedFormat' }
  }
  return null
}

interface UploadZoneProps {
  file: File | null
  onFileChange: (file: File | null) => void
  onError: (error: string) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

export function UploadZone({ file, onFileChange, onError, t }: UploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const setFileWithValidation = useCallback((f: File) => {
    const err = validateFile(f)
    if (err) {
      onFileChange(null)
      onError(t(err.key, err.params))
      return
    }
    onFileChange(f)
    onError('')
  }, [t, onFileChange, onError])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const droppedFile = e.dataTransfer.files[0]
    if (droppedFile) setFileWithValidation(droppedFile)
  }, [setFileWithValidation])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) setFileWithValidation(selectedFile)
  }, [setFileWithValidation])

  return (
    <div
      role="button"
      tabIndex={0}
      className={`upload-zone rounded-xl p-8 md:p-12 text-center cursor-pointer mb-8 ${isDragOver ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
      aria-label={t('upload.ariaLabel')}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm,.ogg,.flac"
        onChange={handleFileSelect}
        className="hidden"
      />

      {file ? (
        <div className="result-appear">
          <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>
          <p className="text-text-primary font-medium text-sm mb-1">{file.name}</p>
          <p className="text-text-tertiary text-xs">{formatFileSize(file.size)}</p>
        </div>
      ) : (
        <>
          <div className="w-10 h-10 rounded-full border border-border flex items-center justify-center mx-auto mb-4">
            <svg className="w-5 h-5 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <p className="text-text-secondary text-sm mb-1">
            {t('upload.dragDrop')}
          </p>
          <p className="text-text-tertiary text-xs">
            {t('upload.formats')}
          </p>
        </>
      )}
    </div>
  )
}
