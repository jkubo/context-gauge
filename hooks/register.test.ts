import type { On, RenderPropsOf, SessionContextUsage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'context-gauge'
const SURFACES = ['terminal', 'desktop'] as const
const HOME = '/home/someone'
const CLI = `${HOME}/.local/bin/context-gauge`
const SESSION = { surface: 'terminal' as const, isInteractive: true, cwd: '/work' }

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

/** The world beneath the plugin, in memory, and what the plugin asked of it. */
type World = {
  context: SessionContextUsage
  files: Map<string, string>
  store: Map<string, unknown>
  /** Prompts the user has sent: what `$.session.turns()` answers. */
  turns: number
  /** What the CLI prints to `--record-sample`. */
  answer: string
  runs: { argv: readonly string[]; stdin: string | undefined }[]
  /** Every value the plugin wrote to its reading, in order. */
  writes: unknown[]
  logs: string[]
  turnsAsked: number
}

function worldOf(
  on: On,
  context: SessionContextUsage,
  {
    env = { HOME },
    files = {},
    store = {},
    model = 'Opus 5',
    turns = 1,
    answer = 'ok\n',
  }: {
    env?: Record<string, string>
    files?: Record<string, string>
    store?: Record<string, unknown>
    model?: string | null
    turns?: number
    answer?: string
  } = {},
): World {
  const world: World = {
    context,
    files: new Map(Object.entries(files)),
    store: new Map(Object.entries(store)),
    turns,
    answer,
    runs: [],
    writes: [],
    logs: [],
    turnsAsked: 0,
  }

  mock.env(on, env)
  on('store.get', ($, e) => ({ value: world.store.get(e.key) }))
  on('store.set', ($, e) => (world.store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (world.store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...world.store.keys()] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: world.context, rateLimits: [] } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.turns', () => (world.turnsAsked++, { value: world.turns }))
  on('session.model', () => (model === null ? { deny: 'no model' } : { value: model }))
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: world.files.has(e.path) }))
  on('process.run', ($, e) => {
    world.runs.push({ argv: e.argv, stdin: e.init?.stdin })

    return { value: { exitCode: 0, stdout: world.answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('state.set', ($, e, next) => (world.writes.push(e.value), next(e)))
  on('ui.log', ($, e) => (world.logs.push(e.text), { value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  // Another mod's drawing in the same band: what the chain beneath answers.
  on('ui.render', () => ({ type: 'Text', props: { color: 'cyan' }, children: ['another mod'] }))

  return world
}

const ORANGE = { tokens: 200_000, window: 1_000_000 }

describe('the band above the prompt', () => {
  test('draws the fuel row on top of what the chain beneath drew, on every surface it is raised on', async ($, on) => {
    const world = worldOf(on, { tokens: 60_000, window: 1_000_000 })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    world.context = ORANGE
    await clock.advance(1_500)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      const drawn = await ui.drawn()
      const fuel = await ui.find({ type: 'Text', text: /ORANGE 140K/ })

      expect(drawn, surface).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
      expect(fuel?.text, surface).toBe('⛽ 🟠 ORANGE 140K · 20% of 1M ⚑ checkpoint · Opus 5')
      expect(await ui.find({ text: 'another mod' }), surface).toBeDefined()
      expect(JSON.stringify(drawn).indexOf('ORANGE'), surface).toBeLessThan(JSON.stringify(drawn).indexOf('another mod'))
      expect(await ui.find({ type: 'Text', text: /^⛽ 🟠 ORANGE 140K$/ }), surface).toMatchObject({ props: { color: '#ff8700' } })
      await ui.unmount()
    }
  })

  test('every band is drawn in colours both surfaces accept', async ($, on) => {
    // A colour a surface refuses fails the whole tree, and the engine then draws its
    // own: nothing, here, so the other mods' rows in this band would vanish with ours.
    const world = worldOf(on, { tokens: 60_000, window: 1_000_000 })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    for (const [tokens, name] of [[70_000, 'GREEN'], [130_000, 'YELLOW'], [200_000, 'ORANGE'], [260_000, 'RED'], [400_000, 'BLACK']] as const) {
      world.context = { tokens, window: 1_000_000 }
      await clock.advance(1_500)

      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

        expect(await ui.find({ type: 'Text', text: new RegExp(`^⛽ \\S+ ${name} `) }), `${surface} ${name}`).toBeDefined()
        await ui.unmount()
      }
    }
  })

  test('yields the band to a survey', async ($, on) => {
    worldOf(on, ORANGE)
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })

      expect(await ui.find({ text: /⛽/ }), surface).toBeUndefined()
      expect(await ui.find({ text: 'another mod' }), surface).toBeDefined()
      await ui.unmount()
    }
  })

  test('shows a dim placeholder until the live window has a response', async ($, on) => {
    worldOf(on, { window: 1_000_000 })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

      expect(await ui.find({ type: 'Text', text: /^⛽ …$/ }), surface).toMatchObject({ props: { dimColor: true } })
      expect(await ui.find({ text: /GREEN|YELLOW|ORANGE|RED|BLACK/ }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  for (const knob of ['CONTEXT_GAUGE_DISABLE', 'CLAUDE_CONTEXT_GAUGE_DISABLE']) {
    test(`draws nothing of its own under the kill switch ${knob}`, async ($, on) => {
      worldOf(on, ORANGE, { env: { HOME, [knob]: '1' } })
      const clock = mock.clock(on)

      await $.session.start(SESSION)
      await clock.settle()

      const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

      expect(await ui.find({ text: /⛽/ })).toBeUndefined()
      expect(await ui.find({ text: 'another mod' })).toBeDefined()
    })
  }

  test('is cut to the body width, never wrapped onto a second row', async ($, on) => {
    worldOf(on, ORANGE, { store: { 'floor:session-1': 60_000 } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 30 } })
      const row = await ui.find({ type: 'Text', text: /^⛽ 🟠 ORANGE 140K · 20% of 1M ⚑ checkpoint · Opus 5$/ })

      expect(await ui.drawn(), surface).toMatchObject({ type: 'Box', props: { width: 30 } })
      expect(row, surface).toMatchObject({ props: { wrap: 'truncate-end' } })
      await ui.unmount()
    }
  })

  test('an all-zero fill is a stub: the placeholder, not a band of nothing', async ($, on) => {
    worldOf(on, { tokens: 0, window: 1_000_000 }, { store: { 'floor:session-1': 60_000 } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: /^⛽ …$/ })).toMatchObject({ props: { dimColor: true } })
    expect(await ui.find({ text: /GREEN|YELLOW|ORANGE|RED|BLACK/ })).toBeUndefined()
  })

  test('a failed model lookup drops the model, never the band', async ($, on) => {
    worldOf(on, { tokens: 200_000, window: 1_000_000 }, { store: { 'floor:session-1': 60_000 }, model: null })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect((await ui.find({ type: 'Text', text: /ORANGE 140K/ }))?.text).toBe('⛽ 🟠 ORANGE 140K · 20% of 1M ⚑ checkpoint')
  })

  // A 70K working set: YELLOW on the shipped ceilings, GREEN on FIT, ORANGE on OTHER_FIT.
  const SEVENTY = { tokens: 130_000, window: 1_000_000 }
  const FLOOR = { 'floor:session-1': 60_000 }
  const FIT = { working: { green_max: 80_000, yellow_max: 120_000, orange_max: 200_000, red_max: 320_000 } }
  const OTHER_FIT = { working: { green_max: 10_000, yellow_max: 20_000, orange_max: 100_000, red_max: 200_000 } }

  test('bands on the shipped ceilings when no fit is published', async ($, on) => {
    worldOf(on, SEVENTY, { store: FLOOR })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: /^⛽ 🟡 YELLOW 70K · 13% of 1M · Opus 5$/ })).toBeDefined()
  })

  test('bands against a published fit', async ($, on) => {
    worldOf(on, SEVENTY, { store: FLOOR, files: { [`${HOME}/.context-gauge/thresholds.json`]: JSON.stringify(FIT) } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: /^⛽ 🟢 GREEN 70K · 13% of 1M · Opus 5$/ })).toBeDefined()
  })

  test('CONTEXT_GAUGE_THRESHOLDS names the fit, ~ expanded, over the default file', async ($, on) => {
    worldOf(on, SEVENTY, {
      env: { HOME, CONTEXT_GAUGE_THRESHOLDS: '~/fits/mine.json' },
      store: FLOOR,
      files: {
        [`${HOME}/fits/mine.json`]: JSON.stringify(FIT),
        [`${HOME}/.context-gauge/thresholds.json`]: JSON.stringify(OTHER_FIT),
      },
    })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: /^⛽ 🟢 GREEN 70K · 13% of 1M · Opus 5$/ })).toBeDefined()
  })
})

