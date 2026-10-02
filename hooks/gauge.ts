// The band math of context_gauge.py, ported for the Claude Code mod. Pure: no `$`,
// no engine, so every function here is tested directly.
//
// 🔴 context_gauge.py is the reference. tests/test_gauge.py reads the constants below
// out of this file and compares them with the Python module's own, and both sides run
// the cases in parity.ts, so a threshold or a string changed in one place reds the
// other's suite. Change both, or neither.

import type { GaugeReading } from '../types'

// --- Band thresholds: ABSOLUTE WORKING-SET tokens (fill − floor) -------------
export const GREEN_MAX = 40_000
export const YELLOW_MAX = 90_000
export const ORANGE_MAX = 150_000
export const RED_MAX = 250_000

// --- Band thresholds: RATIO of the LIVE window consumed by TOTAL fill -------
export const RATIO_GREEN_MAX = 0.50
export const RATIO_YELLOW_MAX = 0.70
export const RATIO_ORANGE_MAX = 0.85
export const RATIO_RED_MAX = 0.95
// The inject line's "compaction near" mark. The bar never drew it (band_segment
// does not), so neither does the mod; pinned here so the two cannot disagree.
export const COMPACTION_WARN_RATIO = 0.80

// The bar flags, as band_flag() spells them. They name the remedy for the
// OPERATOR, who reads this band; nothing here reaches the model's context.
export const FLAG_CHECKPOINT = '⚑ checkpoint'
export const FLAG_COMPACTION_NEAR = '⚑ compaction near'
export const FLAG_HANDOFF_SOON = '⚑ handoff soon'
export const FLAG_COMPACTION_IMMINENT = '⚑ compaction imminent'
export const FLAG_HANDOFF_NOW = '⚑ HANDOFF NOW'

export type BandName = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'BLACK'
export type BandSource = 'working set' | 'window ratio' | 'both'

export const BANDS: readonly { name: BandName; emoji: string }[] = [
  { name: 'GREEN', emoji: '🟢' },
  { name: 'YELLOW', emoji: '🟡' },
  { name: 'ORANGE', emoji: '🟠' },
  { name: 'RED', emoji: '🔴' },
  { name: 'BLACK', emoji: '⚫' },
]

/** Band ceilings per axis, five each: the last is Infinity, so every value has a band. */
export type Ceilings = { working: readonly number[]; ratio: readonly number[] }

export const ABSOLUTE_CEILINGS: readonly number[] = [GREEN_MAX, YELLOW_MAX, ORANGE_MAX, RED_MAX, Infinity]
export const RATIO_CEILINGS: readonly number[] = [RATIO_GREEN_MAX, RATIO_YELLOW_MAX, RATIO_ORANGE_MAX, RATIO_RED_MAX, Infinity]
export const DEFAULT_CEILINGS: Ceilings = { working: ABSOLUTE_CEILINGS, ratio: RATIO_CEILINGS }

export function bandIndex(value: number, ceilings: readonly number[]): number {
  for (const [i, ceiling] of ceilings.entries()) {
    if (value < ceiling) {
      return i
    }
  }

  return ceilings.length - 1
}

export type Band = { name: BandName; emoji: string; source: BandSource; frac: number | undefined }

/**
 * Band = the WORSE of the working-set band and the window-ratio band, as
 * resolve_band() has it. `frac` is undefined when the window is unknown, and
 * then the ratio band is skipped and the absolute band stands alone.
 */
export function resolveBand(working: number, total?: number, window?: number, ceilings: Ceilings = DEFAULT_CEILINGS): Band {
  const idxAbs = bandIndex(working, ceilings.working)
  let frac: number | undefined
  let idxRatio: number | undefined

  if (window && total !== undefined && total > 0) {
    frac = total / window
    idxRatio = bandIndex(frac, ceilings.ratio)
  }

  let idx: number
  let source: BandSource

  if (idxRatio === undefined || idxAbs === idxRatio) {
    idx = idxAbs
    source = idxRatio === undefined ? 'working set' : 'both'
  } else if (idxRatio > idxAbs) {
    idx = idxRatio
    source = 'window ratio'
  } else {
    idx = idxAbs
    source = 'working set'
  }

  const band = BANDS[idx] ?? BANDS[BANDS.length - 1]!

  return { name: band.name, emoji: band.emoji, source, frac }
}

