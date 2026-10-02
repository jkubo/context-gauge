// The state contract of the context-gauge mod: every value it keeps in `$.state`.

/**
 * One measurement of the live context window, as the band draws it.
 *
 * `tokens` is absent until the live window's first response (a fresh session,
 * or one just compacted), and so is `floor` until the session's first response,
 * and for good in a session the mod first met after it.
 */
export type GaugeReading = {
  /** Input tokens the last response was answered over: the window's fill. */
  tokens?: number
  /** The context window of the session's model, in tokens. */
  window: number
  /** The fill of the session's first response; the working set is measured from it. */
  floor?: number
  /** The session's model, as the engine names it, made safe to draw. */
  model?: string
}

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': {
      /** The last measurement; null until the first one. */
      reading: GaugeReading | null
    }
  }
}
