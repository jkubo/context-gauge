import type { On, RenderPropsOf, SessionCompactTrigger, SessionContextUsage, SessionMessage } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

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
  /** The transcript: what `$.session.messages()` answers. */
  messages: SessionMessage[]
  /** What the CLI prints to `--record-sample`. */
  answer: string
  runs: { argv: readonly string[]; stdin: string | undefined }[]
  /** Every value the plugin wrote to its reading, in order. */
  writes: unknown[]
  logs: string[]
  turnsAsked: number
  /** What the engine's compaction does when asked: replaces the transcript, or is vetoed. */
  compaction: 'replaces' | 'vetoed'
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
    messages = [],
    answer = 'ok\n',
  }: {
    env?: Record<string, string>
    files?: Record<string, string>
    store?: Record<string, unknown>
    model?: string | null
    turns?: number
    messages?: SessionMessage[]
    answer?: string
  } = {},
): World {
  const world: World = {
    context,
    files: new Map(Object.entries(files)),
    store: new Map(Object.entries(store)),
    turns,
    messages,
    answer,
    runs: [],
    writes: [],
    logs: [],
    turnsAsked: 0,
    compaction: 'replaces',
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
  on('session.messages', () => ({ value: world.messages }))
  on('session.compact', () => (world.compaction === 'vetoed' ? { skip: 'off' } : { messages: [said('user', SUMMARY)] }))
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

// What the store holds for a session that can never have a floor: a floor is above 0.
const NO_FLOOR = 0

const SUMMARY = 'This session is being continued from a previous conversation that ran out of context.'

type Node = { type: string; props?: Record<string, unknown>; children?: (Node | string)[] }

const flat = (node: Node | string): string => (typeof node === 'string' ? node : (node.children ?? []).map(flat).join(''))

/** The fuel row's runs, as drawn: a bare string is the surface's own colour, a Text its props. */
function runsOf(drawn: unknown): (string | { text: string; props: Record<string, unknown> | undefined })[] {
  // The fuel row is the band's last child: the chain beneath draws above it.
  const row = (drawn as Node).children?.at(-1)

  return (row && typeof row !== 'string' ? (row.children ?? []) : []).map(run =>
    typeof run === 'string' ? run : { text: flat(run), props: run.props },
  )
}

const said = (role: SessionMessage['role'], text: string): SessionMessage => ({ role, text, toolUses: [] })
// A local command's two rows, as the engine keeps them: user rows, counted as turns.
const EFFORT = [said('user', '<command-name>/effort</command-name>'), said('user', '<local-command-stdout>Effort: high</local-command-stdout>')]
// A `!` bash command's two rows, the same way.
const BASH = [said('user', '<bash-input>ls</bash-input>'), said('user', '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>')]

describe('the band above the prompt', () => {
  test('draws the fuel row under what the chain beneath drew, on every surface it is raised on', async ($, on) => {
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
      expect(JSON.stringify(drawn).indexOf('ORANGE'), surface).toBeGreaterThan(JSON.stringify(drawn).indexOf('another mod'))
      expect(await ui.find({ type: 'Text', text: /^⛽ 🟠 ORANGE 140K$/ }), surface).toMatchObject({ props: { color: '#ff8700' } })
      await ui.unmount()
    }
  })

  // The statusLine's _ANSI, as Text props: 32, 33, 38;5;208, 1;31, 1;97;41.
  const TONE = {
    GREEN: { color: 'green' },
    YELLOW: { color: 'yellow' },
    ORANGE: { color: '#ff8700' },
    RED: { color: 'red', bold: true },
    BLACK: { color: 'whiteBright', backgroundColor: 'red', bold: true },
  } as const
  const DIM = { dimColor: true }
  // Fill 60K seeds the floor; each case is a later fill, its working set, and what the row says.
  const BANDS_DRAWN = [
    { name: 'GREEN', tokens: 70_000, head: '⛽ 🟢 GREEN 10K', share: '7% of 1M', flag: '' },
    { name: 'YELLOW', tokens: 130_000, head: '⛽ 🟡 YELLOW 70K', share: '13% of 1M', flag: '' },
    { name: 'ORANGE', tokens: 200_000, head: '⛽ 🟠 ORANGE 140K', share: '20% of 1M', flag: '⚑ checkpoint' },
    { name: 'RED', tokens: 260_000, head: '⛽ 🔴 RED 200K', share: '26% of 1M', flag: '⚑ handoff soon' },
    { name: 'BLACK', tokens: 400_000, head: '⛽ ⚫ BLACK 340K', share: '40% of 1M', flag: '⚑ HANDOFF NOW' },
  ] as const

  test('every band is drawn in its statusLine colour, run by run, on both surfaces', async ($, on) => {
    // A colour a surface refuses fails the whole tree, and the engine then draws its
    // own: nothing, here, so the other mods' rows in this band would vanish with ours.
    // Every run is pinned, not the lead one: the window share, the flag, the dim dots.
    const world = worldOf(on, { tokens: 60_000, window: 1_000_000 })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    for (const { name, tokens, head, share, flag } of BANDS_DRAWN) {
      world.context = { tokens, window: 1_000_000 }
      await clock.advance(1_500)

      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

        expect(runsOf(await ui.drawn()), `${surface} ${name}`).toEqual([
          { text: head, props: TONE[name] },
          ' ',
          { text: '·', props: DIM },
          ' ',
          { text: share, props: TONE[name] },
          ...(flag ? [' ', { text: flag, props: TONE[name] }] : []),
          ' ',
          { text: '·', props: DIM },
          ' ',
          'Opus 5',
        ])
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

  test('is cut to the body width, never wrapped onto a second row, by a row that truncates under a Box with no width of its own', async ($, on) => {
    worldOf(on, ORANGE, { store: { 'floor:session-1': 60_000 } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 30 } })
      const row = await ui.find({ type: 'Text', text: /^⛽ 🟠 ORANGE 140K · 20% of 1M ⚑ checkpoint · Opus 5$/ })

      // The engine refuses a tree that puts its own node (what next() returned) under a Box with a
      // `width` prop ("does not validate ... drawing the engine's own"), and then no mod's band is drawn.
      // The Box takes the band's width from its parent; the row truncates inside it.
      const drawn = await ui.drawn()

      expect(drawn, surface).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
      expect(drawn?.props, surface).not.toHaveProperty('width')
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

  for (const [what, rows] of [
    ['/effort', EFFORT],
    ['a `!` bash command', BASH],
    ['/effort and a `!` bash command, each twice', [...EFFORT, ...BASH, ...EFFORT, ...BASH]],
  ] as const) {
    test(`is seeded at the first reply when ${what} opened the session`, async ($, on) => {
      // Local commands before the prompt: the engine counts every user row as a turn at the first response.
      const world = worldOf(on, { window: 200_000 }, { turns: rows.length + 1, messages: [...rows, said('user', 'hi')] })
      const clock = mock.clock(on)

      await $.session.start(SESSION)
      await clock.settle()
      world.messages = [...world.messages, said('assistant', 'hello')]
      world.context = { tokens: 61_000, window: 200_000 }
      await clock.advance(1_500)
      expect(world.store.get('floor:session-1')).toBe(61_000)

      world.context = { tokens: 181_000, window: 200_000 }
      await clock.advance(1_500)

      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

        expect(await ui.find({ type: 'Text', text: /^⛽ 🔴 RED 120K$/ }), surface).toBeDefined()
        await ui.unmount()
      }
    })
  }

  test('is not seeded in a session met after its first prompt, and its row says so rather than going dark', async ($, on) => {
    // Open when the mod arrived, or resumed from before it: 400K deep, floor unknown.
    const messages = Array.from({ length: 12 }, (_, i) => [said('user', `prompt ${i}`), said('assistant', `reply ${i}`)]).flat()
    const world = worldOf(on, { tokens: 400_000, window: 1_000_000 }, { turns: 12, messages, files: { [CLI]: '' } })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()
    await clock.advance(1_500)
    await $.session.measure({ context: { tokens: 410_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] })

    expect(world.store.get('floor:session-1')).toBe(NO_FLOOR)
    // A floor this session can never have is asked for once, not on every poll.
    expect(world.turnsAsked).toBe(1)
    // And a sample with a guessed floor would poison the calibration corpus.
    expect(world.runs).toHaveLength(0)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

      // The fill and its window share are measured, so they are drawn; the working set is not,
      // so no band is named (41% is GREEN on the ratio axis, which would be a false GREEN).
      expect((await ui.find({ type: 'Text', text: /floor\?/ }))?.text, surface).toBe('⛽ 410K of 1M · 41% · floor? · Opus 5')
      expect(await ui.find({ text: /GREEN|YELLOW|ORANGE|RED|BLACK/ }), surface).toBeUndefined()
      expect(runsOf(await ui.drawn()), surface).toEqual([
        '⛽ 410K of 1M', ' ', { text: '·', props: { dimColor: true } }, ' ', '41%', ' ', { text: '·', props: { dimColor: true } }, ' ',
        { text: 'floor?', props: { dimColor: true } }, ' ', { text: '·', props: { dimColor: true } }, ' ', 'Opus 5',
      ])
      await ui.unmount()
    }
  })

  test('a deep session with no floor still gets the window-ratio band, as a lower bound', async ($, on) => {
    const messages = Array.from({ length: 12 }, (_, i) => [said('user', `prompt ${i}`), said('assistant', `reply ${i}`)]).flat()
    const world = worldOf(on, { tokens: 720_000, window: 1_000_000 }, { turns: 12, messages })
    const clock = mock.clock(on)

    await $.session.start(SESSION)
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      const orange = { color: '#ff8700' }

      expect(runsOf(await ui.drawn()), surface).toEqual([
        { text: '⛽ 🟠 ORANGE 720K of 1M', props: orange }, ' ', { text: '·', props: { dimColor: true } }, ' ',
        { text: '72%', props: orange }, ' ', { text: '·', props: { dimColor: true } }, ' ',
        { text: 'floor?', props: { dimColor: true } }, ' ', { text: '⚑ compaction near', props: orange }, ' ',
        { text: '·', props: { dimColor: true } }, ' ', 'Opus 5',
      ])
      await ui.unmount()
    }

    expect(world.store.get('floor:session-1')).toBe(NO_FLOOR)
  })

  for (const [what, first] of [
    ['an interrupted first reply (written with zero usage)', '[Request interrupted by user]'],
    ['a first reply that was an API error row', 'API Error: 529 overloaded'],
  ] as const) {
    test(`is not seeded when ${what} came before the real one, and its row says so`, async ($, on) => {
      // A zero-usage row is a stub, so the fill is first seen at the SECOND reply: two replies by then.
      const world = worldOf(on, { tokens: 0, window: 200_000 }, { turns: 1, messages: [said('user', 'hi'), said('assistant', first)], files: { [CLI]: '' } })
      const clock = mock.clock(on)

      await $.session.start(SESSION)
      await clock.settle()

      const early = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

      expect((await early.find({ type: 'Text', text: /^⛽ …/ }))?.text).toBe('⛽ … · Opus 5')
      await early.unmount()

      world.turns = 2
      world.messages = [...world.messages, said('user', 'again'), said('assistant', 'hello')]
      world.context = { tokens: 60_000, window: 200_000 }
      await clock.advance(1_500)
      await $.session.measure({ context: world.context, rateLimits: [], changed: ['context'] })

      expect(world.store.get('floor:session-1')).toBe(NO_FLOOR)
      expect(world.runs).toHaveLength(0)

      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

        expect((await ui.find({ type: 'Text', text: /floor\?/ }))?.text, surface).toBe('⛽ 60K of 200K · 30% · floor? · Opus 5')
        expect(await ui.find({ text: /GREEN|YELLOW|ORANGE|RED|BLACK/ }), surface).toBeUndefined()
        await ui.unmount()
      }
    })
  }

  describe('across a compaction', () => {
    // A resumed session has no live fill until its first response, and 5 replies behind it.
    const DEEP = Array.from({ length: 5 }, (_, i) => [said('user', `prompt ${i}`), said('assistant', `reply ${i}`)]).flat()

    type Compaction = { trigger: SessionCompactTrigger; agentId?: string; isVetoed?: boolean }

    /** What the store held the moment the compaction was done, before any reply. */
    let compactedStore: unknown

    /** The resumed session compacts as given, then answers once: the first live fill it has. */
    async function resumeAndAnswer($: Engine, on: On, compaction?: Compaction) {
      compactedStore = undefined
      const world = worldOf(on, { window: 200_000 }, { turns: 5, messages: DEEP, files: { [CLI]: '' } })
      const clock = mock.clock(on)

      world.compaction = compaction?.isVetoed ? 'vetoed' : 'replaces'
      await $.session.start(SESSION)
      await clock.settle()

      if (compaction) {
        await $.session.compact({ trigger: compaction.trigger, ...(compaction.agentId && { agentId: compaction.agentId }), messages: DEEP })
        compactedStore = world.store.get('floor:session-1')
      }

      // After a compaction the transcript is the summary and what came since.
      world.messages = [said('user', SUMMARY), said('user', 'next'), said('assistant', 'ok')]
      world.turns = 2
      world.context = { tokens: 50_000, window: 200_000 }
      await clock.advance(1_500)

      return world
    }

    test('control: the same first reply with no compaction before it IS the floor', async ($, on) => {
      const world = await resumeAndAnswer($, on)

      expect(world.store.get('floor:session-1')).toBe(50_000)
    })

    for (const trigger of ['manual', 'auto', 'plugin'] as const) {
      test(`a compaction (${trigger}) before any floor was seeded: the fill after it is not the floor`, async ($, on) => {
        const world = await resumeAndAnswer($, on, { trigger })

        // Decided at the compaction, so a reload before the first reply cannot undo it.
        expect(compactedStore).toBe(NO_FLOOR)
        expect(world.store.get('floor:session-1')).toBe(NO_FLOOR)
        expect(world.runs).toHaveLength(0)

        for (const surface of SURFACES) {
          const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

          // The fill is still drawn, as the window share; the summary's size is not a working set.
          expect((await ui.find({ type: 'Text', text: /floor\?/ }))?.text, surface).toBe('⛽ 50K of 200K · 25% · floor? · Opus 5')
          await ui.unmount()
        }
      })
    }

    for (const [what, compaction] of [
      ['one a hook vetoed changed nothing', { trigger: 'manual', isVetoed: true }],
      ['a precompute installs nothing', { trigger: 'precompute' }],
      ['a subagent compacts its own transcript, not this one', { trigger: 'auto', agentId: 'agent-1' }],
    ] as const satisfies readonly (readonly [string, Compaction])[]) {
      test(`${what}, so it does not count`, async ($, on) => {
        const world = await resumeAndAnswer($, on, compaction)

        expect(world.store.get('floor:session-1')).toBe(50_000)
      })
    }

    test('a refusal outlives a reload: the transcript no longer shows a deep session', async ($, on) => {
      // The store says this session can have no floor; its transcript, compacted, says one reply.
      const world = worldOf(on, { tokens: 50_000, window: 200_000 }, {
        turns: 2,
        messages: [said('user', SUMMARY), said('user', 'next'), said('assistant', 'ok')],
        store: { 'floor:session-1': NO_FLOOR },
      })
      const clock = mock.clock(on)

      await $.session.start(SESSION)
      await clock.settle()

      expect(world.store.get('floor:session-1')).toBe(NO_FLOOR)
      expect(world.turnsAsked).toBe(0)

      const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

      expect((await ui.find({ type: 'Text', text: /floor\?/ }))?.text).toBe('⛽ 50K of 200K · 25% · floor? · Opus 5')
    })

    test('seeded before one, the floor stands: the policy is never to reset it', async ($, on) => {
      const world = worldOf(on, { tokens: 61_000, window: 200_000 })
      const clock = mock.clock(on)

      await $.session.start(SESSION)
      await clock.settle()
      await $.session.compact({ trigger: 'manual', messages: DEEP })
      world.context = { tokens: 30_000, window: 200_000 }
      await clock.advance(1_500)

      expect(world.store.get('floor:session-1')).toBe(61_000)

      const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })

      expect((await ui.find({ type: 'Text', text: /GREEN/ }))?.text).toBe('⛽ 🟢 GREEN 0K · 15% of 200K · Opus 5')
    })
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
