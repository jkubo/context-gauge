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
  repliesIn,
  replacedTranscript,
  resolveFloor,
  staleFloorKeys,
  type Ceilings,
  type Tone,
} from './gauge'

const READING = { plugin: 'context-gauge', key: 'reading' } as const
const reading = atom(READING, null)

/** How often the band re-reads the window between the engine's own measurements. */
const POLL_MS = 1_500

/** What `context-gauge --record-sample` prints; a CLI from before the mode prints nothing. */
const SAMPLE_ACK = 'ok'

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
  /**
   * Session id → its floor; undefined once the store was asked and had no
   * decision, null once the session proved unable to have one (resolveFloor, or
   * a compaction that came first).
   */
  floors: Map<string, number | null | undefined>
  /** True once the CLI failed to acknowledge a sample: none are sent again this load. */
  isSamplerOff: boolean
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

/**
 * What the store holds for a session in place of a floor it can never have: a
 * floor is above 0, so 0 is a decision, not a value. It outlives a reload, which
 * matters because the transcript does not: after a compaction it reads as a
 * session of one reply, and a fresh load that re-asked would take that fill for
 * the floor.
 */
const NO_FLOOR = 0

/** The session's decision: a floor, null for none possible, undefined while not yet made. */
async function loadFloor($: EngineInterface, held: Held, id: string): Promise<number | null | undefined> {
  if (!held.floors.has(id)) {
    const stored = await $.store.get(`${FLOOR_PREFIX}${id}`)

    held.floors.set(id, typeof stored !== 'number' ? undefined : stored > 0 ? stored : null)
  }

  return held.floors.get(id)
}

/** Records the session's decision in memory and in the store, and prunes the oldest. */
async function keepFloor($: EngineInterface, held: Held, id: string, floor: number | null): Promise<void> {
  held.floors.set(id, floor)
  await $.store.set(`${FLOOR_PREFIX}${id}`, floor ?? NO_FLOOR)

  for (const stale of staleFloorKeys(await $.store.keys())) {
    await $.store.delete(stale)
  }
}

/**
 * The session's floor, seeded from its first response and kept in the store across
 * reloads. Undefined while the floor is unknown, which the band draws as the fill
 * alone (unfloored) and never as a working set.
 */
async function floorFor($: EngineInterface, held: Held, id: string, tokens: number | undefined): Promise<number | undefined> {
  const decided = await loadFloor($, held, id)

  if (decided !== undefined || tokens === undefined) {
    return decided ?? undefined
  }

  // Asked once per session: replies only grow, so a refusal stands. A turn count
  // of at most 1 settles it cheaply (replies never exceed turns); past that the
  // replies are counted from the transcript (repliesIn says why).
  const turns = await $.session.turns()
  const replies = turns <= 1 ? turns : repliesIn(await $.session.messages())
  const floor = resolveFloor(undefined, tokens, replies)

  await keepFloor($, held, id, floor ?? null)

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
 * keeps growing without the UserPromptSubmit hook. No CLI, no sample; no floor,
 * no sample either, since its working set would be a guess.
 *
 * A CLI from before --record-sample exits 0 and writes nothing, so a sample
 * counts only when the CLI acknowledges it. The first that is not stops the
 * sampler for this load, with one line in the transcript saying why.
 */
async function recordSample($: EngineInterface, held: Held, value: GaugeReading): Promise<void> {
  const home = await $.env.get('HOME')

  if (held.isSamplerOff || value.tokens === undefined || value.floor === undefined || !home) {
    return
  }

  const cli = `${home}/.local/bin/context-gauge`

  if (!(await $.fs.exists(cli))) {
    return
  }

  const sample = {
    session_id: await $.session.id(),
    harness: 'claude',
    working: Math.max(0, value.tokens - value.floor),
    total: value.tokens,
    floor: value.floor,
    window: value.window,
    model: value.model ?? '',
  }
  const answer = await $.process
    .run([cli, '--record-sample'], { stdin: JSON.stringify(sample), timeoutMs: 5_000 })
    .then(run => run.stdout.trim(), () => '')

  if (answer !== SAMPLE_ACK) {
    held.isSamplerOff = true
    $.ui.log(`context-gauge: ${cli} did not acknowledge --record-sample (a CLI from before that mode); no calibration samples this session.`)
  }
}

export const register: Register = on => {
  const held: Held = {
    ceilings: DEFAULT_CEILINGS,
    isDisabled: false,
    poller: undefined,
    isPolling: false,
    written: '',
    floors: new Map(),
    isSamplerOff: false,
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

  // Observe only. A session that compacts before it has a floor can never have one:
  // the fill after the compaction is the summary's, not the harness boilerplate's.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (!held.isDisabled && replacedTranscript(e, result)) {
      try {
        const id = await $.session.id()

        if ((await loadFloor($, held, id)) === undefined) {
          await keepFloor($, held, id, null)
        }
      } catch {
        // Fail-open: the replies still gate the floor.
      }
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (!held.isDisabled) {
      try {
        const value = await publish($, held, e.context)

        if (e.changed.includes('context')) {
          await recordSample($, held, value)
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
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
