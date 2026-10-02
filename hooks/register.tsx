// The Claude Code mod: the fuel band above the prompt, drawn from the engine's own
// figures for the live context window. No transcript is read, and nothing here
// reaches the model: the band is the operator's, as the statusLine is.

import { atom, read } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionContextUsage, TextProps, Timer } from 'claude-code'

import type { GaugeReading } from '../types'
import {
  ceilingsOf,
  DEFAULT_CEILINGS,
  displayModel,
  fittedCeilings,
  FLOOR_PREFIX,
  fuelSpans,
  resolveFloor,
  staleFloorKeys,
  type Ceilings,
  type Tone,
} from './gauge'

const READING = { plugin: 'context-gauge', key: 'reading' } as const
const reading = atom(READING, null)

/** How often the band re-reads the window between the engine's own measurements. */
const POLL_MS = 1_500

// The statusLine's ANSI colours as Text props: 32, 33, 38;5;208, 1;31, 1;97;41.
// A Text takes a colour name or hex; #ff8700 is xterm-256 colour 208.
const TONES: Record<Tone, Pick<TextProps, 'color' | 'backgroundColor' | 'bold' | 'dimColor'>> = {
  GREEN: { color: 'green' },
  YELLOW: { color: 'yellow' },
  ORANGE: { color: '#ff8700' },
  RED: { color: 'red', bold: true },
  BLACK: { color: 'whiteBright', backgroundColor: 'red', bold: true },
  dim: { dimColor: true },
  plain: {},
}

/** What one load of the module holds. session.start runs again on every fresh load. */
type Held = {
  ceilings: Ceilings
  isDisabled: boolean
  poller: Timer | undefined
  isPolling: boolean
  /** The reading last written, so a poll that saw nothing new writes nothing. */
  written: string
  /** Session id → its floor, or undefined once the store was asked and had none. */
  floors: Map<string, number | undefined>
}

/** Python's os.path.expanduser for the one form a path variable uses: a leading ~. */
const expandHome = (path: string, home: string | undefined): string =>
  home !== undefined && (path === '~' || path.startsWith('~/')) ? `${home}${path.slice(1)}` : path

/** The thresholds file's text: CONTEXT_GAUGE_THRESHOLDS, else ~/.context-gauge/thresholds.json. */
async function thresholdsText($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  const custom = await $.env.get('CONTEXT_GAUGE_THRESHOLDS')
  const path = custom ? expandHome(custom, home) : home ? `${home}/.context-gauge/thresholds.json` : undefined

  return path === undefined ? '' : $.fs.read(path).catch(() => '')
}

/** The session's floor, seeded from its first reading and kept in the store across reloads. */
async function floorFor($: EngineInterface, held: Held, id: string, tokens: number | undefined): Promise<number | undefined> {
  const key = `${FLOOR_PREFIX}${id}`

  if (!held.floors.has(id)) {
    const stored = await $.store.get(key)

    held.floors.set(id, typeof stored === 'number' && stored > 0 ? stored : undefined)
  }

  const stored = held.floors.get(id)
  const floor = resolveFloor(stored, tokens)

  if (floor !== undefined && stored === undefined) {
    held.floors.set(id, floor)
    await $.store.set(key, floor)

    for (const stale of staleFloorKeys(await $.store.keys())) {
      await $.store.delete(stale)
    }
  }

  return floor
}

/** Turns the engine's figures into a reading, and writes it only when it changed. */
async function publish($: EngineInterface, held: Held, context: SessionContextUsage): Promise<GaugeReading> {
  // An all-zero fill is a stub, not a reading (the statusLine skips it too).
  const tokens = context.tokens !== undefined && context.tokens > 0 ? context.tokens : undefined
  const floor = await floorFor($, held, await $.session.id(), tokens)
  // The model is decoration: a failed lookup drops the segment, never the reading.
  const model = displayModel(await $.session.model().catch(() => ''))
  const value: GaugeReading = {
    window: context.window,
    ...(tokens !== undefined && { tokens }),
    ...(floor !== undefined && { floor }),
    ...(model !== '' && { model }),
  }
  const key = JSON.stringify(value)

  if (key !== held.written) {
    await $.state.set(READING, value)
    held.written = key
  }

  return value
}

async function poll($: EngineInterface, held: Held): Promise<void> {
  if (held.isPolling) {
    return
  }

  held.isPolling = true

  try {
    await publish($, held, (await $.session.usage()).context)
  } catch {
    // Fail-open: the band keeps its last reading.
  } finally {
    held.isPolling = false
  }
}

/**
 * Hands one reading to the installed CLI's sampler, so the calibration corpus
 * keeps growing without the UserPromptSubmit hook. No CLI, no sample.
 */
async function recordSample($: EngineInterface, value: GaugeReading): Promise<void> {
  const home = await $.env.get('HOME')

  if (value.tokens === undefined || !home) {
    return
  }

  const cli = `${home}/.local/bin/context-gauge`

  if (!(await $.fs.exists(cli))) {
    return
  }

  const floor = value.floor ?? 0
  const sample = {
    session_id: await $.session.id(),
    harness: 'claude',
    working: Math.max(0, value.tokens - floor),
    total: value.tokens,
    floor,
    window: value.window,
    model: value.model ?? '',
  }

  await $.process.run([cli, '--record-sample'], { stdin: JSON.stringify(sample), timeoutMs: 5_000 })
}

export const register: Register = on => {
  const held: Held = {
    ceilings: DEFAULT_CEILINGS,
    isDisabled: false,
    poller: undefined,
    isPolling: false,
    written: '',
    floors: new Map(),
  }

  on('session.start', async ($, e, next) => {
    try {
      held.isDisabled = Boolean(
        (await $.env.get('CONTEXT_GAUGE_DISABLE')) || (await $.env.get('CLAUDE_CONTEXT_GAUGE_DISABLE')),
      )

      if (!held.isDisabled) {
        held.ceilings = ceilingsOf(fittedCeilings(await thresholdsText($)))
        held.poller?.cancel()
        held.poller = $.clock.every(POLL_MS, () => {
          void poll($, held)
        })
        void poll($, held)
        $.ui.invalidate('ui.render')
      }
    } catch {
      // Fail-open: no band is better than a session that cannot start.
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (!held.isDisabled) {
      try {
        const value = await publish($, held, e.context)

        if (e.changed.includes('context')) {
          await recordSample($, value)
        }
      } catch {
        // Fail-open: a missed sample is not worth a failed measurement.
      }
    }

    return next(e)
  })

  // Other mods draw in this band too, so the fuel row goes on top of whatever the
  // chain beneath returns rather than in place of it. A survey owns the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || held.isDisabled) {
      return next(e)
    }

    let row: RenderElement | undefined

    try {
      const value = await read($, reading)

      if (value !== null) {
        const { Text } = $.ui.resolve(e)

        row = (
          <Text wrap="truncate-end">
            {fuelSpans(value, held.ceilings).map(span =>
              span.tone === 'plain' ? span.text : <Text {...TONES[span.tone]}>{span.text}</Text>,
            )}
          </Text>
        )
      }
    } catch {
      row = undefined
    }

    if (row === undefined) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)
    const below = await next(e)

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {row}
        {below}
      </Box>
    )
  })
}
