import { describe, it, expect } from 'vitest'
import { mergeResults } from './subtitle-merger'

describe('mergeResults', () => {
  describe('empty / single', () => {
    it('returns empty string for no results', () => {
      expect(mergeResults([], [], 'text')).toBe('')
    })

    it('returns single result unchanged', () => {
      expect(mergeResults(['hello'], [10], 'text')).toBe('hello')
    })
  })

  describe('text format', () => {
    it('joins with newline', () => {
      expect(mergeResults(['aaa', 'bbb'], [10, 10], 'text')).toBe('aaa\nbbb')
    })

    it('handles three chunks', () => {
      expect(mergeResults(['a', 'b', 'c'], [5, 5, 5], 'text')).toBe('a\nb\nc')
    })

    it('handles empty chunks in between', () => {
      expect(mergeResults(['a', '', 'c'], [5, 5, 5], 'text')).toBe('a\n\nc')
    })
  })

  describe('json format', () => {
    it('merges text fields', () => {
      const r1 = JSON.stringify({ text: 'hello' })
      const r2 = JSON.stringify({ text: 'world' })
      const merged = JSON.parse(mergeResults([r1, r2], [10, 10], 'json'))
      expect(merged.text).toBe('hello\nworld')
    })

    it('falls back to raw string on invalid JSON', () => {
      const r1 = JSON.stringify({ text: 'hello' })
      const r2 = 'not json'
      const merged = JSON.parse(mergeResults([r1, r2], [10, 10], 'json'))
      expect(merged.text).toBe('hello\nnot json')
    })
  })

  describe('verbose_json format', () => {
    it('merges text and offsets segments', () => {
      const r1 = JSON.stringify({
        text: 'hello',
        segments: [{ start: 0, end: 5, text: 'hello' }],
      })
      const r2 = JSON.stringify({
        text: 'world',
        segments: [{ start: 0, end: 3, text: 'world' }],
      })
      const merged = JSON.parse(mergeResults([r1, r2], [10, 10], 'verbose_json'))
      expect(merged.text).toBe('hello\nworld')
      expect(merged.segments).toHaveLength(2)
      expect(merged.segments[0].start).toBe(0)
      expect(merged.segments[0].end).toBe(5)
      // second chunk offset by cumulative duration (10)
      expect(merged.segments[1].start).toBe(10)
      expect(merged.segments[1].end).toBe(13)
    })

    it('uses startTimes when provided', () => {
      const r1 = JSON.stringify({
        text: 'a',
        segments: [{ start: 0, end: 2, text: 'a' }],
      })
      const r2 = JSON.stringify({
        text: 'b',
        segments: [{ start: 0, end: 1, text: 'b' }],
      })
      const merged = JSON.parse(
        mergeResults([r1, r2], [10, 10], 'verbose_json', [0, 15]),
      )
      expect(merged.segments[1].start).toBe(15)
      expect(merged.segments[1].end).toBe(16)
    })
  })

  describe('srt format', () => {
    it('merges and re-indexes entries with time offset', () => {
      const srt1 = '1\n00:00:00,000 --> 00:00:05,000\nhello\n'
      const srt2 = '1\n00:00:00,000 --> 00:00:03,000\nworld\n'
      const merged = mergeResults([srt1, srt2], [10, 10], 'srt')
      expect(merged).toContain('1\n00:00:00,000 --> 00:00:05,000\nhello')
      expect(merged).toContain('2\n00:00:10,000 --> 00:00:13,000\nworld')
    })

    it('uses startTimes for offset', () => {
      const srt1 = '1\n00:00:00,000 --> 00:00:05,000\nhello\n'
      const srt2 = '1\n00:00:00,000 --> 00:00:03,000\nworld\n'
      const merged = mergeResults([srt1, srt2], [10, 10], 'srt', [0, 20])
      expect(merged).toContain('2\n00:00:20,000 --> 00:00:23,000\nworld')
    })

    it('handles multiple entries per chunk', () => {
      const srt1 = '1\n00:00:00,000 --> 00:00:02,000\na\n\n2\n00:00:02,000 --> 00:00:04,000\nb\n'
      const srt2 = '1\n00:00:00,000 --> 00:00:01,000\nc\n'
      const merged = mergeResults([srt1, srt2], [5, 5], 'srt')
      const lines = merged.split('\n')
      // should have entries 1, 2, 3
      expect(lines[0]).toBe('1')
      expect(merged).toContain('3\n00:00:05,000 --> 00:00:06,000\nc')
    })
  })

  describe('vtt format', () => {
    it('merges with WEBVTT header and time offset', () => {
      const vtt1 = 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nhello\n'
      const vtt2 = 'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nworld\n'
      const merged = mergeResults([vtt1, vtt2], [10, 10], 'vtt')
      expect(merged).toMatch(/^WEBVTT\n/)
      expect(merged).toContain('00:00:00.000 --> 00:00:05.000\nhello')
      expect(merged).toContain('00:00:10.000 --> 00:00:13.000\nworld')
      // should have only one WEBVTT header
      expect(merged.match(/WEBVTT/g)?.length).toBe(1)
    })
  })

  describe('unknown format', () => {
    it('falls back to text merge', () => {
      expect(mergeResults(['x', 'y'], [5, 5], 'unknown')).toBe('x\ny')
    })
  })
})
