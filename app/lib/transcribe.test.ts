import { describe, it, expect } from 'vitest'
import { extractLastChars } from './transcribe'

describe('extractLastChars', () => {
  it('extracts last N chars from plain text', () => {
    expect(extractLastChars('hello world', 'text', 5)).toBe('world')
  })

  it('returns full text when shorter than count', () => {
    expect(extractLastChars('hi', 'text', 100)).toBe('hi')
  })

  it('extracts text field from JSON format', () => {
    const json = JSON.stringify({ text: 'hello world' })
    expect(extractLastChars(json, 'json', 5)).toBe('world')
  })

  it('extracts text field from verbose_json format', () => {
    const json = JSON.stringify({ text: 'foo bar baz' })
    expect(extractLastChars(json, 'verbose_json', 3)).toBe('baz')
  })

  it('returns empty on invalid JSON', () => {
    expect(extractLastChars('not json', 'json', 5)).toBe('')
  })

  it('strips SRT timestamps and indices', () => {
    const srt = '1\n00:00:00,000 --> 00:00:05,000\nhello world\n'
    expect(extractLastChars(srt, 'srt', 5)).toBe('world')
  })

  it('strips VTT header and timestamps', () => {
    const vtt = 'WEBVTT\n00:00:00.000 --> 00:00:05.000\nhello world\n'
    expect(extractLastChars(vtt, 'vtt', 5)).toBe('world')
  })
})
