import { describe, expect, test } from 'claude-code/testing'

import {
  bandFlag,
  bandSpans,
  ceilingsOf,
  DEFAULT_CEILINGS,
  displayModel,
  fittedCeilings,
  fmtK,
  fmtWindow,
  fuelSpans,
  pyFixed,
  resolveBand,
  resolveFloor,
  staleFloorKeys,
  textOf,
} from './gauge'
import { PARITY } from './parity'

type Expected = { working?: number[]; ratio?: number[] }

describe('the band math is context_gauge.py', () => {
  test('every shared band case: the band, the axis that set it, the bar text', () => {
    for (const c of PARITY.bands) {
      const window = c.window ?? undefined
      const band = resolveBand(c.working, c.total, window)
      const label = `working=${c.working} total=${c.total} window=${c.window}`

      expect(band.name, label).toBe(c.name)
      expect(band.source, label).toBe(c.source)
      expect(textOf(bandSpans(c.working, c.total, window)), label).toBe(c.text)
    }
  })

  test('every shared thresholds file is accepted or refused axis by axis as _tuned() does', () => {
    for (const c of PARITY.fitted) {
      const fitted = fittedCeilings(c.text)
      const expected = c.expect as Expected

      expect(fitted.working?.slice(0, 4), c.text).toEqual(expected.working)
      expect(fitted.ratio?.slice(0, 4), c.text).toEqual(expected.ratio)
      expect(fitted.working?.[4] ?? Infinity, c.text).toBe(Infinity)
    }
  })

  test('a published fit moves the band; an unpublished axis keeps the defaults', () => {
    const ceilings = ceilingsOf(fittedCeilings(JSON.stringify({
      working: { green_max: 60_000, yellow_max: 120_000, orange_max: 200_000, red_max: 320_000 },
    })))

    expect(resolveBand(150_000).name).toBe('RED')
    expect(resolveBand(150_000, undefined, undefined, ceilings).name).toBe('ORANGE')
    expect(ceilings.ratio).toEqual(DEFAULT_CEILINGS.ratio)
  })

  test('the flag names the axis that set the band', () => {
    expect(bandFlag('GREEN', 'both')).toBe('')
    expect(bandFlag('YELLOW', 'window ratio')).toBe('')
    expect(bandFlag('ORANGE', 'working set')).toBe('⚑ checkpoint')
    expect(bandFlag('ORANGE', 'both')).toBe('⚑ compaction near')
    expect(bandFlag('RED', 'working set')).toBe('⚑ handoff soon')
    expect(bandFlag('RED', 'window ratio')).toBe('⚑ compaction imminent')
    expect(bandFlag('BLACK', 'working set')).toBe('⚑ HANDOFF NOW')
  })

  test('numbers format as Python formats them, an exact tie going to the even digit', () => {
    expect(pyFixed(12.5, 0)).toBe('12')
    expect(pyFixed(13.5, 0)).toBe('14')
    expect(pyFixed(0.5, 0)).toBe('0')
    expect(pyFixed(1.125, 2)).toBe('1.12')
    expect(pyFixed(1.375, 2)).toBe('1.38')
    expect(pyFixed(2.675, 2)).toBe('2.67')
    expect(pyFixed(0.225 * 100, 0)).toBe('22')
    expect(fmtK(999_499)).toBe('999K')
    expect(fmtK(999_500)).toBe('1000K')
    expect(fmtK(1_000_000)).toBe('1.00M')
    expect(fmtWindow(1_000_000)).toBe('1M')
    expect(fmtWindow(1_500_000)).toBe('1.5M')
    expect(fmtWindow(10_000_000)).toBe('10M')
    expect(fmtWindow(200_000)).toBe('200K')
  })
})

describe('the floor', () => {
  test('is the first reading, and a stored floor outlives every later one', () => {
    expect(resolveFloor(undefined, undefined)).toBeUndefined()
    expect(resolveFloor(undefined, 0)).toBeUndefined()
    expect(resolveFloor(undefined, 61_000)).toBe(61_000)
    expect(resolveFloor(61_000, 240_000)).toBe(61_000)
    // After a compaction the fill drops under the floor; the floor stays.
    expect(resolveFloor(61_000, 30_000)).toBe(61_000)
  })

  test('the store keeps the newest floors and drops the oldest', () => {
    const keys = ['other', 'floor:a', 'floor:b', 'floor:c', 'floor:d']

    expect(staleFloorKeys(keys, 2)).toEqual(['floor:a', 'floor:b'])
    expect(staleFloorKeys(keys, 10)).toEqual([])
    expect(staleFloorKeys(['other'], 0)).toEqual([])
  })
})

describe('the fuel row', () => {
  test('before the live window has a response, a dim placeholder and the model', () => {
    const spans = fuelSpans({ window: 1_000_000, model: 'Opus 5' })

    expect(textOf(spans)).toBe('⛽ … · Opus 5')
    expect(spans[0]).toEqual({ text: '⛽ …', tone: 'dim' })
  })

  test('the band is drawn from the working set: fill less floor, never below zero', () => {
    expect(textOf(fuelSpans({ tokens: 200_000, floor: 60_000, window: 1_000_000, model: 'Opus 5' })))
      .toBe('⛽ 🟠 ORANGE 140K · 20% of 1M ⚑ checkpoint · Opus 5')
    expect(textOf(fuelSpans({ tokens: 30_000, floor: 60_000, window: 200_000 })))
      .toBe('⛽ 🟢 GREEN 0K · 15% of 200K')
  })

  test('every run of a band is coloured as that band', () => {
    const tones = new Set(fuelSpans({ tokens: 400_000, floor: 60_000, window: 1_000_000 })
      .filter(span => span.text.trim() !== '' && span.text !== '·')
      .map(span => span.tone))

    expect([...tones]).toEqual(['BLACK'])
  })

  test('a model name cannot carry control characters or run on', () => {
    expect(displayModel('Opus\u001b[2K 5\n')).toBe('Opus[2K 5')
    expect(Array.from(displayModel('x'.repeat(100)))).toHaveLength(64)
  })
})