describe('the reading in state', () => {
  test('is written when it changed, and only then', async ($, on) => {
    const world = worldOf(on, ORANGE, { store: { 'floor:session-1': 60_000 } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    await clock.advance(1_500)
    await clock.advance(1_500)
    await $.session.measure({ context: ORANGE, rateLimits: [], changed: ['cost'] })
    expect(world.writes).toEqual([{ ...ORANGE, floor: 60_000, model: 'Opus 5' }])

    world.context = { tokens: 210_000, window: 1_000_000 }
    await clock.advance(1_500)
    expect(world.writes).toHaveLength(2)
  })
})

describe('the floor', () => {
  test('is the first reading, and is kept in the store for the next load', async ($, on) => {
    const world = worldOf(on, { tokens: 61_000, window: 200_000 })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    expect(world.store.get('floor:session-1')).toBe(61_000)

    world.context = { tokens: 181_000, window: 200_000 }
    await clock.advance(1_500)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: /RED 120K/ })).toBeDefined()
  })

  test('is not seeded in a session met after its first prompt: no false GREEN', async ($, on) => {
    // Open when the mod arrived, or resumed from before it: 400K deep, floor unknown.
    const world = worldOf(on, { tokens: 400_000, window: 1_000_000 }, { turns: 12, files: { [CLI]: '' } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    await clock.advance(1_500)
    await $.session.measure({ context: { tokens: 410_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] })

    expect(world.store.has('floor:session-1')).toBe(false)
    // A floor this session can never have is asked for once, not on every poll.
    expect(world.turnsAsked).toBe(1)
    // And a sample with a guessed floor would poison the calibration corpus.
    expect(world.runs).toHaveLength(0)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

      expect(await ui.find({ type: 'Text', text: /^⛽ …$/ }), surface).toMatchObject({ props: { dimColor: true } })
      expect(await ui.find({ text: /GREEN|YELLOW|ORANGE|RED|BLACK/ }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  test('seeding one keeps the newest floors in the store and drops the oldest', async ($, on) => {
    const old = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`floor:old-${i}`, 50_000]))
    const world = worldOf(on, { tokens: 61_000, window: 200_000 }, { store: { other: 1, ...old } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    expect([...world.store.keys()].filter(key => key.startsWith('floor:'))).toHaveLength(200)
    expect(world.store.has('floor:old-0')).toBe(false)
    expect(world.store.has('floor:old-1')).toBe(true)
    expect(world.store.get('floor:session-1')).toBe(61_000)
    expect(world.store.get('other')).toBe(1)
  })

  test('a stored floor wins over the first reading this load sees', async ($, on) => {
    worldOf(on, { tokens: 200_000, window: 1_000_000 }, { store: { 'floor:session-1': 60_000 } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: /ORANGE 140K/ })).toBeDefined()
  })
})

describe('calibration samples', () => {
  test('each measurement of the window goes to the installed CLI', async ($, on) => {
    const world = worldOf(on, { tokens: 60_000, window: 1_000_000 }, { files: { [CLI]: '' } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    await $.session.measure({ context: ORANGE, rateLimits: [], changed: ['context'] })

    expect(world.runs).toHaveLength(1)
    expect(world.runs[0]?.argv).toEqual([CLI, '--record-sample'])
    expect(JSON.parse(world.runs[0]?.stdin ?? '{}')).toEqual({
      session_id: 'session-1',
      harness: 'claude',
      working: 140_000,
      total: 200_000,
      floor: 60_000,
      window: 1_000_000,
      model: 'Opus 5',
    })

    await $.session.measure({ context: ORANGE, rateLimits: [], changed: ['cost'] })
    expect(world.runs).toHaveLength(1)
  })

  for (const [what, answer] of [['a CLI from before --record-sample', ''], ['a CLI that answers anything else', 'usage: …\n']] as const) {
    test(`${what} stops the sampler for the load, and says so once`, async ($, on) => {
      const world = worldOf(on, { tokens: 60_000, window: 1_000_000 }, { files: { [CLI]: '' }, answer })
      const clock = mock.clock(on)

      await $.session.start(SESSION)
      await clock.settle()
      await $.session.measure({ context: ORANGE, rateLimits: [], changed: ['context'] })
      await $.session.measure({ context: { tokens: 210_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] })

      expect(world.runs).toHaveLength(1)
      expect(world.logs).toHaveLength(1)
      expect(world.logs[0]).toContain('--record-sample')
    })
  }

  test('an acknowledged sample keeps the sampler running', async ($, on) => {
    const world = worldOf(on, { tokens: 60_000, window: 1_000_000 }, { files: { [CLI]: '' } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    await $.session.measure({ context: ORANGE, rateLimits: [], changed: ['context'] })
    await $.session.measure({ context: { tokens: 210_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] })

    expect(world.runs).toHaveLength(2)
    expect(world.logs).toEqual([])
  })

  test('no CLI, no sample, and the measurement still passes', async ($, on) => {
    const world = worldOf(on, ORANGE)
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    expect(await $.session.measure({ context: ORANGE, rateLimits: [], changed: ['context'] })).toEqual({ changed: ['context'] })
    expect(world.runs).toHaveLength(0)
  })
})