/** The bar flag names the remedy, and the remedy differs by axis (band_flag). */
export function bandFlag(name: BandName, source: BandSource): string {
  if (name === 'BLACK') {
    return FLAG_HANDOFF_NOW
  }

  const byWindow = source === 'window ratio' || source === 'both'

  if (name === 'RED') {
    return byWindow ? FLAG_COMPACTION_IMMINENT : FLAG_HANDOFF_SOON
  }

  if (name === 'ORANGE') {
    return byWindow ? FLAG_COMPACTION_NEAR : FLAG_CHECKPOINT
  }

  return ''
}

/**
 * Python's `format(x, f".{digits}f")` for a finite x ≥ 0: correctly rounded,
 * and an exact tie goes to the even digit. `toFixed` sends a tie up instead, so
 * 22.5% would read 23% here and 22% on the statusLine; the tie is found exactly.
 */
export function pyFixed(x: number, digits: number): string {
  const below = halfwayFloor(x, digits)

  if (below === undefined) {
    return x.toFixed(digits)
  }

  const n = below % 2n === 0n ? below : below + 1n
  const s = n.toString().padStart(digits + 1, '0')

  return digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`
}

/** floor(x·10^digits) when x·10^digits lies exactly halfway between two integers, else undefined. */
function halfwayFloor(x: number, digits: number): bigint | undefined {
  if (!Number.isFinite(x) || x <= 0) {
    return undefined
  }

  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const hi = view.getUint32(0)
  const biased = (hi >>> 20) & 0x7ff
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4))
  // x = mantissa · 2^exponent, exactly.
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n)
  const exponent = (biased === 0 ? 1 : biased) - 1075
  // Halfway ⇔ 2·x·10^digits = mantissa · 10^digits · 2^(exponent+1) is an odd integer.
  const scaled = mantissa * 10n ** BigInt(digits)
  const shift = exponent + 1
  let twice: bigint

  if (shift >= 0) {
    twice = scaled << BigInt(shift)
  } else {
    const divisor = 1n << BigInt(-shift)

    if (scaled % divisor !== 0n) {
      return undefined
    }

    twice = scaled / divisor
  }

  return twice % 2n === 1n ? (twice - 1n) / 2n : undefined
}

export function fmtK(n: number): string {
  return n < 1_000_000 ? `${pyFixed(n / 1000, 0)}K` : `${pyFixed(n / 1_000_000, 2)}M`
}

/** Windows are round numbers: "1M" reads better than "1.00M". */
export function fmtWindow(n: number): string {
  const s = fmtK(n)

  return s.endsWith('M') ? `${s.slice(0, -1).replace(/0+$/, '').replace(/\.+$/, '')}M` : s
}

// ── Fitted thresholds ──────────────────────────────────────────────────────────
// The read side of thresholds.json, validated exactly as _tuned() does: an axis
// is taken only when all four ceilings convert as Python's float() would and are
// positive and strictly increasing. Anything else leaves that axis on the
// shipped defaults; a broken tuning file degrades to the guess, never to no band.

const TUNE_KEYS = ['green_max', 'yellow_max', 'orange_max', 'red_max'] as const
const PY_FLOAT = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/

/** What Python's float() makes of a JSON value, or undefined where it raises. */
function pyFloat(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const s = value.trim()

  if (/^[+-]?(?:inf|infinity)$/i.test(s)) {
    return s.startsWith('-') ? -Infinity : Infinity
  }

  if (/^[+-]?nan$/i.test(s)) {
    return NaN
  }

  return PY_FLOAT.test(s) ? Number(s.replaceAll('_', '')) : undefined
}

export type Fitted = { working?: readonly number[]; ratio?: readonly number[] }

/** The axes a thresholds.json publishes validly, each with Infinity appended. */
export function fittedCeilings(text: string): Fitted {
  let blob: unknown

  try {
    blob = JSON.parse(text)
  } catch {
    return {}
  }

  if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
    return {}
  }

  const fitted: { working?: number[]; ratio?: number[] } = {}

  for (const axis of ['working', 'ratio'] as const) {
    const spec: unknown = (blob as Record<string, unknown>)[axis]

    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      continue
    }

    const vals = TUNE_KEYS.map(key => pyFloat((spec as Record<string, unknown>)[key]))

    if (vals.some(v => v === undefined)) {
      continue
    }

    const nums = vals as number[]
    const isTable = nums.every(v => v > 0) && nums.every((v, i) => i === 0 || nums[i - 1]! < v)

    if (isTable) {
      fitted[axis] = [...nums, Infinity]
    }
  }

  return fitted
}

/** The ceilings in force: fitted per axis where published, else the defaults. */
export function ceilingsOf(fitted: Fitted): Ceilings {
  return { working: fitted.working ?? ABSOLUTE_CEILINGS, ratio: fitted.ratio ?? RATIO_CEILINGS }
}

// ── The floor ──────────────────────────────────────────────────────────────────

/**
 * The working set is measured from this floor: the harness boilerplate the
 * session opened with.
 *
 * 🔑 Policy: the floor is the fill of the session's FIRST response, kept for the
 * session's life and never reset on compaction, which is what the statusLine's
 * transcript scan does for Claude (the Grok path re-seeds after a compaction
 * instead). After a compaction the working set therefore reads near zero until
 * the window grows back past the old floor. This is the one choice here that is
 * policy rather than parity; change it in both places or neither.
 *
 * A fill is the first response's only while the model has answered the user at
 * most once (`replies`, see repliesIn). A session the mod meets later (open when
 * it was installed, resumed from before, its first reply interrupted) gets no
 * floor at all: one seeded deep into the session would read its working set as
 * zero, a false GREEN at any saturation. Nor does one that compacts before it has
 * a floor (replacedTranscript): the fill after a compaction is the summary's. Such
 * a session is not left dark; unfloored() draws what is known of it.
 */
export function resolveFloor(storedFloor: number | undefined, tokens: number | undefined, replies: number): number | undefined {
  if (storedFloor !== undefined && storedFloor > 0) {
    return storedFloor
  }

  return tokens !== undefined && tokens > 0 && replies <= 1 ? tokens : undefined
}

/** One row of `$.session.messages()`, as far as repliesIn reads it. */
export type Row = { role: 'user' | 'assistant'; toolResults?: readonly unknown[] }

/**
 * How many times the model has answered the user: assistant rows straight after
 * a user row that carries no tool result. Not the engine's turn count, which
 * also counts a local command's rows (/effort, /model, `!` bash), so a session
 * opened with one reads 3 turns at its first response.
 */
export function repliesIn(rows: readonly Row[]): number {
  let replies = 0

  for (let i = 1; i < rows.length; i++) {
    const before = rows[i - 1]

    if (rows[i]?.role === 'assistant' && before?.role === 'user' && !before.toolResults?.length) {
      replies++
    }
  }

  return replies
}

/**
 * Whether a `session.compact` dispatch, answered as `result`, replaced the MAIN
 * conversation's transcript with a summary: not a subagent's own compaction, not
 * the `precompute` that installs nothing, not one a hook vetoed.
 */
export function replacedTranscript(e: { trigger: string; agentId?: string }, result: { skip?: string }): boolean {
  return e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
}

export const FLOOR_PREFIX = 'floor:'
/** Floors kept in the store: one per session, the newest this many. */
export const FLOORS_KEPT = 200

/**
 * The floor keys to delete so only the newest FLOORS_KEPT remain. The store
 * lists keys in insertion order and a floor is written once per session, so
 * insertion order is age order and no value has to be read to prune.
 */
export function staleFloorKeys(keys: readonly string[], kept: number = FLOORS_KEPT): string[] {
  const floors = keys.filter(key => key.startsWith(FLOOR_PREFIX))

  return floors.slice(0, Math.max(0, floors.length - kept))
}

// ── What the band draws ────────────────────────────────────────────────────────

/** How a run of text is coloured: a band's colour, dim, or the surface's own. */
export type Tone = BandName | 'dim' | 'plain'
export type Span = { text: string; tone: Tone }

// The statusLine's _SEP: a dim dot between plain spaces.
const SEP: readonly Span[] = [{ text: ' ', tone: 'plain' }, { text: '·', tone: 'dim' }, { text: ' ', tone: 'plain' }]

/** band_segment(), as coloured runs: the band, the window share when known, the flag. */
export function bandSpans(working: number, total?: number, window?: number, ceilings: Ceilings = DEFAULT_CEILINGS): Span[] {
  const { name, emoji, source, frac } = resolveBand(working, total, window, ceilings)
  const spans: Span[] = [{ text: `⛽ ${emoji} ${name} ${fmtK(working)}`, tone: name }]

  if (frac !== undefined && window) {
    spans.push(...SEP, { text: `${pyFixed(frac * 100, 0)}% of ${fmtWindow(window)}`, tone: name })
  }

  const flag = bandFlag(name, source)

  if (flag) {
    spans.push({ text: ' ', tone: 'plain' }, { text: flag, tone: name })
  }

  return spans
}

/** What the row says in place of a working-set figure it cannot know. */
export const FLOOR_UNKNOWN = 'floor?'

/**
 * The row for a session whose floor is unknown (resolveFloor): the fill and the
 * window are measured, the working set is not, so the band is drawn from the
 * window-ratio axis alone and the row says the floor is missing.
 *
 * 🔑 The true band is the WORSE of the two axes, so the ratio band is a lower
 * bound on it and a band at or above YELLOW is honest. A ratio GREEN is not: the
 * working set could still be BLACK (400K of a 1M window reads 40%, GREEN, with
 * the whole of it reasoning context), so no GREEN is ever claimed here; the
 * numbers are drawn in the surface's own colour with no band named. The flag is
 * the window axis's, true whatever the floor.
 */
export function unfloored(tokens: number, window: number, ceilings: Ceilings = DEFAULT_CEILINGS): Span[] {
  const frac = tokens / window
  const idx = bandIndex(frac, ceilings.ratio)
  const band = idx > 0 ? (BANDS[idx] ?? BANDS[BANDS.length - 1]!) : undefined
  const tone: Tone = band?.name ?? 'plain'
  const fill = `${fmtK(tokens)} of ${fmtWindow(window)}`
  const spans: Span[] = [
    { text: band ? `⛽ ${band.emoji} ${band.name} ${fill}` : `⛽ ${fill}`, tone },
    ...SEP,
    { text: `${pyFixed(frac * 100, 0)}%`, tone },
    ...SEP,
    { text: FLOOR_UNKNOWN, tone: 'dim' },
  ]
  const flag = band ? bandFlag(band.name, 'window ratio') : ''

  if (flag) {
    spans.push({ text: ' ', tone: 'plain' }, { text: flag, tone })
  }

  return spans
}

/**
 * The fuel row: statusline_claude() with the engine's figures in place of the
 * transcript scan. Until the live window's first response there is nothing to
 * band, so it shows the same dim placeholder the statusLine does. Once there is
 * a fill, the row is never dark: with the floor it is the full band, without
 * one (resolveFloor) it is unfloored().
 */
export function fuelSpans(reading: GaugeReading, ceilings: Ceilings = DEFAULT_CEILINGS): Span[] {
  const suffix: Span[] = reading.model ? [...SEP, { text: reading.model, tone: 'plain' }] : []
  const { tokens, floor, window } = reading
  const row: Span[] =
    tokens === undefined || (floor === undefined && !(window > 0))
      ? [{ text: '⛽ …', tone: 'dim' }]
      : floor === undefined
        ? unfloored(tokens, window, ceilings)
        : bandSpans(Math.max(0, tokens - floor), tokens, window, ceilings)

  return [...row, ...suffix]
}

export const textOf = (spans: readonly Span[]): string => spans.map(span => span.text).join('')

/** A model name made safe to draw: no control or format characters, one line, bounded. */
export function displayModel(model: string): string {
  const line = model.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()

  return Array.from(line).slice(0, 64).join('')
}
