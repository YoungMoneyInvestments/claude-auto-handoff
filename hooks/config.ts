// Settings from /config and the constants built on them. Engine-free: the host follows $ only
// into functions declared in register.tsx, so anything taking $ stays there.

export const BRIEF_DIR = '.claude/state/auto-handoff'
// The two numbers are userConfig fields (plugin.json), set in /config. Defaults match the manifest.
// threshold: matches HANDOFF_ARM_TOKENS in context-warning.ts.
// MIN_HEADROOM and maxUnattended are loop guards. A seeded session must grow MIN_HEADROOM past its
// first-turn size (its floor) before it can hand off again, and at most maxUnattended handoffs may
// run before the user types a prompt. MIN_HEADROOM is fixed: seeded sessions start near 45k, so at
// the default threshold it never moves the line; it only matters when the threshold is set low.
// 40k is the empirical line where a seeded session can read its brief and still do real work. The
// 2026-10-03 live run (threshold 20k, seeded sessions start at ~31k) chained six times with no
// guard; the 2026-10-04 run (AUTO_HANDOFF_TOKENS=80000 left in a shell, floor ~45k) chained eight
// times with a guard of a quarter of the threshold, because max(80k, 45k + 20k) is still 80k, and
// 35k of room goes in reading the brief. Progress, not time: a 15-minute chain cap could block a
// real session that fills fast.
// The rest shape the brief: two template files and a pattern for files
// that never count as edits.
// viewer: where the mod serves the brief pages, "host:port"; "tailscale" as the host means this
// machine's Tailscale IP, or 127.0.0.1 without Tailscale. Blank: no server, and the link is the local file.
export type Config = { threshold: number; maxUnattended: number; maxChainDepth: number; briefTemplate: string; instructionsTemplate: string; ignoreFiles?: RegExp; viewer: string }
export const DEFAULTS: Config = { threshold: 250_000, maxUnattended: 2, maxChainDepth: 3, briefTemplate: '~/.claude/auto-handoff/brief.md', instructionsTemplate: '~/.claude/auto-handoff/instructions.md', viewer: 'tailscale:3846' }
export const MIN_HEADROOM = 40_000

// Per-model handoff lines. One number for every model was wrong in both directions: 250k is
// 25% of a flat-priced 1M Claude window (needlessly early for Opus and Fable) while Haiku 5.5
// already charges 5x for any prompt over 100k (250k is 2.5x too late). Matched by family so a
// new point release inherits its family's line; an unknown model keeps the /config threshold.
const MODEL_THRESHOLDS: readonly (readonly [RegExp, number, string])[] = [
  // Haiku 5.5: 5x input, output and cache above 100k per request, so hand off before the tier.
  [/haiku/, 95_000, 'Haiku'],
  // Sonnet 5.5: flat-priced 1M window; 400k is 40% of it.
  [/sonnet/, 400_000, 'Sonnet'],
  // Opus 5.5: 1M window at standard pricing; 600k is 60% of it.
  [/opus/, 600_000, 'Opus'],
  // Fable 5.1: built for long-horizon agentic work, 1M flat, cache reads at 2.5%.
  [/fable/, 750_000, 'Fable'],
  // GPT-6 Astra / 6.1 Sol: above 272k the whole request bills at 2x input and cache.
  [/astra|gpt-6/, 260_000, 'GPT-6 (2x tier above 272k)'],
]

/** The handoff line for a model id, or the configured threshold when the model is unknown. */
export function modelThreshold(model: string | undefined, fallback: number): { base: number; source: string } {
  const id = String(model ?? '').toLowerCase()
  for (const [pattern, base, family] of MODEL_THRESHOLDS) {
    if (pattern.test(id)) return { base, source: `${family} model rule` }
  }
  return { base: fallback, source: 'threshold in /config' }
}
// Each template's default, a file in the mod's templates/ folder.
export const TEMPLATES = [['briefTemplate', 'brief.md'], ['instructionsTemplate', 'instructions.md']] as const
export type TemplateKey = typeof TEMPLATES[number][0]
// Used only when the shipped default is unreadable too, so the fresh session still knows what to do.
export const LAST_RESORT_INSTRUCTIONS = '## Instructions\n\nThis turn was triggered by the system, not by a user. Read this brief and continue the work it describes.'

export const k = (n: number) => `${Math.round(n / 1000)}k`
export const short = (sessionId: string) => sessionId.slice(0, 8)
export const expand = (path: string, home: string) => path.replace(/^~(?=\/|$)/, home)

// A non-positive or non-numeric value falls back to the default rather than handing off at 0.
const num = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
const str = (v: unknown, fallback: string) => typeof v === 'string' && v.trim() ? v.trim() : fallback
// A bad pattern is dropped, not fatal: a typo in /config should not stop handoffs.
function pattern(v: unknown): RegExp | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  try { return new RegExp(v) } catch { return undefined }
}

/** The /config values, each checked, with the manifest's defaults for anything missing or bad. */
export function parseConfig(options: Record<string, unknown>): Config {
  return {
  threshold: num(options.threshold, DEFAULTS.threshold),
  maxUnattended: num(options.maxConsecutiveHandoffs, DEFAULTS.maxUnattended),
  maxChainDepth: num(options.maxChainDepth, DEFAULTS.maxChainDepth),
  briefTemplate: str(options.briefTemplate, DEFAULTS.briefTemplate),
  instructionsTemplate: str(options.instructionsTemplate, DEFAULTS.instructionsTemplate),
  ignoreFiles: pattern(options.ignoreFiles),
  viewer: typeof options.viewer === 'string' ? options.viewer.trim() : DEFAULTS.viewer,
  }
}

// The seed prompt's first characters; the render hook knows the seed row by them.
export const SEED_PREFIX = '[auto-handoff] ↪ Handoff from session'
// The seed text with its brief path and viewer URL as markdown links. The path becomes a
// file: link labelled by its file name; the URL links to itself. Exported for the test.
export function linkify(text: string): string {
  return text
    .replace(/(?<=\bat )(\/\S+\.md)(?=[\s)]|$)/, (p) => `[${p.slice(p.lastIndexOf('/') + 1)}](file://${p})`)
    .replace(/(https?:\/\/[^\s)]+)/, (u) => `[${u}](${u})`)
}
